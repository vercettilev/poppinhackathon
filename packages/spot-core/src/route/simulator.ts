import { PublicKey } from '@solana/web3.js';
import { associatedTokenAddresses, type BalanceDelta, type TransactionSimulator } from './verify';

/**
 * The chain refused the transaction.
 *
 * Distinct from every other error on this path — a quote that did not come
 * back, a build that failed, our own structural checks — because those are all
 * statements about US or about Jupiter, and this one is a statement about what
 * would happen ON CHAIN. It is therefore the only failure that can carry an
 * issuer's mint-level transfer restriction, and callers deciding whether they
 * are looking at one need to recognise it by type rather than by parsing a
 * message.
 *
 * `err` is the raw RPC error value, preserved. Whoever reads this to decide
 * whether a restriction is really being enforced needs the actual program
 * error, not our guess about what caused it.
 */
export class SimulationFailedError extends Error {
  readonly err: unknown;

  constructor(err: unknown) {
    super(`simulation failed: ${JSON.stringify(err)}`);
    this.name = 'SimulationFailedError';
    this.err = err;
  }
}

/**
 * The amount check, backed by a real RPC simulation.
 *
 * Everything else `verify.ts` does is structural: it proves the transaction is
 * built for our user, invokes only programs a swap should, and moves nothing to
 * a foreign account. None of that constrains HOW MUCH it moves, and the amount
 * is the number the user is actually agreeing to.
 *
 * It cannot be read out of the transaction offline: it lives inside Jupiter's
 * route instruction, behind an Anchor discriminator whose layout moves between
 * versions. A decoder for it would be brittle exactly where brittleness is
 * expensive. Simulation sidesteps the encoding entirely and asks the chain what
 * the transaction would DO — ground truth, and version-proof.
 *
 * Method: read the owner's token accounts before, simulate, read them after,
 * subtract.
 *
 *   - `replaceRecentBlockhash` because the built transaction's blockhash may
 *     already be too old to simulate against.
 *   - `sigVerify: false` because the transaction is deliberately unsigned; the
 *     whole point is to check it BEFORE anyone signs. The two options are
 *     mutually exclusive in the RPC anyway.
 *   - Both token programs are tried for each mint, since tokenized equities are
 *     Token-2022 while USDC and ordinary memecoins are classic Token.
 *
 * This costs one or two RPC round trips on the BUILD path, not the match path,
 * so it lands after the reader has clicked Buy and before the wallet opens. §9's
 * budget governs the match; this is on the far side of it.
 */

/** Offset of `amount` (u64 LE) in an SPL token account. Same for Token-2022. */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

/**
 * Decode the `amount` field of a base64 SPL token account.
 *
 * Exported so it can be checked against real chain data rather than only
 * against fixtures this repo wrote: a decoder that agrees with its own test
 * fixtures and disagrees with the chain is the failure mode that matters, and
 * it is invisible from inside the fixtures.
 */
export function decodeTokenAmount(base64Data: string | undefined | null): bigint | null {
  if (!base64Data) return null;
  const bin = atob(base64Data);
  if (bin.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return null;
  let v = 0n;
  // Little-endian: least significant byte first, so read back to front.
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bin.charCodeAt(TOKEN_ACCOUNT_AMOUNT_OFFSET + i) & 0xff);
  }
  return v;
}

interface RpcAccount {
  data: [string, string] | null;
}

export interface RpcSimulatorOptions {
  fetchFn?: typeof fetch;
  /** Milliseconds before a simulation is abandoned. */
  timeoutMs?: number;
}

