import { describe, expect, it } from 'vitest';
import { HttpJupiterClient } from './jupiter';
import { RouteError } from '../errors';

/**
 * THE 429 PATH, WHICH HAD NO TEST AT ALL until it started refusing buys.
 *
 * Everything here is about one confusion: a fixed retry CEILING was being
 * reported as the caller's BUDGET, so a trade with seconds of room gave up
 * instantly and told the trader "no budget to wait". A clock and a fetch are
 * both injected, so the assertions are about decisions rather than timing.
 */

const QUOTE_URL_FRAGMENT = '/swap/v1/quote';

function tooMany(headers: Record<string, string> = {}): Response {
  return new Response('rate limited', { status: 429, headers });
}

function quoteOk(): Response {
  return new Response(
    JSON.stringify({ outAmount: '1000', routePlan: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * A fake clock that only moves when the client waits.
 *
 * `delay` really does hand control back to the event loop, so the awaits are
 * real; the durations are not. That keeps a spec about a ten second budget
 * from taking ten seconds, and — more importantly — makes the deadline
 * arithmetic exact instead of dependent on how loaded the machine is.
 */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    /* The sleep the client is given. It charges the clock exactly what the
       client asked to wait, so the spec never has to know the backoff
       schedule — a test that re-derives the code's own arithmetic passes
       whatever that arithmetic becomes. */
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** Answers 429 `refusals` times, then succeeds. Counts every call. */
function throttledFetch(refusals: number, headers: Record<string, string> = {}) {
  let calls = 0;
  const fetchFn = (async (url: unknown) => {
    calls++;
    expect(String(url)).toContain(QUOTE_URL_FRAGMENT);
    return calls <= refusals ? tooMany(headers) : quoteOk();
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls };
}

const PARAMS = {
  inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  outputMint: 'So11111111111111111111111111111111111111112',
  amount: '1000000',
  slippageBps: 100,
};

describe('Jupiter 429 handling', () => {
  it('retries until the deadline is spent, not exactly once', async () => {
    const c = clock();
    // Three refusals needs three waits (300, 600, 1200). The old client had
    // one retry and would have thrown on the second refusal.
    const { fetchFn, calls } = throttledFetch(3);
    const client = new HttpJupiterClient(fetchFn, undefined, {
      now: c.now,
      sleep: c.sleep,
    });

    const q = await client.quote(PARAMS, { deadlineAt: c.now() + 10_000 });

    expect(q.outAmount).toBe('1000');
    expect(calls()).toBe(4);
  });

  it('stops when the next wait would land past the deadline', async () => {
    const c = clock();
    const { fetchFn, calls } = throttledFetch(99);
    const client = new HttpJupiterClient(fetchFn, undefined, {
      now: c.now,
      sleep: c.sleep,
    });

    // 200ms of budget cannot cover even the first 300ms backoff.
    await expect(
      client.quote(PARAMS, { deadlineAt: c.now() + 200 }),
    ).rejects.toMatchObject({ failure: 'rate_limited' });
    expect(calls()).toBe(1);
  });

  it('waits out a reset header that the old fixed ceiling would have refused', async () => {
    const c = clock();
    /* THE REGRESSION, EXACTLY. `x-ratelimit-reset` two seconds out is past
       the 1000ms ceiling the client used to apply to everyone, so it gave up
       — while the caller here has eight seconds of budget and every reason
       to spend two of them. */
    const reset = Math.ceil((c.now() + 2_000) / 1000);
    const { fetchFn, calls } = throttledFetch(1, {
      'x-ratelimit-reset': String(reset),
    });
    const client = new HttpJupiterClient(fetchFn, undefined, {
      now: c.now,
      sleep: c.sleep,
    });

    const q = await client.quote(PARAMS, { deadlineAt: c.now() + 8_000 });

    expect(q.outAmount).toBe('1000');
    expect(calls()).toBe(2);
  });

  it('keeps the fixed ceiling for a caller that named no deadline', async () => {
    const c = clock();
    const reset = Math.ceil((c.now() + 2_000) / 1000);
    const { fetchFn, calls } = throttledFetch(1, {
      'x-ratelimit-reset': String(reset),
    });
    const client = new HttpJupiterClient(fetchFn, undefined, {
      now: c.now,
      sleep: c.sleep,
    });

    await expect(client.quote(PARAMS)).rejects.toBeInstanceOf(RouteError);
    expect(calls()).toBe(1);
  });

  it('gives up on a server that never stops refusing, however much budget there is', async () => {
    const c = clock();
    const { fetchFn, calls } = throttledFetch(99);
    const client = new HttpJupiterClient(fetchFn, undefined, {
      now: c.now,
      sleep: c.sleep,
    });

    await expect(
      client.quote(PARAMS, { deadlineAt: c.now() + 10_000_000 }),
    ).rejects.toMatchObject({ failure: 'rate_limited' });
    // MAX_ATTEMPTS, the backstop against a reset header one millisecond out.
    expect(calls()).toBe(4);
  });

  it('tells the trader nothing was charged, in words and not in jargon', async () => {
    const c = clock();
    const { fetchFn } = throttledFetch(99);
    const client = new HttpJupiterClient(fetchFn, undefined, {
      now: c.now,
      sleep: c.sleep,
    });

    /* This string is not internal. It goes into the 422 body and is rendered
       verbatim in the trade sheet, which is how "Rate limited, and no budget
       to wait" came to be shown to somebody mid-buy. */
    const err = await client
      .quote(PARAMS, { deadlineAt: c.now() + 200 })
      .catch((e: unknown) => e as RouteError);

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).message).toContain('Nothing was charged');
    expect((err as RouteError).message).not.toMatch(/budget|429|rate.?limit/i);
  });
});

