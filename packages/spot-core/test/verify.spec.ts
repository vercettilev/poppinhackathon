import { describe, expect, it } from 'vitest';
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';

import {
  verifySwapTransaction,
  type BalanceDelta,
  type TransactionSimulator,
} from '../src/route/verify';
import {
  ata,
  buildSwapTx as buildTx,
  JUPITER_V6,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  type BuildTxOpts,
} from './tx-builder';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ASSET = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
const AMOUNT_IN = '100000000';

const user = Keypair.generate();
const attacker = Keypair.generate();

const expected = {
  userPublicKey: user.publicKey.toBase58(),
  inputMint: USDC,
  outputMint: ASSET,
  amountInRaw: AMOUNT_IN,
};

const buildSwapTx = (opts: Partial<BuildTxOpts> = {}): string =>
  buildTx({ owner: user.publicKey, inputMint: USDC, outputMint: ASSET, ...opts });

class FakeSimulator implements TransactionSimulator {
  constructor(private readonly deltas: BalanceDelta[]) {}
  async simulateBalanceDeltas(): Promise<BalanceDelta[]> {
    return this.deltas;
  }
}

const goodDeltas = [
  { mint: USDC, delta: -BigInt(AMOUNT_IN) },
  { mint: ASSET, delta: 42_000_000n },
];

describe('verifySwapTransaction — accepts what we actually asked for', () => {
  it('passes a well-formed unsigned swap', async () => {
    const r = await verifySwapTransaction(buildSwapTx(), expected);
    expect(r.amountVerified).toBe(false);
    expect(r.staticAccountKeys).toContain(user.publicKey.toBase58());
  });

  it('accepts a Token-2022 output account (tokenized equities are Token-2022)', async () => {
    const tx = buildSwapTx({ outputProgram: TOKEN_2022_PROGRAM });
    await expect(verifySwapTransaction(tx, expected)).resolves.toBeTruthy();
  });

  it('accepts the configured fee account when one is expected', async () => {
    const fee = new PublicKey(Keypair.generate().publicKey);
    const tx = buildSwapTx({ feeAccount: fee });
    await expect(
      verifySwapTransaction(tx, { ...expected, feeAccount: fee.toBase58() }),
    ).resolves.toBeTruthy();
  });
});

describe('verifySwapTransaction — one corrupted field at a time', () => {
  it('undeserializable: rejects a blob that is not a transaction', async () => {
    await expect(
      verifySwapTransaction('bm90LWEtdHJhbnNhY3Rpb24=', expected),
    ).rejects.toMatchObject({ failure: 'undeserializable' });
  });

  it('already_signed: rejects a transaction arriving with a signature', async () => {
    const tx = VersionedTransaction.deserialize(
      Uint8Array.from(Buffer.from(buildSwapTx(), 'base64')),
    );
    tx.signatures[0] = new Uint8Array(64).fill(7);
    const tampered = Buffer.from(tx.serialize()).toString('base64');

    await expect(
      verifySwapTransaction(tampered, expected),
    ).rejects.toMatchObject({ failure: 'already_signed' });
  });

  it('unexpected_signers: rejects a transaction needing a second signature', async () => {
    const extra = new TransactionInstruction({
      programId: JUPITER_V6,
      keys: [{ pubkey: attacker.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from([1]),
    });
    await expect(
      verifySwapTransaction(buildSwapTx({ extra: [extra] }), expected),
    ).rejects.toMatchObject({ failure: 'unexpected_signers' });
  });

  it('signer_mismatch: rejects a transaction built for another wallet', async () => {
    const tx = buildSwapTx({ payer: attacker.publicKey });
    await expect(verifySwapTransaction(tx, expected)).rejects.toMatchObject({
      failure: 'signer_mismatch',
    });
  });

  it('unknown_program: rejects an injected third-party program', async () => {
    const extra = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [],
      data: Buffer.from([0]),
    });
    await expect(
      verifySwapTransaction(buildSwapTx({ extra: [extra] }), expected),
    ).rejects.toMatchObject({ failure: 'unknown_program' });
  });

  it('foreign_transfer: rejects a top-level SPL transfer to an outside account', async () => {
    // A real swap moves tokens by CPI inside the route instruction. A
    // top-level Transfer to an account we do not own is the drain shape.
    const drain = new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [
        { pubkey: ata(user.publicKey, USDC), isSigner: false, isWritable: true },
        {
          pubkey: ata(attacker.publicKey, USDC),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: user.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]),
    });
    await expect(
      verifySwapTransaction(buildSwapTx({ extra: [drain] }), expected),
    ).rejects.toMatchObject({ failure: 'foreign_transfer' });
  });

  it('foreign_transfer: rejects a top-level SOL transfer to an outside account', async () => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0); // System Transfer
    data.writeBigUInt64LE(1_000_000n, 4);
    const drain = new TransactionInstruction({
      programId: SYSTEM_PROGRAM,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: attacker.publicKey, isSigner: false, isWritable: true },
      ],
      data,
    });
    await expect(
      verifySwapTransaction(buildSwapTx({ extra: [drain] }), expected),
    ).rejects.toMatchObject({ failure: 'foreign_transfer' });
  });

  it('input_account_missing: rejects when the input token account is absent', async () => {
    await expect(
      verifySwapTransaction(buildSwapTx({ includeInput: false }), expected),
    ).rejects.toMatchObject({ failure: 'input_account_missing' });
  });

  it('output_account_missing: rejects when the output token account is absent', async () => {
    await expect(
      verifySwapTransaction(buildSwapTx({ includeOutput: false }), expected),
    ).rejects.toMatchObject({ failure: 'output_account_missing' });
  });

  it('fee_account_missing: rejects when an expected fee account is absent', async () => {
    await expect(
      verifySwapTransaction(buildSwapTx(), {
        ...expected,
        feeAccount: attacker.publicKey.toBase58(),
      }),
    ).rejects.toMatchObject({ failure: 'fee_account_missing' });
  });
});