export class RpcTransactionSimulator implements TransactionSimulator {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly rpcUrl: string,
    opts: RpcSimulatorOptions = {},
  ) {
    // Wrapped for the same reason as the Jupiter client: a bare `fetch` called
    // as a property throws Illegal invocation in a browser.
    const f = opts.fetchFn ?? fetch;
    this.fetchFn = (...args) => f(...args);
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
      if (body.result === undefined) throw new Error(`rpc ${method}: empty result`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** u64 LE at the token-account amount offset, or null for a missing account. */
  private static amountOf(account: RpcAccount | null): bigint | null {
    return decodeTokenAmount(account?.data?.[0]);
  }

  async simulateBalanceDeltas(
    transactionBase64: string,
    owner: string,
    mints: readonly string[],
  ): Promise<BalanceDelta[]> {
    const ownerKey = new PublicKey(owner);

    // Every candidate account, flattened, with a map back to its mint. Both
    // token programs are candidates; only one will exist for a given mint.
    const candidates: { mint: string; address: string }[] = [];
    for (const mint of mints) {
      for (const address of associatedTokenAddresses(ownerKey, new PublicKey(mint))) {
        candidates.push({ mint, address });
      }
    }
    const addresses = candidates.map((c) => c.address);

    const [before, sim] = await Promise.all([
      this.rpc<{ value: (RpcAccount | null)[] }>('getMultipleAccounts', [
        addresses,
        { encoding: 'base64', commitment: 'processed' },
      ]),
      this.rpc<{
        value: {
          err: unknown;
          accounts: (RpcAccount | null)[] | null;
        };
      }>('simulateTransaction', [
        transactionBase64,
        {
          encoding: 'base64',
          commitment: 'processed',
          sigVerify: false,
          replaceRecentBlockhash: true,
          accounts: { encoding: 'base64', addresses },
        },
      ]),
    ]);

    if (sim.value.err) {
      // A simulation that fails on chain tells us the transaction would not
      // execute. Refusing here is strictly better than letting the reader sign
      // something that reverts.
      //
      // TYPED, and it has to be. This is the ONE failure that means "the chain
      // itself refused", which is the only place an issuer's mint-level
      // transfer restriction can surface. Callers attributing that must not be
      // reduced to matching on the prefix of a message string, and the raw
      // `err` is carried because the attribution is a hypothesis and this is
      // the evidence for it.
      throw new SimulationFailedError(sim.value.err);
    }

    const after = sim.value.accounts;
    if (!after) throw new Error('simulation returned no account state');

    // Sum per mint across its candidate accounts. A missing account reads as 0
    // on both sides, so an ATA created BY the swap correctly shows up as a
    // positive delta rather than as an error.
    const deltas = new Map<string, bigint>();
    candidates.forEach((c, i) => {
      const pre = RpcTransactionSimulator.amountOf(before.value[i] ?? null) ?? 0n;
      const post = RpcTransactionSimulator.amountOf(after[i] ?? null) ?? 0n;
      deltas.set(c.mint, (deltas.get(c.mint) ?? 0n) + (post - pre));
    });

    return [...deltas.entries()].map(([mint, delta]) => ({ mint, delta }));
  }
}

/**
 * Broadcast a signed transaction.
 *
 * Needed only for wallets that implement `solana:signTransaction` but not
 * `solana:signAndSendTransaction`: they sign and hand it back, leaving the send
 * to us. Wallets that broadcast themselves are preferred precisely because this
 * step does not exist for them — there is no window in which a signed
 * transaction sits in our hands unsent.
 *
 * `skipPreflight: false` keeps the node's own simulation, which is a second
 * chance to refuse something that would revert.
 */
/**
 * THE NODE REFUSED IT, AND NOTHING WAS BROADCAST.
 *
 * Typed rather than a bare Error because the distinction is about somebody's
 * money. `sendTransaction` answering with an error means preflight rejected
 * the transaction: it never reached the cluster, so "nothing was charged" is
 * a fact here and only here. A timeout or a dropped socket is the opposite
 * case — the request may well have landed — and that still throws a plain
 * Error, which callers must keep treating as unknown.
 *
 * Before this existed the whole class arrived at the API as an unhandled
 * exception and the reader was shown "Internal server error", which says
 * neither what happened nor whether they had paid for it.
 */
export class BroadcastRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastRejectedError';
  }

  /** True when the node refused because it did not recognise the
   *  blockhash. Worth distinguishing because it is the one rejection a
   *  retry can actually fix: the transaction never left, so re-signing
   *  against a newer blockhash cannot double-spend. */
  get isStaleBlockhash(): boolean {
    return /blockhash not found|blockhashnotfound/i.test(this.message);
  }
}

