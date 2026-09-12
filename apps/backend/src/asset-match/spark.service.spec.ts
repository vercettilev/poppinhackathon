import { SparkService } from './spark.service';

/**
 * The service against a scripted upstream. `get` (GeckoTerminal) and the
 * global fetch (the DefiLlama fallback) are both replaced, so every case
 * here is a shape the real wire has actually produced — including the 429
 * storm that motivated half of this file.
 */

const MINT = 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS';

const POOLS = {
  data: [
    {
      attributes: { address: 'POOL1' },
      relationships: { base_token: { data: { id: `solana_${MINT}` } } },
    },
  ],
};

/** 30 hourly candles, newest first, the way GeckoTerminal answers. */
// Timestamps must sit inside the range windows sliceRange cuts against
// NOW — a candle from 2023 is a real absence, not test data.
function gtOhlcv(base = Math.floor(Date.now() / 1000)) {
  const rows: number[][] = [];
  for (let i = 0; i < 30; i++) {
    const ts = base - i * 3600;
    rows.push([ts, 1 + i * 0.01, 1.1 + i * 0.01, 0.9, 1.05 + i * 0.01, 1000]);
  }
  return { data: { attributes: { ohlcv_list: rows } } };
}

function llamaBody(n = 30, base = Math.floor(Date.now() / 1000)) {
  const prices: Array<{ timestamp: number; price: number }> = [];
  for (let i = 0; i < n; i++) {
    prices.push({ timestamp: base - i * 3600, price: 2 + i * 0.01 });
  }
  return { coins: { [`solana:${MINT}`]: { prices } } };
}

type GetFn = (path: string) => Promise<unknown | null>;

function makeService(script: { get: GetFn }) {
  const svc = new SparkService();
  const calls: string[] = [];
  (svc as unknown as { get: GetFn }).get = async (path: string) => {
    calls.push(path);
    return script.get(path);
  };
  return { svc, calls };
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

function mockLlama(answer: unknown | null) {
  global.fetch = jest.fn(async () =>
    answer === null
      ? ({ ok: false } as Response)
      : ({ ok: true, json: async () => answer } as unknown as Response),
  ) as unknown as typeof fetch;
}

describe('SparkService', () => {
  it('coalesces concurrent readers of one family into one upstream ask', async () => {
    // Twenty tabs opening the same hot chart used to be twenty upstream
    // calls in the one window the cache could not answer — the whole
    // shared rate budget spent on one token.
    const { svc, calls } = makeService({
      get: async (p) => (p.includes('/pools?') ? POOLS : gtOhlcv()),
    });
    mockLlama(null);
    const [a, b, c] = await Promise.all([
      svc.seriesResult(MINT, '1d'),
      svc.seriesResult(MINT, '1d'),
      svc.seriesResult(MINT, '1w'),
    ]);
    expect(a.points).not.toBeNull();
    expect(b.points).not.toBeNull();
    expect(c.points).not.toBeNull();
    // One pool lookup + one hour-family ohlcv, despite three readers.
    expect(calls.filter((p) => p.includes('/pools?')).length).toBe(1);
    expect(calls.filter((p) => p.includes('/ohlcv/')).length).toBe(1);
  });

  it('serves the last good candles through a failure window', async () => {
    /**
     * The clobber this fixes: a 429 used to REPLACE the cached candles
     * with a null, so "Try again" during a storm answered "did not load"
     * from cache while perfectly good data had been thrown away one write
     * earlier. A failure keeps the prior read now, and it is served as
     * long as it is honestly recent.
     */
    let healthy = true;
    const { svc } = makeService({
      get: async (p) => {
        if (p.includes('/pools?')) return POOLS;
        return healthy ? gtOhlcv() : null;
      },
    });
    mockLlama(null);

    const first = await svc.seriesResult(MINT, '1d');
    expect(first.failed).toBe(false);

    // Past the TTL, into the storm.
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 6 * 60 * 1000);
    healthy = false;
    const during = await svc.seriesResult(MINT, '1d');
    expect(during.failed).toBe(false);
    expect(during.points).toEqual(first.points);
  });

  it('reports the failure once the stale data is too old to stand in', async () => {
    let healthy = true;
    const { svc } = makeService({
      get: async (p) => {
        if (p.includes('/pools?')) return POOLS;
        return healthy ? gtOhlcv() : null;
      },
    });
    mockLlama(null);
    await svc.seriesResult(MINT, '1d');

    // Three hours on, the hour family's 2h stale bound is behind us.
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 3 * 60 * 60 * 1000);
    healthy = false;
    const after = await svc.seriesResult(MINT, '1d');
    expect(after.failed).toBe(true);
    expect(after.points).toBeNull();
  });

  it('falls back to DefiLlama when GeckoTerminal refuses, closes only', async () => {
    // Llama answers prices, not candles. Dressing a close as an open would
    // let the candle view draw flat lies, so the OHLC fields go out null
    // and the chip's toggle hides itself — the behaviour it already has
    // for older builds that sent closes alone.
    const { svc } = makeService({
      get: async (p) => (p.includes('/pools?') ? POOLS : null),
    });
    mockLlama(llamaBody());
    const r = await svc.seriesResult(MINT, '1d');
    expect(r.failed).toBe(false);
    expect(r.points).not.toBeNull();
    expect(r.opens).toBeNull();
    expect(r.highs).toBeNull();
    expect(r.lows).toBeNull();
  });

  it('gives Llama a turn even when the POOL lookup was refused', async () => {
    // A refused lookup is exactly what a fallback is for — and a token
    // GeckoTerminal has not indexed yet may still have a history there.
    const { svc } = makeService({ get: async () => null });
    mockLlama(llamaBody());
    const r = await svc.seriesResult(MINT, '1d');
    expect(r.failed).toBe(false);
    expect(r.points).not.toBeNull();
  });
});

