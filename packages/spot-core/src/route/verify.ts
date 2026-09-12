import { PublicKey, VersionedTransaction } from '@solana/web3.js';

/**
 * §7-adjacent, and the load-bearing piece of v2's safety story.
 *
 * The product's whole claim is "the user signs what WE built". v1 could lean on
 * that implicitly: the backend held the key, so the only transaction that could
 * ever be signed was one the backend had itself deserialized. v2 hands a base64
 * blob to Phantom. If that blob is not checked, the claim is unbacked — a
 * tampered or substituted /swap response reaches the wallet unexamined, and the
 * user's signature is the attacker's last missing piece.
 *
 * So this is not only a malformed-response guard. It is the sole defense
 * between a compromised or MITM'd Jupiter response and a signed transaction.
 *
 * WHAT IS CHECKED OFFLINE (no RPC, inside the §9 latency budget):
 *   - the blob deserializes as a VersionedTransaction at all
 *   - it arrives UNSIGNED (no pre-filled signatures)
 *   - it needs exactly one signature, and that signer is our user
 *   - every top-level program is one a swap legitimately invokes
 *   - no top-level token/SOL movement to an address that is not the user's
 *   - the user's expected input and output token accounts are referenced
 *   - the fee account, when one is expected, is referenced
 *
 * WHAT IS NOT: the swap AMOUNT. It lives inside Jupiter's route instruction
 * data, behind an Anchor discriminator and layout that changes between Jupiter
 * versions; decoding it offline would be brittle in the direction that matters
 * least (false rejections break trading) and unreliable in the direction that
 * matters most. Amount is therefore verified by SIMULATION when a simulator is
 * supplied — balance deltas are ground truth and version-proof. Callers that
 * need the guarantee pass `requireAmountCheck` and get a typed failure rather
 * than a silent pass when no simulator is available.
 */

/** Programs a legitimate Jupiter swap invokes at the TOP level. */
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const DEFAULT_ALLOWED_PROGRAMS: readonly string[] = [
  COMPUTE_BUDGET,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  JUPITER_V6,
];

/**
 * SPL Token instruction tags that move or delegate someone else's funds. A real
 * Jupiter swap performs its transfers by CPI *inside* the route instruction, so
 * seeing any of these at the top level is the shape an injected drain takes.
 */
const TOKEN_IX_TRANSFER = 3;
const TOKEN_IX_APPROVE = 4;
const TOKEN_IX_SET_AUTHORITY = 6;
const TOKEN_IX_BURN = 8;
const TOKEN_IX_TRANSFER_CHECKED = 12;
const TOKEN_IX_APPROVE_CHECKED = 13;
const DANGEROUS_TOKEN_IX = new Set([
  TOKEN_IX_TRANSFER,
  TOKEN_IX_APPROVE,
  TOKEN_IX_SET_AUTHORITY,
  TOKEN_IX_BURN,
  TOKEN_IX_TRANSFER_CHECKED,
  TOKEN_IX_APPROVE_CHECKED,
]);

/** System program instruction tag for a lamport transfer (little-endian u32). */
const SYSTEM_IX_TRANSFER = 2;

export type VerificationFailure =
  | 'undeserializable'
  | 'already_signed'
  | 'unexpected_signers'
  | 'signer_mismatch'
  | 'unknown_program'
  | 'foreign_transfer'
  | 'input_account_missing'
  | 'output_account_missing'
  | 'fee_account_missing'
  | 'amount_mismatch'
  | 'amount_unverifiable';

export class TransactionVerificationError extends Error {
  readonly failure: VerificationFailure;
  readonly detail: string | undefined;

  constructor(failure: VerificationFailure, message: string, detail?: string) {
    super(message);
    this.name = 'TransactionVerificationError';
    this.failure = failure;
    this.detail = detail;
  }
}

export interface ExpectedSwap {
  /** The wallet that will sign. Must be the sole signer and the fee payer. */
  userPublicKey: string;
  inputMint: string;
  outputMint: string;
  /** Raw base units of the input mint this swap is supposed to consume. */
  amountInRaw: string;
  /** Present only when a platform fee is configured (§8: off in shipped builds). */
  feeAccount?: string | undefined;
  /**
   * What the QUOTE promised as output, in raw base units, and the slippage
   * the quote was asked for. Together they are the floor the transaction
   * must clear.
   *
   * Without this the amount check answered "did anything at all arrive",
   * and "anything at all" includes one base unit. A substituted /swap
   * response that spends exactly the quoted input through an attacker's
   * own pool and returns a single unit of the right mint passes the input
   * equality, passes the positive-output test, passes every structural
   * check, and takes the difference. It is the largest hole this file has
   * had, and it was open the whole time the exact-input check was making
   * it look rigorous.
   *
   * Optional so a caller that genuinely has no quote (there are none
   * today) degrades to the old behaviour rather than failing closed on a
   * floor it cannot compute.
   */
  outAmountRaw?: string | undefined;
  slippageBps?: number | undefined;
}