export async function sendRawTransaction(
  rpcUrl: string,
  transactionBase64: string,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const f = opts.fetchFn ?? fetch;
  const fetchFn: typeof fetch = (...args) => f(...args);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          transactionBase64,
          { encoding: 'base64', skipPreflight: false, maxRetries: 3 },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`sendTransaction http ${res.status}`);
    const body = (await res.json()) as {
      result?: string;
      error?: { message: string };
    };
    if (body.error) throw new BroadcastRejectedError(body.error.message);
    if (!body.result) throw new Error('sendTransaction returned no signature');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for the chain to accept a broadcast transaction.
 *
 * Exists because the card now shows an outcome the moment a wallet returns a
 * signature, which is BEFORE the chain has agreed to anything. A signature
 * means "this was submitted", not "this happened", and the optimistic line has
 * to be corrected by something.
 *
 * THREE outcomes, and collapsing any two of them would be a lie:
 *
 *   confirmed    the cluster has it, with no error.
 *   failed       the cluster has it and it reverted. The reader bought nothing.
 *   unknown      we stopped waiting. NOT a failure — Solana confirms in a
 *                second or two normally, but a congested cluster can take
 *                longer than any deadline we are willing to hold a card open
 *                for, and the transaction may well land after we walk away.
 *
 * `searchTransactionHistory` is on because a signature can drop out of the
 * recent-status cache while we are polling, and reading that as `unknown` when
 * the chain has a definite answer would be needlessly vague.
 */
export type ConfirmationOutcome =
  | { status: 'confirmed' }
  | { status: 'failed'; err: unknown }
  | { status: 'unknown' };

export async function confirmSignature(
  rpcUrl: string,
  signature: string,
  opts: {
    fetchFn?: typeof fetch;
    /** Total time to wait before reporting `unknown`. */
    timeoutMs?: number;
    /** Gap between polls. */
    intervalMs?: number;
    /**
     * PUT THE TRANSACTION BACK ON THE WIRE WHILE WE WAIT.
     *
     * A single sendTransaction is not a delivery. The node forwards it to
     * the current leader and, with maxRetries, a couple more — and if those
     * windows are missed the transaction is simply gone. Nobody is told:
     * the signature exists, the poll below finds nothing, and thirty
     * seconds later we report `unknown` for a trade that never happened.
     *
     * Measured on 2026-09-11: signed at 12:47:38, timed out at 12:48:08,
     * and `getSignatureStatuses` with searchTransactionHistory still
     * answered null afterwards. It was never on chain. The network was not
     * even busy — the minimum prioritization fee for the router's program
     * was zero in 99% of the last 150 blocks — so this was not a fee
     * problem. It was one attempt and no second.
     *
     * RE-SENDING THE SAME SIGNED BYTES IS SAFE, and that is the whole basis
     * of the pattern every Solana client uses. The transaction carries one
     * signature over one blockhash: the cluster can include it exactly
     * once, and a duplicate submission of something already included is
     * discarded rather than applied twice. This is NOT a retry that
     * re-signs — that would be a different transaction and could double
     * spend. It is the same envelope, posted again.
     *
     * Errors here are swallowed on purpose. A refused or timed-out resend
     * tells us nothing new; the poll is the authority on what happened.
     */
    resend?: () => Promise<unknown>;
    /** How often to put it back on the wire. */
    resendEveryMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ConfirmationOutcome> {
  const f = opts.fetchFn ?? fetch;
  const fetchFn: typeof fetch = (...args) => f(...args);
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const resendEveryMs = opts.resendEveryMs ?? 2_000;

  const deadline = now() + timeoutMs;
  /* The first send already happened at the call site, so the clock starts
     now and the first resend is one interval away, not immediate. */
  let nextResend = now() + resendEveryMs;

  for (;;) {
    try {
      const res = await fetchFn(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [[signature], { searchTransactionHistory: true }],
        }),
      });

      if (res.ok) {
        const body = (await res.json()) as {
          result?: {
            value?: Array<{
              err: unknown;
              confirmationStatus?: string;
            } | null>;
          };
        };
        const status = body.result?.value?.[0];
        if (status) {
          if (status.err) return { status: 'failed', err: status.err };
          // `processed` is one node's opinion and can still be dropped by a
          // fork. `confirmed` means a supermajority voted on the block, which
          // is the first point at which telling a reader they bought something
          // is true rather than likely.
          if (
            status.confirmationStatus === 'confirmed' ||
            status.confirmationStatus === 'finalized'
          ) {
            return { status: 'confirmed' };
          }
        }
      }
    } catch {
      // A failed poll says nothing about the transaction. Keep asking until the
      // deadline rather than reporting a network blip as a lost trade.
    }

    if (now() >= deadline) return { status: 'unknown' };
    if (opts.resend && now() >= nextResend) {
      nextResend = now() + resendEveryMs;
      // Deliberately not awaited into the poll's timing and deliberately
      // silent: see `resend` above. The poll decides the outcome.
      void Promise.resolve(opts.resend()).catch(() => {});
    }
    await sleep(intervalMs);
  }
}

