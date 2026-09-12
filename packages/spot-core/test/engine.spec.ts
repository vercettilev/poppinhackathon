import { describe, expect, it } from 'vitest';
import { VersionedTransaction } from '@solana/web3.js';
import { RouteEngine, QUOTE_MAX_AGE_MS } from '../src/route/engine';
import { DecimalsCache } from '../src/balance/decimals';
import { AllowlistPolicy } from '../src/route/policy';
import { RouteError } from '../src/errors';
import { HttpJupiterClient, USDC_MINT } from '../src/route/jupiter';
import { FakeJupiter, FakeMintReader, SpySigner, fakeClock } from './fakes';


const MINT = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
const OTHER = 'So11111111111111111111111111111111111111112';

function makeEngine(
  opts: {
    jupiter?: FakeJupiter;
    reader?: FakeMintReader;
    fee?: { bps: number; wallet?: string };
    clock?: ReturnType<typeof fakeClock>;
  } = {},
) {
  const jupiter = opts.jupiter ?? new FakeJupiter();
  const reader = opts.reader ?? new FakeMintReader(9);
  const clock = opts.clock ?? fakeClock();
  const engine = new RouteEngine({
    jupiter,
    decimals: new DecimalsCache(reader),
    policy: new AllowlistPolicy([MINT]),
    ...(opts.fee ? { fee: opts.fee } : {}),
    now: clock.now,
  });
  return { engine, jupiter, reader, clock };
}

/** The product's real fee account. A valid base58 pubkey matters: the
 *  fake now writes it into the transaction exactly as Jupiter does, so a
 *  placeholder string fails at PublicKey rather than at the assertion. */
const FEE_ATA = '7SrjZNT6UCmBUEyFcUrGSafaDLWJc3xaPKdv8ghmt13A';

describe('RouteEngine.quote', () => {
  it('shapes a quote from the Jupiter response', async () => {
    const { engine } = makeEngine();
    const r = await engine.quote(MINT, 100);

    expect(r.mint).toBe(MINT);
    expect(r.amountUsd).toBe(100);
    expect(r.outAmount).toBe(1); // 1e9 raw at 9 decimals
    expect(r.pricePerUnit).toBe(100);
    expect(r.outAmountRaw).toBe('1000000000');
  });

  it('scales priceImpactPct to percent and drops non-finite values', async () => {
    const { engine } = makeEngine({
      jupiter: new FakeJupiter({
        quote: { outAmount: '1000000000', priceImpactPct: '0.000435' },
      }),
    });
    expect((await engine.quote(MINT, 100)).priceImpactPct).toBeCloseTo(0.0435);

    const { engine: e2 } = makeEngine({
      jupiter: new FakeJupiter({
        quote: { outAmount: '1000000000', priceImpactPct: 'not-a-number' },
      }),
    });
    expect((await e2.quote(MINT, 100)).priceImpactPct).toBe(0);
  });

  it('keeps only labelled route hops', async () => {
    const { engine } = makeEngine();
    expect((await engine.quote(MINT, 100)).route).toEqual(['Orca', 'Meteora']);
  });

  it('quotes against USDC as the input mint', async () => {
    const { engine, jupiter } = makeEngine();
    await engine.quote(MINT, 100);
    expect(jupiter.quoteCalls[0]?.inputMint).toBe(USDC_MINT);
  });

  it('quotes the GROSS amount when fees are off', async () => {
    const { engine, jupiter } = makeEngine();
    await engine.quote(MINT, 100);
    expect(jupiter.quoteCalls[0]?.amount).toBe('100000000');
  });

  it('quotes the GROSS amount and asks Jupiter for the fee', async () => {
    // This used to assert the opposite: the engine cut 1% off the input and
    // routed 99. That collected nothing — the withheld dollar simply stayed
    // in the reader's account — and the build would have been refused
    // anyway, because verification expects the fee account to appear in the
    // transaction and nothing ever put it there. Jupiter takes the fee, so
    // the full amount is quoted and `platformFeeBps` rides along.
    const { engine, jupiter } = makeEngine({
      fee: { bps: 100, tokenAccount: FEE_ATA },
    });
    await engine.quote(MINT, 100);
    expect(jupiter.quoteCalls[0]?.amount).toBe('100000000');
    expect(jupiter.quoteCalls[0]?.platformFeeBps).toBe(100);
  });

  it('asks for no platform fee when fees are off', async () => {
    const { engine, jupiter } = makeEngine();
    await engine.quote(MINT, 100);
    expect(jupiter.quoteCalls[0]?.platformFeeBps).toBeUndefined();
  });

  it('rejects a non-positive amount', async () => {
    const { engine } = makeEngine();
    await expect(engine.quote(MINT, 0)).rejects.toThrow(RouteError);
    await expect(engine.quote(MINT, -1)).rejects.toThrow(/must be > 0/);
  });

  it('refuses a mint outside the allowlist before any network call', async () => {
    const { engine, jupiter } = makeEngine();
    await expect(engine.quote(OTHER, 100)).rejects.toThrow(/not tradeable/);
    expect(jupiter.quoteCalls).toHaveLength(0);
  });

  it('surfaces a missing route as RouteError(no_route)', async () => {
    const { engine } = makeEngine({
      jupiter: new FakeJupiter({
        failQuote: new RouteError('no_route', 'No route for this asset right now'),
      }),
    });
    await expect(engine.quote(MINT, 100)).rejects.toMatchObject({
      failure: 'no_route',
    });
  });

  it('fails loudly when decimals cannot be read', async () => {
    const { engine } = makeEngine({ reader: new FakeMintReader(undefined) });
    await expect(engine.quote(MINT, 100)).rejects.toMatchObject({
      failure: 'decimals_unavailable',
    });
  });
});

