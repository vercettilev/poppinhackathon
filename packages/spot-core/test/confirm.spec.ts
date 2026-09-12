import { describe, expect, it } from 'vitest';
import { confirmSignature } from '../src/route/simulator';

const SIG = '5'.repeat(88);

/** Replies from a script of `getSignatureStatuses` values, one per poll. */
const responder = (
  script: ReadonlyArray<unknown | Error>,
): { fetchFn: typeof fetch; calls: () => number } => {
  let i = 0;
  const fetchFn = (async () => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { value: [step] } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => i };
};

/** No real waiting: the poll gap is the thing under test, not the clock. */
const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

const confirm = (
  script: ReadonlyArray<unknown | Error>,
  opts: { timeoutMs?: number } = {},
) => {
  const { fetchFn, calls } = responder(script);
  const c = clock();
  return {
    calls,
    result: confirmSignature('https://rpc.example', SIG, {
      fetchFn,
      now: c.now,
      sleep: c.sleep,
      intervalMs: 1_000,
      timeoutMs: opts.timeoutMs ?? 10_000,
    }),
  };
};

describe('confirmSignature — the three outcomes', () => {
  it('confirms once a supermajority has voted', async () => {
    const { result } = confirm([{ err: null, confirmationStatus: 'confirmed' }]);
    expect(await result).toEqual({ status: 'confirmed' });
  });

  it('accepts finalized as confirmed', async () => {
    const { result } = confirm([{ err: null, confirmationStatus: 'finalized' }]);
    expect(await result).toEqual({ status: 'confirmed' });
  });

  it('does NOT accept processed — one node is not the cluster', async () => {
    // `processed` is a single node's opinion and can still be dropped by a
    // fork. Telling a reader they bought something on that basis would
    // sometimes be false.
    const { result } = confirm(
      [{ err: null, confirmationStatus: 'processed' }],
      { timeoutMs: 3_000 },
    );
    expect(await result).toEqual({ status: 'unknown' });
  });

  it('reports a chain rejection, carrying the raw error', async () => {
    const err = { InstructionError: [3, { Custom: 6001 }] };
    const { result } = confirm([{ err, confirmationStatus: 'confirmed' }]);
    expect(await result).toEqual({ status: 'failed', err });
  });

  it('reports failure even at processed — a revert does not un-revert', async () => {
    const err = { InstructionError: [0, 'InsufficientFunds'] };
    const { result } = confirm([{ err, confirmationStatus: 'processed' }]);
    expect(await result).toEqual({ status: 'failed', err });
  });

  it('waits through nulls and confirms when the status appears', async () => {
    // A signature is not immediately visible to every node.
    const { result, calls } = confirm([
      null,
      null,
      { err: null, confirmationStatus: 'confirmed' },
    ]);
    expect(await result).toEqual({ status: 'confirmed' });
    expect(calls()).toBe(3);
  });

  it('gives up as UNKNOWN, never as failed', async () => {
    // The distinction the whole card flow rests on: we stopped watching, which
    // is not the same as the transaction failing. It may land a second later,
    // and telling a reader they bought nothing would be a claim about their
    // money that we cannot support.
    const { result } = confirm([null], { timeoutMs: 3_000 });
    expect(await result).toEqual({ status: 'unknown' });
  });

  it('keeps polling through a network blip rather than calling it a loss', async () => {
    const { result } = confirm([
      new Error('offline'),
      new Error('offline'),
      { err: null, confirmationStatus: 'confirmed' },
    ]);
    expect(await result).toEqual({ status: 'confirmed' });
  });

  it('treats a non-ok RPC response as no answer yet, not as an outcome', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const c = clock();
    expect(
      await confirmSignature('https://rpc.example', SIG, {
        fetchFn,
        now: c.now,
        sleep: c.sleep,
        intervalMs: 1_000,
        timeoutMs: 3_000,
      }),
    ).toEqual({ status: 'unknown' });
  });

  it('stops at the deadline rather than polling for ever', async () => {
    const { result, calls } = confirm([null], { timeoutMs: 5_000 });
    await result;
    // One poll per interval up to the deadline, and then it stops.
    expect(calls()).toBeLessThanOrEqual(6);
    expect(calls()).toBeGreaterThan(1);
  });
});