/**
 * WHAT THE CHAIN ACTUALLY MOVED — the only honest asset quantity for a buy.
 *
 * Everything available before broadcast is an estimate: the router's quote
 * (loosest, up to a full slippage window off) and the pre-broadcast
 * simulation (closer, still hypothetical). Only the confirmed transaction
 * knows what happened, and it says so in `meta.pre/postTokenBalances`.
 *
 * MATCHED BY OWNER AND MINT, never by account index. The one piece of
 * prior art in this repo (wallets.service) matches on accountIndex and in
 * one branch simply takes postTokenBalances[0] — index-based guesswork that
 * silently reads somebody else's account when a route touches more of them
 * than expected. A swap through two pools touches several.
 *
 * Returns null rather than zero when it cannot tell. A zero delta is a real
 * outcome ("nothing moved"); "we could not read it" is not, and a caller
 * storing one as the other would record a swap that credited nothing.
 *
 * RETRIES because getSignatureStatuses can report `confirmed` a few hundred
 * milliseconds before getTransaction will serve the transaction at all.
 */
export async function executedTokenDelta(
  rpcUrl: string,
  signature: string,
  owner: string,
  mint: string,
  opts: {
    fetchFn?: typeof fetch;
    attempts?: number;
    gapMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<bigint | null> {
  const f = opts.fetchFn ?? fetch;
  const fetchFn: typeof fetch = (...args) => f(...args);
  const attempts = opts.attempts ?? 3;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gapMs = opts.gapMs ?? 700;

  type Bal = {
    owner?: string;
    mint?: string;
    uiTokenAmount?: { amount?: string };
  };

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(gapMs);
    try {
      const res = await fetchFn(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            signature,
            { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
          ],
        }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        result?: { meta?: { preTokenBalances?: Bal[]; postTokenBalances?: Bal[] } };
      };
      const meta = body.result?.meta;
      if (!meta) continue; // not served yet, or no meta — try again

      const pick = (rows: Bal[] | undefined) => {
        const row = (rows ?? []).find((b) => b.owner === owner && b.mint === mint);
        const raw = row?.uiTokenAmount?.amount;
        return raw === undefined ? null : BigInt(raw);
      };
      const post = pick(meta.postTokenBalances);
      if (post === null) return null; // the wallet holds none of it after
      // An account that did not exist before has no PRE row at all, which
      // is the normal shape of a first buy: absent means zero here, and
      // only here, because `post` already proved the account exists.
      const pre = pick(meta.preTokenBalances) ?? 0n;
      return post - pre;
    } catch {
      // Network or parse. The loop decides when to stop.
    }
  }
  return null;
}