describe('DecimalsCache', () => {
  it('reads a mint once and serves the rest from cache', async () => {
    const { engine, reader } = makeEngine();
    await engine.quote(MINT, 100);
    await engine.quote(MINT, 250);
    await engine.quote(MINT, 5);
    expect(reader.calls).toBe(1);
  });
});

/* The 'paying in SOL, in two phases' suite lived here and retired with
 * the SOL pocket: a buy spends USDC, and buying SOL as an asset goes
 * through buildUnsignedSwap like everything else. What survives it is
 * below — the router must still never wrap, because the wSOL account a
 * SOL purchase credits has to outlive the transaction to be measured. */

describe('the router is never asked to wrap or unwrap', () => {
  /**
   * The one line this whole change rests on, asserted against the REAL
   * client rather than a fake — the flag lives in the request body, so a
   * fake that only records its parameters could never see it change back.
   *
   * With wrapping on, Jupiter creates a temporary wrapped-SOL account,
   * moves the money through it and CLOSES it inside the swap. The verifier
   * measures quantities by diffing token accounts, so on every SOL leg it
   * diffed an account the transaction had destroyed: zero before, zero
   * after, and a real purchase of SOL refused as crediting nothing.
   */
  it('sends wrapAndUnwrapSol: false in the swap request', async () => {
    let body: Record<string, unknown> | null = null;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ swapTransaction: 'AA==' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = new HttpJupiterClient(fetchFn, 'https://example.test');
    await client.buildSwap({
      quoteResponse: { outAmount: '1' } as never,
      userPublicKey: '11111111111111111111111111111111',
    });

    expect(body).not.toBeNull();
    expect(body!.wrapAndUnwrapSol).toBe(false);
  });
});