describe('verifySwapTransaction — amount, by simulation', () => {
  it('confirms the amount when the simulated deltas match', async () => {
    const r = await verifySwapTransaction(buildSwapTx(), expected, {
      simulator: new FakeSimulator(goodDeltas),
    });
    expect(r.amountVerified).toBe(true);
  });

  it('amount_mismatch: rejects when more input is spent than quoted', async () => {
    const sim = new FakeSimulator([
      { mint: USDC, delta: -999_999_999n },
      { mint: ASSET, delta: 42_000_000n },
    ]);
    await expect(
      verifySwapTransaction(buildSwapTx(), expected, { simulator: sim }),
    ).rejects.toMatchObject({ failure: 'amount_mismatch' });
  });

  it('amount_mismatch: rejects when the output mint is never credited', async () => {
    const sim = new FakeSimulator([{ mint: USDC, delta: -BigInt(AMOUNT_IN) }]);
    await expect(
      verifySwapTransaction(buildSwapTx(), expected, { simulator: sim }),
    ).rejects.toMatchObject({ failure: 'amount_mismatch' });
  });

  it('amount_unverifiable: refuses to pass silently when a check was demanded', async () => {
    await expect(
      verifySwapTransaction(buildSwapTx(), expected, {
        requireAmountCheck: true,
      }),
    ).rejects.toMatchObject({ failure: 'amount_unverifiable' });
  });

  it('reports amountVerified=false rather than throwing when none was demanded', async () => {
    const r = await verifySwapTransaction(buildSwapTx(), expected);
    expect(r.amountVerified).toBe(false);
  });
});