/** Raw token balance change for one mint, from the signer's perspective. */
export interface BalanceDelta {
  mint: string;
  /** Negative when the wallet loses units. */
  delta: bigint;
}

export interface TransactionSimulator {
  /**
   * Simulate and report the owner's token balance deltas. Ground truth for the
   * amount check: it does not care how Jupiter encoded its instruction.
   */
  simulateBalanceDeltas(
    transactionBase64: string,
    owner: string,
    /** Mints to report on. The simulator cannot know which matter otherwise. */
    mints: readonly string[],
  ): Promise<BalanceDelta[]>;
}

export interface VerifyOptions {
  simulator?: TransactionSimulator | undefined;
  /** Throw `amount_unverifiable` rather than pass when no simulator is given. */
  requireAmountCheck?: boolean | undefined;
  /** Override the top-level program allowlist. */
  allowedPrograms?: readonly string[] | undefined;
}

export interface VerificationResult {
  /** Accounts the transaction can be proven to touch, from static keys. */
  staticAccountKeys: string[];
  /** False when no simulator ran; the amount was structurally bounded only. */
  amountVerified: boolean;
  /**
   * Raw base units of the output mint the SIMULATION credited, when an
   * amount check ran. Simulated, never executed — see verifyAmount.
   */
  simOutAmountRaw: string | null;
}

const ATA_PROGRAM_KEY = new PublicKey(ASSOCIATED_TOKEN_PROGRAM);

/**
 * Both token programs are tried because tokenized equities are Token-2022
 * mints (SPCX retains a permanentDelegate and freezeAuthority), while USDC and
 * ordinary SPL memecoins are classic Token. Deriving only one would fail to
 * find the account and reject a perfectly good transaction.
 */
export function associatedTokenAddresses(
  owner: PublicKey,
  mint: PublicKey,
): string[] {
  return [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((program) => {
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBytes(), new PublicKey(program).toBytes(), mint.toBytes()],
      ATA_PROGRAM_KEY,
    );
    return ata.toBase58();
  });
}

/**
 * Base64 to bytes without `Buffer`.
 *
 * `Buffer` is a Node type. Referencing it here made esbuild bundle a 56kb
 * polyfill into a service worker that has `atob` natively — a tenth of the
 * shipped worker, for one call. `atob` is global in browsers, workers and
 * Node 16+, so this costs nothing and runs everywhere the extension does.
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function deserialize(transactionBase64: string): VersionedTransaction {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(base64ToBytes(transactionBase64));
  } catch (err) {
    throw new TransactionVerificationError(
      'undeserializable',
      'Swap transaction could not be decoded',
      (err as Error).message,
    );
  }
  return tx;
}

/**
 * Verify an unsigned swap transaction against what we asked Jupiter to build.
 *
 * Throws TransactionVerificationError on the first mismatch — never returns a
 * "probably fine". A caller that catches this must not sign.
 */