/**
 * A YOUNG POOL STILL HAS A CHART.
 *
 * Measured 2026-08-30 on $HEEBOO, four days old: GeckoTerminal held four
 * DAY candles for its pool against a MIN_POINTS of eight, so the day
 * family was discarded whole and both ranges that read it — "1M" and
 * "MAX" — answered nothing. An empty box under a token that had traded
 * every hour of its short life, and the chip inviting a retry at
 * something that would never change.
 */
describe('a pool younger than the range it is asked for', () => {
  it('draws MAX from hour candles when the day family is too short', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { svc, calls } = makeService({
      get: async (path) => {
        if (path.includes('/pools?')) return POOLS;
        // Four days of history: honest data, and below the day floor.
        if (path.includes('/ohlcv/day')) {
          return {
            data: {
              attributes: {
                ohlcv_list: [0, 1, 2, 3].map((i) => [
                  nowSec - i * 86_400,
                  1,
                  1.1,
                  0.9,
                  1.05,
                  1000,
                ]),
              },
            },
          };
        }
        if (path.includes('/ohlcv/hour')) return gtOhlcv(nowSec);
        return null;
      },
    });
    // No DefiLlama rescue: the point is that the HOUR family answers.
    global.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof fetch;

    const r = await svc.seriesResult(MINT, 'max');
    expect(r.failed).toBe(false);
    expect(r.points?.length ?? 0).toBeGreaterThan(0);
    // It asked the day family first, and only then walked down.
    expect(calls.some((c) => c.includes('/ohlcv/day'))).toBe(true);
    expect(calls.some((c) => c.includes('/ohlcv/hour'))).toBe(true);
  });

  it('leaves a mature pool on its own family', async () => {
    // The walk is downward and stops at the first family with data, so a
    // token with real day candles is drawn exactly as before.
    const nowSec = Math.floor(Date.now() / 1000);
    const { svc, calls } = makeService({
      get: async (path) => {
        if (path.includes('/pools?')) return POOLS;
        if (path.includes('/ohlcv/day')) {
          return {
            data: {
              attributes: {
                ohlcv_list: Array.from({ length: 30 }, (_, i) => [
                  nowSec - i * 86_400,
                  1,
                  1.1,
                  0.9,
                  1.05,
                  1000,
                ]),
              },
            },
          };
        }
        return null;
      },
    });
    const r = await svc.seriesResult(MINT, 'max');
    expect(r.points?.length ?? 0).toBeGreaterThan(0);
    expect(calls.some((c) => c.includes('/ohlcv/hour'))).toBe(false);
  });
})
