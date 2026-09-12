import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

/**
 * Builds transactions shaped like the one Jupiter's /swap returns: a
 * compute-budget instruction plus a route instruction referencing the wallet's
 * input and output token accounts, with opaque route data.
 *
 * Shared by verify.spec (which corrupts one field per case) and by the engine
 * fakes (which need a transaction that actually survives verification), so the
 * two cannot drift apart.
 */

export const JUPITER_V6 = new PublicKey(
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
);
export const COMPUTE_BUDGET = new PublicKey(
  'ComputeBudget111111111111111111111111111111',
);
export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
export const TOKEN_PROGRAM = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
export const TOKEN_2022_PROGRAM = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);
export const ATA_PROGRAM = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

export function ata(
  owner: PublicKey,
  mint: string,
  program: PublicKey = TOKEN_PROGRAM,
): PublicKey {
  const [addr] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), program.toBytes(), new PublicKey(mint).toBytes()],
    ATA_PROGRAM,
  );
  return addr;
}

export interface BuildTxOpts {
  owner: PublicKey;
  inputMint: string;
  outputMint: string;
  /** Defaults to `owner`; set to forge a transaction built for someone else. */
  payer?: PublicKey;
  includeInput?: boolean;
  includeOutput?: boolean;
  outputProgram?: PublicKey;
  feeAccount?: PublicKey;
  extra?: TransactionInstruction[];
  /**
   * Accounts served from an address lookup table rather than the static
   * key list. This is how a real drain hides its destination: the verifier
   * resolves instruction accounts against the STATIC keys, so anything in
   * here comes back undefined.
   */
  lookupTable?: { key: PublicKey; addresses: PublicKey[] };
}

export function buildSwapTx(opts: BuildTxOpts): string {
  const payer = opts.payer ?? opts.owner;

  const routeAccounts = [{ pubkey: payer, isSigner: true, isWritable: true }];
  if (opts.includeInput !== false) {
    routeAccounts.push({
      pubkey: ata(opts.owner, opts.inputMint),
      isSigner: false,
      isWritable: true,
    });
  }
  if (opts.includeOutput !== false) {
    routeAccounts.push({
      pubkey: ata(
        opts.owner,
        opts.outputMint,
        opts.outputProgram ?? TOKEN_PROGRAM,
      ),
      isSigner: false,
      isWritable: true,
    });
  }
  if (opts.feeAccount) {
    routeAccounts.push({
      pubkey: opts.feeAccount,
      isSigner: false,
      isWritable: true,
    });
  }

  const instructions = [
    new TransactionInstruction({
      programId: COMPUTE_BUDGET,
      keys: [],
      data: Buffer.from([2, 0, 0, 0, 0]),
    }),
    new TransactionInstruction({
      programId: JUPITER_V6,
      keys: routeAccounts,
      // Opaque on purpose: the verifier must not need to decode Jupiter's
      // instruction layout to do its job.
      data: Buffer.from([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]),
    }),
    ...(opts.extra ?? []),
  ];

  const alt = opts.lookupTable
    ? [
        new AddressLookupTableAccount({
          key: opts.lookupTable.key,
          state: {
            deactivationSlot: 2n ** 64n - 1n,
            lastExtendedSlot: 0,
            lastExtendedSlotStartIndex: 0,
            authority: undefined,
            addresses: opts.lookupTable.addresses,
          },
        }),
      ]
    : undefined;

  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: '11111111111111111111111111111111',
    instructions,
  }).compileToV0Message(alt);

  return Buffer.from(new VersionedTransaction(msg).serialize()).toString(
    'base64',
  );
}