describe('the guard is default-deny, not default-permit', () => {
  /**
   * Both holes here were fail-OPEN, and both were invisible from inside the
   * function: one dropped the accounts it could not resolve and then asked
   * whether the remaining ones were the user's, the other named the single
   * System instruction it refused and waved through every tag it had not
   * thought of. A guard that enumerates what it rejects permits the rest.
   */
  // The module already has an `attacker`; a second one here would shadow it
  // and read as a different party in the same story.

  it('refuses a token move whose destination is hidden in a lookup table', async () => {
    /**
     * The shape that matters. Instruction accounts resolve against the
     * STATIC key list, so an address served from an ALT came back
     * undefined, got filtered away, and the "is every account the user's"
     * test then passed over an empty list. The destination was invisible
     * precisely because it was the one worth seeing.
     */
    const tableKey = Keypair.generate().publicKey;
    const tx = buildTx({
      owner: user.publicKey,
      inputMint: USDC,
      outputMint: ASSET,
      lookupTable: { key: tableKey, addresses: [attacker.publicKey] },
      extra: [
        new TransactionInstruction({
          programId: new PublicKey(TOKEN_PROGRAM),
          keys: [
            { pubkey: ata(user.publicKey, ASSET), isSigner: false, isWritable: true },
            { pubkey: attacker.publicKey, isSigner: false, isWritable: true },
            { pubkey: user.publicKey, isSigner: true, isWritable: false },
          ],
          // 3 = SPL Transfer.
          data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]),
        }),
      ],
    });
    await expect(verifySwapTransaction(tx, expected)).rejects.toThrow(
      /cannot resolve|outside the wallet/,
    );
  });

  it('refuses System tags it was never taught, not just Transfer', async () => {
    // Assign (tag 1) hands the account to a new owner program and moves no
    // lamports at all, so every lamport-watching check reads clean.
    const assign = new TransactionInstruction({
      programId: new PublicKey(SYSTEM_PROGRAM),
      keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.concat([
        Buffer.from([1, 0, 0, 0]),
        attacker.publicKey.toBuffer(),
      ]),
    });
    await expect(
      verifySwapTransaction(
        buildTx({ owner: user.publicKey, inputMint: USDC, outputMint: ASSET, extra: [assign] }),
        expected,
      ),
    ).rejects.toThrow(/unexpected System instruction/);
  });

  it('refuses a System instruction too short to carry a tag', async () => {
    // `tag` came back undefined here and undefined !== SYSTEM_IX_TRANSFER,
    // so the old branch simply fell out of the bottom and permitted it.
    const stub = new TransactionInstruction({
      programId: new PublicKey(SYSTEM_PROGRAM),
      keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([2, 0]),
    });
    await expect(
      verifySwapTransaction(
        buildTx({ owner: user.publicKey, inputMint: USDC, outputMint: ASSET, extra: [stub] }),
        expected,
      ),
    ).rejects.toThrow(/unexpected System instruction/);
  });

  it('still permits a System Transfer between accounts it can see are the reader own', async () => {
    /**
     * The deny has to be narrow enough to leave the legitimate case alone,
     * or it is not a fix, it is an outage.
     *
     * Note which accounts this uses. The verifier's idea of "the reader's"
     * is their wallet plus the token accounts for the two mints IN THIS
     * SWAP, so a transfer to their wSOL account is NOT recognised on a
     * USDC->asset trade. That is the correct answer and it is why our own
     * wrap transaction is built and signed on our side instead of being
     * handed to this function: this exists to interrogate bytes we did not
     * write, and it should not learn to trust a shape just because we
     * happen to produce it too.
     */
    const selfPay = new TransactionInstruction({
      programId: new PublicKey(SYSTEM_PROGRAM),
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: ata(user.publicKey, ASSET), isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.alloc(8)]),
    });
    await expect(
      verifySwapTransaction(
        buildTx({ owner: user.publicKey, inputMint: USDC, outputMint: ASSET, extra: [selfPay] }),
        expected,
      ),
    ).resolves.toBeDefined();
  });
});