export async function verifySwapTransaction(
  transactionBase64: string,
  expected: ExpectedSwap,
  opts: VerifyOptions = {},
): Promise<VerificationResult> {
  const tx = deserialize(transactionBase64);
  const msg = tx.message;

  // ── it must arrive unsigned ──────────────────────────────────────────────
  // A pre-filled signature means someone else already committed to this
  // transaction, which is never true of something Jupiter just built for us.
  const preSigned = tx.signatures.some((sig) => sig.some((b) => b !== 0));
  if (preSigned) {
    throw new TransactionVerificationError(
      'already_signed',
      'Swap transaction arrived with a signature already attached',
    );
  }

  // ── exactly one signer, and it is our user ───────────────────────────────
  const required = msg.header.numRequiredSignatures;
  if (required !== 1) {
    throw new TransactionVerificationError(
      'unexpected_signers',
      `Swap transaction requires ${required} signatures, expected 1`,
    );
  }

  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const feePayer = keys[0];
  if (feePayer !== expected.userPublicKey) {
    throw new TransactionVerificationError(
      'signer_mismatch',
      'Swap transaction is built for a different wallet',
      `got ${feePayer ?? '<none>'}, expected ${expected.userPublicKey}`,
    );
  }

  // ── every top-level program must be one a swap legitimately invokes ──────
  // Program IDs cannot come from an address lookup table, so this check is
  // complete offline rather than best-effort.
  const allowed = new Set(opts.allowedPrograms ?? DEFAULT_ALLOWED_PROGRAMS);
  const owner = new PublicKey(expected.userPublicKey);
  const userOwned = new Set<string>([
    expected.userPublicKey,
    ...associatedTokenAddresses(owner, new PublicKey(expected.inputMint)),
    ...associatedTokenAddresses(owner, new PublicKey(expected.outputMint)),
  ]);

  for (const ix of msg.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (programId === undefined || !allowed.has(programId)) {
      throw new TransactionVerificationError(
        'unknown_program',
        'Swap transaction invokes an unexpected program',
        programId ?? `index ${ix.programIdIndex}`,
      );
    }
    assertNoForeignMovement(ix, programId, keys, userOwned);
  }

  // ── the accounts the swap is supposed to touch must be present ───────────
  const present = new Set(keys);
  const inputAtas = associatedTokenAddresses(
    owner,
    new PublicKey(expected.inputMint),
  );
  if (!inputAtas.some((a) => present.has(a))) {
    throw new TransactionVerificationError(
      'input_account_missing',
      'Swap transaction does not reference the wallet’s input token account',
      expected.inputMint,
    );
  }

  const outputAtas = associatedTokenAddresses(
    owner,
    new PublicKey(expected.outputMint),
  );
  if (!outputAtas.some((a) => present.has(a))) {
    throw new TransactionVerificationError(
      'output_account_missing',
      'Swap transaction does not reference the wallet’s output token account',
      expected.outputMint,
    );
  }

  if (expected.feeAccount && !present.has(expected.feeAccount)) {
    throw new TransactionVerificationError(
      'fee_account_missing',
      'Swap transaction does not reference the configured fee account',
      expected.feeAccount,
    );
  }

  // ── amount, by simulation ────────────────────────────────────────────────
  const simOut = await verifyAmount(
    transactionBase64,
    expected,
    opts,
  );

  return {
    staticAccountKeys: keys,
    amountVerified: simOut !== null,
    simOutAmountRaw: simOut === null ? null : String(simOut),
  };
}

/**
 * Reject top-level instructions that move value anywhere but the user's own
 * accounts. A genuine swap moves tokens by CPI inside Jupiter's route
 * instruction; a top-level transfer/approve/setAuthority is the signature of
 * an injected drain.
 */
