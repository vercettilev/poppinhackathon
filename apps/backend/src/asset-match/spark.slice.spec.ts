import { sliceRange } from './spark.service';

/**
 * THE SLICE IS THE WHOLE CHANGE, so it is the part with tests.
 *
 * Six ranges used to be six upstream calls, each asking for a COUNT of
 * candles. GeckoTerminal only emits a candle where trades happened, so a
 * count is not a window — measured live 2026-08-25:
 *
 *     $ANTHROPIC  "1H"  60 candles → 36.1 HOURS
 *     $ANTHROPIC  "4H"  16 candles → 16.5 hours
 *     $WIF        "1H"  60 candles →  2.8 hours
 *
 * Now there are three fetches (minute, hour, day) and each range is a
 * slice of its family by real time. The bucketing has to match upstream's
 * own aggregation or the numbers change under the reader's feet: verified
 * against GeckoTerminal's aggregate=15 and aggregate=4 responses, every
 * point identical on a liquid pool (WIF, all six ranges, 0.0000%). An
 * earlier draft aligned buckets to "now" instead of the epoch and measured
 * up to 17.5% off.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A candle every `stepMs`, ending at `now`. Whole candles now: the slice
 *  does not read open/high/low, but the type does, and a fixture that lies
 *  about a shape is how a renderer later gets a half candle. */
function candle(ts: number, close: number) {
  return { ts, open: close, high: close, low: close, close };
}

function evenly(now: number, stepMs: number, count: number) {
  return Array.from({ length: count }, (_, i) =>
    candle(now - (count - 1 - i) * stepMs, 100 + i),
  );
}

describe('sliceRange', () => {
  const now = 1_787_700_000_000; // fixed: the slice is pure, the clock is an input

  it('keeps only what is inside the window the label promises', () => {
    // 300 one-minute candles reach back five hours; "1h" may return one
    // hour of them and not a minute more.
    const candles = evenly(now, MIN, 300);
    const out = sliceRange(candles, '1h', now);
    expect(out.length).toBe(61); // inclusive of the boundary candle
    expect(now - out[0].ts).toBeLessThanOrEqual(HOUR);
  });

  it('does not invent a window where the candles are sparse', () => {
    // The $ANTHROPIC case: candles exist, but none of them are recent.
    // The honest answer is a short slice, not 36 hours wearing a "1H"
    // label. (The service turns a slice this short into a stated absence.)
    const stale = evenly(now - 30 * HOUR, MIN, 300);
    expect(sliceRange(stale, '1h', now)).toHaveLength(0);
    expect(sliceRange(stale, '1d', now)).toHaveLength(0);
    // The same candles ARE a legitimate week and month.
    expect(sliceRange(stale, '1w', now).length).toBeGreaterThan(0);
  });

  it('buckets on the epoch, the way upstream does', () => {
    // Every candle in one 15-minute bucket collapses to the LAST close in
    // it, and the boundaries are multiples of the bucket, not offsets from
    // `now`. Aligning to `now` is what measured 17.5% off upstream.
    // Derived, not assumed: the first draft of this test hand-picked a
    // timestamp and called it a boundary, and it was not one — the buckets
    // split where the test did not expect and the failure looked like a
    // code bug for a minute.
    // 4h buckets by FIVE minutes now (densified 2026-08-30 — sixteen
    // points drew "4H" as a stick figure; the same fetch holds 48).
    const base = Math.floor(1_787_700_000_000 / (5 * MIN)) * (5 * MIN);
    const candles = [
      candle(base + 1 * MIN, 10),
      candle(base + 4 * MIN, 11), // last of bucket 0 → survives
      candle(base + 6 * MIN, 12),
      candle(base + 9 * MIN, 13), // last of bucket 1 → survives
    ];
    const out = sliceRange(candles, '4h', base + 10 * MIN);
    expect(out.map((c) => c.close)).toEqual([11, 13]);
    for (const c of out) expect(c.ts % (5 * MIN)).toBeLessThan(5 * MIN);
  });

  it('returns points oldest first, whatever the buckets did', () => {
    const candles = evenly(now, 4 * HOUR, 60);
    const out = sliceRange(candles, '1w', now);
    const times = out.map((c) => c.ts);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('gives max the pool\'s whole life — the one range with no window', () => {
    const candles = evenly(now, DAY, 400); // older than any window
    expect(sliceRange(candles, 'max', now)).toHaveLength(400);
    expect(sliceRange(candles, '1m', now).length).toBeLessThanOrEqual(31);
  });

  it('reads a family once for two ranges — the request reduction itself', () => {
    // 1h and 4h are two slices of ONE minute fetch; the proof that they
    // can be is that both are derivable from the same array.
    const minutes = evenly(now, MIN, 300);
    expect(sliceRange(minutes, '1h', now).length).toBeGreaterThan(0);
    expect(sliceRange(minutes, '4h', now).length).toBeGreaterThan(0);
    const hours = evenly(now, HOUR, 200);
    expect(sliceRange(hours, '1d', now).length).toBeGreaterThan(0);
    expect(sliceRange(hours, '1w', now).length).toBeGreaterThan(0);
  });
});