describe('the SOL legs, at zero tolerance', () => {
  /**
   * THE BUG THIS WHOLE CHANGE EXISTS FOR.
   *
   * Native SOL is the wrapped-SOL mint to the verifier, and quantities are
   * measured by diffing token accounts. With `wrapAndUnwrapSol: true`
   * Jupiter wrapped, swapped and CLOSED the wrapped account inside one
   * transaction, so the diff read zero before and zero after — an account
   * that had been destroyed. Buying SOL was refused as "does not credit the
   * output mint", and every SOL trade has been impossible since the engine
   * shipped.
   *
   * With the flag off the account survives, and these pin the consequence:
   * the checks hold at EXACTLY the quoted amount. No band, no allowance for
   * fees or rent, because none of those land in this account any more —
   * they land in the wrap transaction we build ourselves.
   */
  const WSOL = 'So11111111111111111111111111111111111111112';
  const LAMPORTS_IN = '1000000000';

  const solIn = {
    userPublicKey: user.publicKey.toBase58(),
    inputMint: WSOL,
    outputMint: ASSET,
    amountInRaw: LAMPORTS_IN,
  };
  const txIn = () =>
    buildTx({ owner: user.publicKey, inputMint: WSOL, outputMint: ASSET });

  it('passes when the wrapped account is debited exactly what was quoted', async () => {
    const sim = new FakeSimulator([
      { mint: WSOL, delta: -1_000_000_000n },
      { mint: ASSET, delta: 42_000_000n },
    ]);
    const r = await verifySwapTransaction(txIn(), solIn, { simulator: sim });
    expect(r.amountVerified).toBe(true);
    expect(r.simOutAmountRaw).toBe('42000000');
  });

  it('refuses a single lamport of drift', async () => {
    // The tolerance is zero, and this is what that sentence means.
    const sim = new FakeSimulator([
      { mint: WSOL, delta: -999_999_999n },
      { mint: ASSET, delta: 42_000_000n },
    ]);
    await expect(
      verifySwapTransaction(txIn(), solIn, { simulator: sim }),
    ).rejects.toMatchObject({ failure: 'amount_mismatch' });
  });

  it('refuses the zero delta that a wrap-and-close used to produce', async () => {
    // The exact shape of the old bug, kept as a specimen: the account is
    // created and destroyed inside the transaction, so both sides read 0.
    const sim = new FakeSimulator([
      { mint: WSOL, delta: 0n },
      { mint: ASSET, delta: 42_000_000n },
    ]);
    await expect(
      verifySwapTransaction(txIn(), solIn, { simulator: sim }),
    ).rejects.toMatchObject({ failure: 'amount_mismatch' });
  });

  it('sees a real credit when SOL is what is being bought', async () => {
    const solOut = {
      userPublicKey: user.publicKey.toBase58(),
      inputMint: USDC,
      outputMint: WSOL,
      amountInRaw: AMOUNT_IN,
    };
    const tx = buildTx({
      owner: user.publicKey,
      inputMint: USDC,
      outputMint: WSOL,
    });
    const sim = new FakeSimulator([
      { mint: USDC, delta: -BigInt(AMOUNT_IN) },
      { mint: WSOL, delta: 90_000_000n },
    ]);
    const r = await verifySwapTransaction(tx, solOut, { simulator: sim });
    expect(r.simOutAmountRaw).toBe('90000000');

    // And still refuses the credit that never arrives.
    const none = new FakeSimulator([
      { mint: USDC, delta: -BigInt(AMOUNT_IN) },
      { mint: WSOL, delta: 0n },
    ]);
    await expect(
      verifySwapTransaction(tx, solOut, { simulator: none }),
    ).rejects.toMatchObject({ failure: 'amount_mismatch' });
  });
});

describe('the floor under the output', () => {
  /**
   * THE LARGEST HOLE THIS FILE HAD, and the exact-input check is what hid
   * it: a transaction that spent precisely the quoted amount looked
   * rigorously verified, while the only question asked of the output was
   * whether anything arrived at all.
   *
   * One base unit is something. A substituted /swap response that routes
   * the exact quoted input through an attacker's own pool and returns a
   * single unit of the right mint passes the input equality, passes the
   * positive-output test and passes every structural check, and the
   * difference is theirs.
   */
  const quoted = {
    ...expected,
    outAmountRaw: '42000000',
    slippageBps: 50,
  };

  it('refuses a route that returns one base unit of the right mint', async () => {
    const sim = new FakeSimulator([
      { mint: USDC, delta: -BigInt(AMOUNT_IN) },
      { mint: ASSET, delta: 1n },
    ]);
    await expect(
      verifySwapTransaction(buildSwapTx(), quoted, { simulator: sim }),
    ).rejects.toMatchObject({ failure: 'amount_mismatch' });
  });

  it('allows exactly the slippage the quote was asked for, and no more', async () => {
    // 50 bps of 42,000,000 is 210,000, so the floor is 41,790,000.
    const at = new FakeSimulator([
      { mint: USDC, delta: -BigInt(AMOUNT_IN) },
      { mint: ASSET, delta: 41_790_000n },
    ]);
    await expect(
      verifySwapTransaction(buildSwapTx(), quoted, { simulator: at }),
    ).resolves.toMatchObject({ simOutAmountRaw: '41790000' });

    const under = new FakeSimulator([
      { mint: USDC, delta: -BigInt(AMOUNT_IN) },
      { mint: ASSET, delta: 41_789_999n },
    ]);
    await expect(
      verifySwapTransaction(buildSwapTx(), quoted, { simulator: under }),
    ).rejects.toMatchObject({ failure: 'amount_mismatch' });
  });

  it('keeps the old behaviour for a caller with no quote to floor against', async () => {
    // Optional on purpose: a caller that cannot compute a floor should
    // degrade to the previous guarantee, not fail closed on arithmetic it
    // does not have. There are no such callers today.
    const sim = new FakeSimulator([
      { mint: USDC, delta: -BigInt(AMOUNT_IN) },
      { mint: ASSET, delta: 1n },
    ]);
    await expect(
      verifySwapTransaction(buildSwapTx(), expected, { simulator: sim }),
    ).resolves.toMatchObject({ amountVerified: true });
  });
});