describe('RouteEngine.buildUnsignedSwap', () => {
  it('returns a genuinely unsigned transaction and never invokes the signer', async () => {
    const { engine } = makeEngine();
    const signer = new SpySigner();
    const r = await engine.buildUnsignedSwap(MINT, 100, signer);

    const tx = VersionedTransaction.deserialize(
      Uint8Array.from(Buffer.from(r.transaction, 'base64')),
    );
    expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    expect(signer.signAttempts).toBe(0);
  });

  it('builds for the signer’s public key', async () => {
    const { engine, jupiter } = makeEngine();
    const signer = new SpySigner();
    await engine.buildUnsignedSwap(MINT, 100, signer);
    expect(jupiter.buildCalls[0]?.userPublicKey).toBe(signer.address);
  });

  it('hands /swap the exact object /quote returned, not a rebuilt one', async () => {
    const quote = { outAmount: '777', priceImpactPct: 0, routePlan: [] };
    const { engine, jupiter } = makeEngine({
      jupiter: new FakeJupiter({ quote }),
    });
    await engine.buildUnsignedSwap(MINT, 100, new SpySigner());
    expect(jupiter.buildCalls[0]?.quoteResponse).toBe(quote);
  });

  it('reports the fee as 0 when fees are off (§8)', async () => {
    const { engine } = makeEngine();
    const r = await engine.buildUnsignedSwap(MINT, 100, new SpySigner());
    expect(r.feeRaw).toBe('0');
    expect(r.netInRaw).toBe('100000000');
  });

  it('reports the fee in USDC, not in the output mint', async () => {
    // Measured live 2026-08-26 on a $25 USDC→WIF buy at 100 bps: the
    // quote's platformFee.amount came back 1237158, which is 1.237 WIF,
    // because a quote is priced before Jupiter knows which side's account
    // takes the cut. Read as USDC that is $1.24 against $0.25 actually
    // taken, and the referral ledger accrues 20% of whatever this says.
    // The fee account is USDC, so the cut is bps of the USDC input.
    const { engine } = makeEngine({
      fee: { bps: 100, tokenAccount: FEE_ATA },
      jupiter: new FakeJupiter({
        quote: {
          outAmount: '122478672',
          // The trap, verbatim: output-mint units, five times the truth.
          platformFee: { amount: '1237158', feeBps: 100 },
        },
      }),
    });
    const r = await engine.buildUnsignedSwap(MINT, 25, new SpySigner());
    expect(r.feeRaw).toBe('250000'); // 1% of 25 USDC, 6-dec
  });

  it('routes the whole amount and reports the fee Jupiter took', async () => {
    // The reader's 100 goes in whole; Jupiter deducts 1% and hands back a
    // quote already net of it. `feeRaw` is what Jupiter SAYS it took, not
    // what we predicted — the two agree, but only one is the fact.
    const { engine, jupiter } = makeEngine({
      fee: { bps: 100, tokenAccount: FEE_ATA },
    });
    const r = await engine.buildUnsignedSwap(MINT, 100, new SpySigner());
    expect(r.netInRaw).toBe('100000000');
    expect(r.feeRaw).toBe('1000000');
    // And the build must carry the account the fee lands in, or Jupiter
    // has nowhere to put it and verification refuses the transaction.
    expect(jupiter.buildCalls[0]?.feeAccount).toBe(FEE_ATA);
  });

  it('sends no fee account when fees are off', async () => {
    const { engine, jupiter } = makeEngine();
    const r = await engine.buildUnsignedSwap(MINT, 100, new SpySigner());
    expect(r.feeRaw).toBe('0');
    expect(jupiter.buildCalls[0]?.feeAccount).toBeUndefined();
  });

  it('refuses a stale quote rather than returning a signable transaction', async () => {
    const clock = fakeClock();
    const jupiter = new FakeJupiter({
      onQuote: () => clock.advance(QUOTE_MAX_AGE_MS + 1),
    });
    const { engine } = makeEngine({ jupiter, clock });

    await expect(
      engine.buildUnsignedSwap(MINT, 100, new SpySigner()),
    ).rejects.toMatchObject({ failure: 'quote_stale' });
  });

  it('accepts a quote right at the staleness boundary', async () => {
    const clock = fakeClock();
    const jupiter = new FakeJupiter({
      onQuote: () => clock.advance(QUOTE_MAX_AGE_MS),
    });
    const { engine } = makeEngine({ jupiter, clock });

    await expect(
      engine.buildUnsignedSwap(MINT, 100, new SpySigner()),
    ).resolves.toBeTruthy();
  });

  it('enforces the mint policy before touching the network', async () => {
    const { engine, jupiter } = makeEngine();
    await expect(
      engine.buildUnsignedSwap(OTHER, 100, new SpySigner()),
    ).rejects.toMatchObject({ failure: 'not_allowed' });
    expect(jupiter.quoteCalls).toHaveLength(0);
    expect(jupiter.buildCalls).toHaveLength(0);
  });

  it('surfaces a build failure as RouteError(build_failed)', async () => {
    const { engine } = makeEngine({
      jupiter: new FakeJupiter({
        failBuild: new RouteError('build_failed', 'Swap build failed'),
      }),
    });
    await expect(
      engine.buildUnsignedSwap(MINT, 100, new SpySigner()),
    ).rejects.toMatchObject({ failure: 'build_failed' });
  });
});

/**
 * v1 asserted the allowlist rejected a mint "before touching the wallet". The
 * v2 equivalent is stricter and is a consent property, not a performance one:
 * in the extension, `signer.publicKey()` is what can raise a Phantom connect
 * prompt. Asking a reader to approve wallet access for an asset we are about
 * to refuse leaks a permission request we had no business making.
 *
 * engine.ts orders this correctly today (policy -> amount -> splitFee ->
 * publicKey). Without these tests a reorder stays green.
 */
