import { VersionedTransaction } from '@solana/web3.js';
import type { SerializedTransaction } from '../signer/index';

/**
 * PUT OUR OWN BLOCKHASH ON THE TRANSACTION BEFORE IT IS SIGNED.
 *
 * Diagnosed from production, 2026-09-09. Every buy was failing with a 500
 * whose body was "Internal server error"; the API log said:
 *
 *   ERROR [AllExceptionsFilter] Error: Transaction simulation failed:
 *   Blockhash not found
 *
 * That string is what an RPC returns from `sendTransaction` when PREFLIGHT
 * fails, not from `simulateTransaction` (which reports errors in
 * `value.err`). So the transaction was built, verified and signed, and then
 * the node we broadcast to refused it because it did not recognise the
 * blockhash inside it.
 *
 * WHY IT IS NOT EXPIRY. Four attempts inside fifteen seconds all failed
 * identically. A blockhash lives roughly a minute, and the gap between
 * Jupiter's build and our send is a couple of seconds, so a fresh attempt
 * would have succeeded if age were the problem. It was not age: Jupiter
 * builds the transaction against ITS RPC, we broadcast to OURS, and ours
 * had never heard of that blockhash.
 *
 * The fix is to stop mixing the two. The blockhash the transaction carries
 * is now read from the same node that will be asked to accept it, which
 * closes the divergence and the expiry window in one move.
 *
 * IT DOES NOT WEAKEN VERIFICATION. The build path's simulation already runs
 * with `replaceRecentBlockhash: true` (see simulator.ts) and verify.ts's own
 * comment records that its amount check is "a pre-broadcast simulation at
 * commitment 'processed' with a replaced blockhash". Verification therefore
 * never depended on this field, and rewriting it changes nothing that was
 * checked.
 *
 * ORDER MATTERS: this must run BEFORE signing. A signature covers the
 * message, and the blockhash is in the message, so touching it afterwards
 * would invalidate the signature and produce a far more confusing failure
 * than the one it is fixing.
 */
export async function refreshBlockhash(
  rpcUrl: string,
  transactionBase64: SerializedTransaction,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<SerializedTransaction> {
  const f = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  let blockhash: string;
  try {
    const res = await f(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        /* 'finalized', and the first version's reasoning for 'confirmed'
           was wrong in a way only production showed.
           
           That version argued finalized is ~30 slots behind and wastes a
           third of the blockhash's life. True, and irrelevant: the failure
           is not age, it is PROPAGATION. Our RPC endpoint is a pool, so
           the node that answers this call is not necessarily the node that
           runs preflight on the send, and a just-confirmed blockhash may
           not have reached the second one yet. Refreshing from the same
           URL therefore did not fix "Blockhash not found" at all.
           
           A finalized blockhash is one every caught-up node already has.
           It still leaves roughly 45 seconds of validity, and we need
           two. Trading a third of the lifetime for cluster-wide agreement
           is the right side of that deal. */
        params: [{ commitment: 'finalized' }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`getLatestBlockhash http ${res.status}`);
    const body = (await res.json()) as {
      result?: { value?: { blockhash?: string } };
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    const got = body.result?.value?.blockhash;
    if (!got) throw new Error('getLatestBlockhash returned no blockhash');
    blockhash = got;
  } finally {
    clearTimeout(timer);
  }

  const tx = VersionedTransaction.deserialize(
    Buffer.from(transactionBase64, 'base64'),
  );
  tx.message.recentBlockhash = blockhash;
  return Buffer.from(tx.serialize()).toString('base64');
}
