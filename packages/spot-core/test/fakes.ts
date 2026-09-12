import { Keypair, PublicKey } from '@solana/web3.js';

import type {
  BuildSwapParams,
  JupQuote,
  JupiterClient,
  QuoteParams,
} from '../src/route/jupiter';
import type { MintInfoReader } from '../src/balance/decimals';
import { RouteError } from '../src/errors';
import { buildSwapTx } from './tx-builder';

/**
 * Fakes for the transport seams.
 *
 * v1's `sunrise-swap.dryrun.spec.ts` shipped its own fakes and §4 called that
 * file "the regression net". It has since been recovered on
 * `recover/sunrise-sell-side`; these cover the v2 seams, which differ because
 * the engine no longer signs or broadcasts.
 */

export class FakeJupiter implements JupiterClient {
  readonly quoteCalls: QuoteParams[] = [];
  readonly buildCalls: BuildSwapParams[] = [];

  constructor(
    private readonly opts: {
      quote?: JupQuote;
      /** Overrides the generated transaction, for verification failure cases. */
      transaction?: string;
      failQuote?: RouteError;
      failBuild?: RouteError;
      onQuote?: () => void;
    } = {},
  ) {}

  async quote(p: QuoteParams): Promise<JupQuote> {
    this.quoteCalls.push(p);
    this.opts.onQuote?.();
    if (this.opts.failQuote) throw this.opts.failQuote;
    return (
      this.opts.quote ?? {
        outAmount: '1000000000',
        priceImpactPct: '0.000435',
        routePlan: [
          { swapInfo: { label: 'Orca' } },
          { swapInfo: {} },
          { swapInfo: { label: 'Meteora' } },
        ],
        // Jupiter reports what it took when the quote asked for a fee, and
        // the engine repeats that rather than recomputing it. A fake that
        // stayed silent here would let a wrong `feeRaw` pass.
        ...(p.platformFeeBps && p.platformFeeBps > 0
          ? {
              platformFee: {
                amount: String((BigInt(p.amount) * BigInt(p.platformFeeBps)) / 10_000n),
                feeBps: p.platformFeeBps,
              },
            }
          : {}),
      }
    );
  }

  async buildSwap(p: BuildSwapParams): Promise<string> {
    this.buildCalls.push(p);
    if (this.opts.failBuild) throw this.opts.failBuild;
    if (this.opts.transaction !== undefined) return this.opts.transaction;

    // Build a transaction that actually survives verification, using the mints
    // from the quote the engine just requested. A fake that returned an opaque
    // string would let the engine's verification step pass untested.
    const last = this.quoteCalls[this.quoteCalls.length - 1];
    return buildSwapTx({
      owner: new PublicKey(p.userPublicKey),
      inputMint: last?.inputMint ?? '',
      outputMint: last?.outputMint ?? '',
      // Jupiter puts the fee account into the transaction it returns. A
      // fake that left it out would make the verification step's fee check
      // unfalsifiable — it would only ever see transactions without one.
      ...(p.feeAccount ? { feeAccount: new PublicKey(p.feeAccount) } : {}),
    });
  }
}

export class FakeMintReader implements MintInfoReader {
  calls = 0;

  /** No default: an explicit `undefined` must mean "decimals unavailable",
   *  which a default parameter would silently swallow. */
  constructor(private readonly decimals: number | undefined) {}

  async decimalsOf(): Promise<number | undefined> {
    this.calls += 1;
    return this.decimals;
  }
}

/**
 * A signer backed by a real keypair, because the engine now builds and verifies
 * a genuine transaction against its public key.
 *
 * Counts `publicKey()` calls as well as sign attempts: in the extension that
 * call is what can raise a Phantom connect prompt, so "was it called at all"
 * is a consent question, not just a bookkeeping one.
 */
export class SpySigner {
  signAttempts = 0;
  pubkeyCalls = 0;
  readonly keypair: Keypair;

  constructor(keypair?: Keypair) {
    this.keypair = keypair ?? Keypair.generate();
  }

  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  async publicKey(): Promise<string> {
    this.pubkeyCalls += 1;
    return this.address;
  }

  async signTransaction(): Promise<string> {
    this.signAttempts += 1;
    throw new Error('engine must never sign');
  }
}

/** Deterministic clock for the staleness gate. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}
