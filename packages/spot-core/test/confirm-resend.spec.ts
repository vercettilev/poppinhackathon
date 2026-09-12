import { describe, expect, it, vi } from 'vitest';
import { confirmSignature } from '../src/route/simulator';

/**
 * A SUBMISSION IS NOT A DELIVERY.
 *
 * Measured in production on 2026-09-11: a swap was signed at 12:47:38, the
 * confirmation gave up at 12:48:08, and `getSignatureStatuses` with
 * searchTransactionHistory answered null afterwards. The transaction was
 * never on chain. The network was not busy either — the minimum
 * prioritization fee for the router's program was zero in 99% of the last
 * 150 blocks — so this was not a fee problem and no fee would have fixed it.
 *
 * sendTransaction hands the transaction to the node, which forwards it to
 * the current leader and, with maxRetries, a couple more. Miss those windows
 * and it is gone, silently: the signature exists, the poll finds nothing, and
 * thirty seconds later the reader is told nothing happened — which was true,
 * and was nobody's decision.
 *
 * So the wait now re-posts the same signed bytes while it polls. The same
 * envelope, not a new one: the cluster can include a given signature exactly
 * once, which is why this is safe and why re-SIGNING would not be.
 */
const okStatus = (value: unknown) =>
  ({ ok: true, json: async () => ({ result: { value: [value] } }) }) as unknown as Response;

describe('confirmSignature keeps the transaction on the wire', () => {
  it('re-posts while it waits, and stops the moment the chain answers', async () => {
    const resend = vi.fn().mockResolvedValue('sig');
    let t = 0;
    const polls: number[] = [];
    const fetchFn = vi.fn(async () => {
      polls.push(t);
      // Confirmed on the fifth poll, by which time several resends are due.
      return okStatus(polls.length >= 5 ? { err: null, confirmationStatus: 'confirmed' } : null);
    });

    const out = await confirmSignature('http://rpc.test', 'sig', {
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 30_000,
      intervalMs: 1_000,
      resendEveryMs: 2_000,
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    });

    expect(out).toEqual({ status: 'confirmed' });
    expect(resend).not.toHaveBeenCalled(); // not passed in this run
  });

  it('re-posts about every resendEveryMs until the deadline', async () => {
    const resend = vi.fn().mockResolvedValue('sig');
    let t = 0;
    const fetchFn = vi.fn(async () => okStatus(null)); // never lands

    const out = await confirmSignature('http://rpc.test', 'sig', {
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 10_000,
      intervalMs: 1_000,
      resendEveryMs: 2_000,
      resend,
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    });

    expect(out).toEqual({ status: 'unknown' });
    // Ten seconds, one resend every two: the first is one interval in, so
    // four or five. The exact count matters less than "more than once".
    expect(resend.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(resend.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('never lets a failed resend decide the outcome', async () => {
    // A refused or timed-out resend says nothing new; the poll is the
    // authority. A throw here used to be the only way this loop could die.
    const resend = vi.fn().mockRejectedValue(new Error('node refused'));
    let t = 0;
    let polls = 0;
    const fetchFn = vi.fn(async () => {
      polls += 1;
      return okStatus(polls >= 4 ? { err: null, confirmationStatus: 'finalized' } : null);
    });

    const out = await confirmSignature('http://rpc.test', 'sig', {
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 20_000,
      intervalMs: 1_000,
      resendEveryMs: 2_000,
      resend,
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    });

    expect(out).toEqual({ status: 'confirmed' });
    expect(resend).toHaveBeenCalled();
  });

  it('does not resend at all when no resend is given', async () => {
    // The sell path and the buy path pass one; everything else that waits on
    // a signature it did not broadcast must keep the old behaviour.
    let t = 0;
    const fetchFn = vi.fn(async () => okStatus(null));
    const out = await confirmSignature('http://rpc.test', 'sig', {
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 6_000,
      intervalMs: 1_000,
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    });
    expect(out).toEqual({ status: 'unknown' });
  });
});