function assertNoForeignMovement(
  ix: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array },
  programId: string,
  keys: string[],
  userOwned: Set<string>,
): void {
  /**
   * Every account this instruction touches, or null if ANY of them cannot be
   * resolved.
   *
   * This used to `.filter(Boolean)` the unresolvable ones away, which is
   * fail-OPEN and exactly backwards: an index that does not resolve against
   * the static keys is an account loaded from an address lookup table, and a
   * transfer whose destination lives in an ALT is precisely the transfer we
   * cannot vouch for. Dropping it from the list made it invisible to the
   * "is this account the user's" test, so the instruction passed BECAUSE we
   * could not see where it pointed.
   */
  const accountsOf = (): string[] | null => {
    const out: string[] = [];
    for (const i of ix.accountKeyIndexes) {
      const k = keys[i];
      if (!k) return null;
      out.push(k);
    }
    return out;
  };

  if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) {
    const tag = ix.data[0];
    if (tag !== undefined && DANGEROUS_TOKEN_IX.has(tag)) {
      // Destination is the second account for Transfer, TransferChecked puts
      // the mint second and the destination third. Treat any non-user account
      // in the instruction as disqualifying rather than guessing the layout.
      const accounts = accountsOf();
      if (accounts === null) {
        throw new TransactionVerificationError(
          'foreign_transfer',
          'Swap transaction moves tokens to an account we cannot resolve',
          'address lookup table',
        );
      }
      const foreign = accounts.filter((a) => !userOwned.has(a));
      if (foreign.length > 0) {
        throw new TransactionVerificationError(
          'foreign_transfer',
          'Swap transaction moves tokens to an account outside the wallet',
          foreign.join(','),
        );
      }
    }
    return;
  }

  if (programId === SYSTEM_PROGRAM) {
    // System instruction tags are a little-endian u32.
    const view = new DataView(
      ix.data.buffer,
      ix.data.byteOffset,
      ix.data.byteLength,
    );
    const tag = ix.data.byteLength >= 4 ? view.getUint32(0, true) : undefined;

    /**
     * DEFAULT DENY, and it took a native-SOL bug to notice why it had to be.
     *
     * This branch used to inspect tag 2 (Transfer) and let every other
     * System tag through unexamined — Assign, CreateAccountWithSeed,
     * TransferWithSeed, and an instruction too short to carry a tag at all.
     * A guard that names the one thing it refuses permits everything it has
     * not thought of, which is the wrong way round for a list of ways to
     * move somebody's lamports.
     *
     * Nothing legitimate is lost. Jupiter is now asked for
     * wrapAndUnwrapSol: false, so a swap it builds has no top-level System
     * instruction at all; wrapping is done by a transaction we construct
     * ourselves and never send through here, because this function exists
     * only to interrogate bytes we did not write.
     */
    if (tag !== SYSTEM_IX_TRANSFER) {
      throw new TransactionVerificationError(
        'foreign_transfer',
        'Swap transaction carries an unexpected System instruction',
        `system tag ${tag ?? 'absent'}`,
      );
    }
    const accounts = accountsOf();
    if (accounts === null) {
      throw new TransactionVerificationError(
        'foreign_transfer',
        'Swap transaction transfers SOL to an account we cannot resolve',
        'address lookup table',
      );
    }
    const foreign = accounts.filter((a) => !userOwned.has(a));
    if (foreign.length > 0) {
      throw new TransactionVerificationError(
        'foreign_transfer',
        'Swap transaction transfers SOL outside the wallet',
        foreign.join(','),
      );
    }
  }
}

/**
 * @returns the OUT delta the simulation credited, or null when no amount
 *   check ran. It used to return a bare boolean and throw this number away
 *   — the most accurate quantity anywhere on the build path, computed on
 *   every swap and then discarded. It is what the transaction WOULD move
 *   against current pool state, which beats the router's projected
 *   `outAmount` by however much the pool has moved since the quote.
 *
 *   It is NOT the executed amount: a pre-broadcast simulation at
 *   commitment 'processed' with a replaced blockhash. Anything storing it
 *   must say simulated in its name.
 */
async function verifyAmount(
  transactionBase64: string,
  expected: ExpectedSwap,
  opts: VerifyOptions,
): Promise<bigint | null> {
  if (!opts.simulator) {
    if (opts.requireAmountCheck) {
      throw new TransactionVerificationError(
        'amount_unverifiable',
        'Amount check demanded but no simulator was supplied',
      );
    }
    return null;
  }

  const deltas = await opts.simulator.simulateBalanceDeltas(
    transactionBase64,
    expected.userPublicKey,
    [expected.inputMint, expected.outputMint],
  );
  const byMint = new Map(deltas.map((d) => [d.mint, d.delta]));

  const spent = byMint.get(expected.inputMint);
  const wanted = -BigInt(expected.amountInRaw);
  if (spent === undefined || spent !== wanted) {
    throw new TransactionVerificationError(
      'amount_mismatch',
      'Swap transaction spends a different amount than quoted',
      `input delta ${spent ?? 'absent'}, expected ${wanted}`,
    );
  }

  const received = byMint.get(expected.outputMint);
  if (received === undefined || received <= 0n) {
    throw new TransactionVerificationError(
      'amount_mismatch',
      'Swap transaction does not credit the output mint',
      `output delta ${received ?? 'absent'}`,
    );
  }

  /**
   * AND IT MUST BE ENOUGH. "Credits something" was the whole test, and one
   * base unit is something.
   *
   * The floor is the quote's own promise less the slippage the quote was
   * asked for, which is exactly the guarantee the reader was shown. A
   * router that routes worse than that has not slipped, it has been
   * replaced.
   */
  const promised = expected.outAmountRaw;
  if (promised !== undefined) {
    const bps = BigInt(expected.slippageBps ?? 0);
    const floor = (BigInt(promised) * (10_000n - bps)) / 10_000n;
    if (received < floor) {
      throw new TransactionVerificationError(
        'amount_mismatch',
        'Swap transaction returns less than the quote allowed for',
        `output delta ${received}, floor ${floor}`,
      );
    }
  }

  return received;
}