describe('policy rejection never raises a wallet prompt', () => {
  it('does not call signer.publicKey() for a mint outside the allowlist', async () => {
    const { engine, jupiter } = makeEngine();
    const signer = new SpySigner();

    await expect(
      engine.buildUnsignedSwap(OTHER, 100, signer),
    ).rejects.toMatchObject({ failure: 'not_allowed' });

    expect(signer.pubkeyCalls).toBe(0);
    expect(signer.signAttempts).toBe(0);
    expect(jupiter.quoteCalls).toHaveLength(0);
    expect(jupiter.buildCalls).toHaveLength(0);
  });

  it('refuses USDC passed off as the asset, without a prompt', async () => {
    // The original spec's case: hand the quote currency in as the thing to
    // buy. It is the one mint guaranteed to be routable, so a policy that
    // leaked would leak here first.
    const { engine, jupiter } = makeEngine();
    const signer = new SpySigner();

    await expect(
      engine.buildUnsignedSwap(USDC_MINT, 100, signer),
    ).rejects.toMatchObject({ failure: 'not_allowed' });

    expect(signer.pubkeyCalls).toBe(0);
    expect(jupiter.quoteCalls).toHaveLength(0);
  });

  it('rejects before the amount is even considered', async () => {
    // Both arguments are bad. The policy failure must win, so an attacker
    // cannot use the error type to probe which mints are allowlisted.
    const { engine } = makeEngine();
    const signer = new SpySigner();

    await expect(
      engine.buildUnsignedSwap(OTHER, -5, signer),
    ).rejects.toMatchObject({ failure: 'not_allowed' });
    expect(signer.pubkeyCalls).toBe(0);
  });

  it('holds on the read path too — quote() prompts nothing', async () => {
    const { engine, jupiter } = makeEngine();
    await expect(engine.quote(USDC_MINT, 100)).rejects.toMatchObject({
      failure: 'not_allowed',
    });
    expect(jupiter.quoteCalls).toHaveLength(0);
  });
});

describe('RouteEngine sell leg', () => {
  it('quotes a sell with the mints reversed', async () => {
    const { engine, jupiter } = makeEngine();
    const r = await engine.quoteSell(MINT, '500000000');
    expect(jupiter.quoteCalls[0]).toMatchObject({
      inputMint: MINT,
      outputMint: USDC_MINT,
      amount: '500000000',
    });
    // FakeJupiter answers 1e9 raw; as USDC (6 dec) that is $1000.
    expect(r.outUsd).toBe(1000);
    expect(r.outUsdcRaw).toBe('1000000000');
    expect(r.route).toContain('Orca');
  });

  it('refuses a sell of a mint the policy does not admit', async () => {
    const { engine } = makeEngine();
    await expect(engine.quoteSell(OTHER, '1000')).rejects.toBeInstanceOf(RouteError);
    await expect(
      engine.buildUnsignedSell(OTHER, '1000', new SpySigner()),
    ).rejects.toBeInstanceOf(RouteError);
  });

  it('refuses non-integer and non-positive raw amounts', async () => {
    const { engine } = makeEngine();
    for (const bad of ['0', '-5', '1.5', 'abc', '']) {
      await expect(engine.quoteSell(MINT, bad)).rejects.toMatchObject({
        failure: 'bad_input',
      });
    }
  });

  it('builds an unsigned sell: exact-in tokens, USDC out, zero fee', async () => {
    const { engine, jupiter } = makeEngine();
    const r = await engine.buildUnsignedSell(MINT, '250000000', new SpySigner());
    expect(jupiter.quoteCalls[0]).toMatchObject({
      inputMint: MINT,
      outputMint: USDC_MINT,
      amount: '250000000',
    });
    expect(r.netInRaw).toBe('250000000');
    // No fee on sells — the decision is visible in the data, not implicit.
    expect(r.feeRaw).toBe('0');
    // amountUsd is the quote's USDC out, USD-scaled.
    expect(r.amountUsd).toBe(1000);
    expect(() => VersionedTransaction.deserialize(
      Buffer.from(r.transaction, 'base64'),
    )).not.toThrow();
  });

  it('rejects a sell whose quote went stale before build returned', async () => {
    const { clock } = (() => {
      const clock = fakeClock();
      return { clock };
    })();
    const jupiter = new FakeJupiter({
      onQuote: () => clock.advance(QUOTE_MAX_AGE_MS + 1),
    });
    const { engine } = makeEngine({ jupiter, clock });
    await expect(
      engine.buildUnsignedSell(MINT, '1000', new SpySigner()),
    ).rejects.toMatchObject({ failure: 'quote_stale' });
  });
});
