import { Injectable, Logger } from '@nestjs/common';

/**
 * The card's 24h sparkline: hourly closes for one mint, oldest first.
 *
 * Jupiter — the card's price source — sells the present tense only: a price
 * and a 24h delta, no history. A number without a shape has no story, and the
 * shape is most of what makes a trading surface read as one. GeckoTerminal is
 * the one documented, keyless API that has OHLCV for anything with a Solana
 * pool — which is this catalog's entire span, memecoins through xStocks,
 * because being routable on a Solana DEX is what admits an asset here at all.
 *
 * Two calls per mint: top pool, then that pool's hourly candles. Both behind
 * one in-memory cache with a 5-minute TTL, so a page being reopened does not
 * become an upstream request — the free tier allows ~30 calls/min and a
 * cached miss costs two.
 *
 * FAIL-OPEN TO NULL, always. The sparkline is decoration on a card whose job
 * is the trade; a card that fails to render because a chart API sneezed has
 * its priorities inverted. Null renders as no chart, same as every other
 * missing fact on this surface.
 */

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const TIMEOUT_MS = 2500;
/**
 * A FAILURE is remembered briefly; an ABSENCE is remembered properly.
 * These used to share one 5-minute line, and the difference was measured
 * live: a 429 burst or one slow upstream answer put "No chart for this
 * range" on PUMP — a token with 181 day-candles on the very same pool,
 * verified by replaying the exact request seconds later. The short TTL
 * still shields the rate limit from tap-storms; it just stops shielding
 * the outage from recovery.
 */
const FAIL_TTL_MS = 25_000;
/** How long a family's candles stay fresh. A minute chart ages in
 *  minutes; a day chart does not change until tomorrow. */
/** Llama speaks periods and spans, not timeframes and limits. Matched to
 *  the same windows the GeckoTerminal families cover. */
const LLAMA_FAMILIES: Record<Family, { period: string; span: number }> = {
  minute: { period: '5m', span: 288 },
  hour: { period: '1h', span: 200 },
  day: { period: '1d', span: 365 },
};

const FAMILY_TTL_MS: Record<Family, number> = {
  minute: 2 * 60 * 1000,
  hour: 5 * 60 * 1000,
  day: 30 * 60 * 1000,
};
/** Below this a slice is not a line worth drawing. Lower than the fetch
 *  floor on purpose: a thin pool with four trades in the last hour HAS a
 *  chart, and it is information. */
const MIN_SLICE_POINTS = 3;
const TTL_MS = 5 * 60 * 1000;
/** Fewer points than this draws a zigzag that reads as broken, not as data. */
const MIN_POINTS = 8;

/** A family's candles, remembered per mint. One entry now feeds every
 *  range that reads that family. */
interface FamilyEntry {
  /** When this entry was last WRITTEN (success or failure). */
  at: number;
  candles: Candle[] | null;
  /** True when the null came from a failed read, not a genuine absence. */
  failed: boolean;
  /** When `candles` were actually READ from an upstream. A failure entry
   *  can still carry the previous read's candles + this stamp, which is
   *  what makes serving stale possible without lying about freshness. */
  fetchedAt?: number;
  /** True when the source only had closes (the DefiLlama fallback). The
   *  wire then answers opens/highs/lows as null and the chip's candle
   *  toggle hides itself — a candle fabricated from a close is a lie. */
  closesOnly?: boolean;
}

/**
 * HOW STALE A CHART MAY BE SERVED, per family, when the upstream is down.
 *
 * "Chart did not load. Try again" was the answer during every
 * GeckoTerminal 429 storm, including to a reader whose candles were
 * sitting RIGHT THERE in this cache, thirty seconds past their TTL. A 1W
 * chart that is twenty minutes old is materially identical to a fresh
 * one; refusing to draw it was purity at the reader's expense. Bounded
 * per family because staleness costs more at fine granularity.
 */
const STALE_MAX_MS: Record<Family, number> = {
  minute: 15 * 60 * 1000,
  hour: 2 * 60 * 60 * 1000,
  day: 12 * 60 * 60 * 1000,
};

interface FetchOutcome {
  points: number[] | null;
  /** Epoch ms per point, same order. The chart's axis reads these instead
   *  of assuming candles are evenly spread across the range's name. */
  times: number[] | null;
  /**
   * Open / high / low, same order and length as `points`, whose values are
   * the closes. Sent alongside rather than instead: a line chart wants one
   * number per bucket and asking it to reduce four would be work at the
   * wrong end. Null exactly when points is.
   */
  opens: number[] | null;
  highs: number[] | null;
  lows: number[] | null;
  failed: boolean;
}

export type SparkRange = '15m' | '1h' | '4h' | '1d' | '1w' | '1m' | 'max';

/**
 * THREE FETCHES, SIX RANGES — and a window that means what it says.
 *
 * Every range used to be its own upstream call with its own aggregate, so
 * a reader tapping through the chart cost six. Worse, each call asked for
 * a COUNT of candles and the chip then drew them as if they were evenly
 * spread across the range's name. GeckoTerminal only emits a candle where
 * trades happened, so on a thin pool a count is not a window. Measured
 * 2026-08-25:
 *
 *     $ANTHROPIC  "1H"  60 candles → 36.1 HOURS of data
 *     $ANTHROPIC  "4H"  16 candles → 16.5 hours
 *     $WIF        "1H"  60 candles →  2.8 hours
 *
 * A trading surface that labels a day and a half "1H" is worse than one
 * with no chart at all. So the fetch is now per FAMILY (minute, hour, day)
 * at the finest aggregate, and each range is a slice of its family by real
 * TIME, bucketed on the same epoch boundaries GeckoTerminal itself uses.
 * Verified against upstream's own aggregation: every point identical on a
 * liquid pool (WIF, all six ranges, 0.0000% deviation).
 */
type Family = 'minute' | 'hour' | 'day';

/** One call per family. Limits are generous enough that the widest range
 *  in each family is covered even when a thin pool's candles span far more
 *  wall-clock than their count suggests. */
const FAMILIES: Record<Family, { timeframe: string; aggregate: number; limit: number }> = {
  minute: { timeframe: 'minute', aggregate: 1, limit: 300 },
  hour: { timeframe: 'hour', aggregate: 1, limit: 200 },
  day: { timeframe: 'day', aggregate: 1, limit: 1000 },
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Each range as a slice: which family to read, how far back the window
 * reaches, and how coarse the buckets are inside it. `bucketMs: null`
 * means one point per source candle.
 */
const RANGES: Record<
  SparkRange,
  { family: Family; windowMs: number | null; bucketMs: number | null }
> = {
  '15m': { family: 'minute', windowMs: 15 * MIN, bucketMs: null },
  '1h': { family: 'minute', windowMs: HOUR, bucketMs: null },
  // 5-minute buckets, not 15: sixteen points drew "4H" as a stick figure
  // while the family's 300-minute fetch already held every candle needed
  // for forty-eight. Densifying is free — same fetch, finer slicing.
  '4h': { family: 'minute', windowMs: 4 * HOUR, bucketMs: 5 * MIN },
  '1d': { family: 'hour', windowMs: DAY, bucketMs: null },
  // 2-hour buckets for the same reason: 42 points where 4-hour gave 21.
  '1w': { family: 'hour', windowMs: 7 * DAY, bucketMs: 2 * HOUR },
  '1m': { family: 'day', windowMs: 30 * DAY, bucketMs: null },
  // 'max' is the pool's whole life — the one range with no window.
  'max': { family: 'day', windowMs: null, bucketMs: null },
};

/**
 * The families a range may fall back to, finest last. Only ever downward:
 * a day chart may be drawn from hours when the pool is younger than the
 * range, but an hour chart is never drawn from days.
 */
function finerThan(family: Family): Family[] {
  if (family === 'day') return ['hour', 'minute'];
  if (family === 'hour') return ['minute'];
  return [];
}

/**
 * A candle, whole.
 *
 * This used to keep ts and close and throw open, high and low away — the
 * upstream row is [ts, open, high, low, close, volume] and we were reading
 * two fields of six, which is the same shape as two other finds today.
 * Candles cost nothing extra to carry and a candle view cannot exist
 * without them.
 */
interface Candle {
  /** Epoch MILLIseconds (GeckoTerminal speaks seconds; converted on entry). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * A range's slice of its family.
 *
 * Buckets are aligned to the epoch, not to `now`, because that is how
 * GeckoTerminal aligns its own aggregates — align to "now" instead and
 * every bucket boundary lands mid-candle, which measured as up to 17.5%
 * off upstream's numbers.
 */
export function sliceRange(
  candles: readonly Candle[],
  range: SparkRange,
  now: number,
): Candle[] {
  const spec = RANGES[range];
  const from = spec.windowMs === null ? -Infinity : now - spec.windowMs;
  const inWindow = candles.filter((c) => c.ts >= from);
  if (spec.bucketMs === null) return inWindow;
  const lastOf = new Map<number, Candle>();
  for (const c of inWindow) lastOf.set(c.ts - (c.ts % spec.bucketMs), c);
  return [...lastOf.keys()].sort((a, b) => a - b).map((k) => lastOf.get(k)!);
}

export function isSparkRange(v: unknown): v is SparkRange {
  return (
    v === '15m' ||
    v === '1h' ||
    v === '4h' ||
    v === '1d' ||
    v === '1w' ||
    v === '1m' ||
    v === 'max'
  );
}

@Injectable()
export class SparkService {
  private readonly logger = new Logger(SparkService.name);
  private readonly cache = new Map<string, FamilyEntry>();

  /** Hourly USD closes for the last 24h, oldest → newest. Null = no chart. */
  async spark24h(mint: string): Promise<number[] | null> {
    return this.series(mint, '1d');
  }

  /**
   * Closes for one mint over one range, oldest → newest. The chip's chart
   * asks per range; each (mint, range) pair is its own cache line, failures
   * included — a broken upstream must not be re-asked on every tap, that is
   * how a decoration takes down a rate limit.
   */
  async series(mint: string, range: SparkRange): Promise<number[] | null> {
    return (await this.seriesResult(mint, range)).points;
  }

  /**
   * The same answer, WITH the reason attached.
   *
   * This service has always known the difference between "this pool has no
   * candles at this range" and "we could not reach the candles", and it
   * keeps them apart in its own cache. What it never did was SAY which one
   * it was handing back, so every caller had one word (null) for two facts
   * — and the chip picked the wrong one, printing "No chart for this
   * range" over a token whose minute, hour AND day candles were all sitting
   * there upstream (measured on $ANTHROPIC: 60/16/24/42 candles present
   * while the reader was told the ranges were empty).
   *
   * A wire that cannot express the difference guarantees the lie.
   */
  async seriesResult(mint: string, range: SparkRange): Promise<FetchOutcome> {
    const { family } = RANGES[range];
    let fam = await this.familyCandles(mint, family);
    /**
     * A YOUNG POOL'S WHOLE LIFE IS HOURS, NOT DAYS.
     *
     * Measured 2026-08-30 on $HEEBOO, four days old: GeckoTerminal held
     * exactly four DAY candles for its pool, MIN_POINTS is eight, so the
     * day family was discarded whole and both ranges that read it — "1M"
     * and "MAX" — answered nothing. The reader got an empty box under a
     * token that had traded every hour of its short life, and the chip
     * told them to try again at something that would never change.
     *
     * The label is a promise about the WINDOW, never about the candle
     * size, so serving that window from a finer family keeps the promise:
     * MAX of a four-day-old pool IS its hour candles. The walk is
     * downward only and stops at the first family that has data, so a
     * mature token still gets its day candles exactly as before.
     */
    if (fam.candles === null && !fam.failed) {
      for (const finer of finerThan(family)) {
        const alt = await this.familyCandles(mint, finer);
        if (alt.candles !== null) {
          fam = alt;
          break;
        }
      }
    }
    if (fam.candles === null) {
      return { points: null, times: null, opens: null, highs: null, lows: null, failed: fam.failed };
    }
    // The window is whatever the range asked for; with a fallback family
    // the slice simply spans fewer, finer candles. 'max' has no window at
    // all, so it takes everything either way.
    const slice = sliceRange(fam.candles, range, Date.now());
    if (slice.length < MIN_SLICE_POINTS) {
      // A real absence: the pool exists and we read it, there simply was
      // nothing to draw inside the window the label promises. Saying so is
      // information — it means this asset has barely traded in that time.
      return { points: null, times: null, opens: null, highs: null, lows: null, failed: false };
    }
    return {
      points: slice.map((c) => c.close),
      times: slice.map((c) => c.ts),
      // A close dressed as an open is not an open. The chip already hides
      // the candle toggle when these are null — that behaviour was built
      // for older builds that sent closes alone, and the fallback slots
      // straight into it.
      opens: fam.closesOnly ? null : slice.map((c) => c.open),
      highs: fam.closesOnly ? null : slice.map((c) => c.high),
      lows: fam.closesOnly ? null : slice.map((c) => c.low),
      failed: false,
    };
  }

  /**
   * One family's candles for one mint, fetched once and shared by every
   * range that reads it. This is the whole request reduction: 1H and 4H
   * are two slices of the same minute fetch, 1D and 1W of the same hour
   * fetch, 1M and MAX of the same day fetch.
   */
  /** One upstream ask per (mint, family) at a time. Twenty tabs opening
   *  the same hot chart used to be twenty upstream calls during the one
   *  window the cache could not answer — which is how a feed spends the
   *  whole shared rate budget on one token. */
  private readonly familyInflight = new Map<string, Promise<FamilyEntry>>();

  private async familyCandles(mint: string, family: Family): Promise<FamilyEntry> {
    const key = `${mint}:${family}`;
    const hit = this.cache.get(key);
    if (
      hit &&
      Date.now() - hit.at < (hit.failed ? FAIL_TTL_MS : FAMILY_TTL_MS[family])
    ) {
      return this.serveable(hit, family);
    }

    let flight = this.familyInflight.get(key);
    if (!flight) {
      flight = this.fetchFamily(mint, family)
        .catch((e): FamilyEntry => {
          this.logger.debug(`family(${key}) failed: ${e?.message ?? e}`);
          return { at: Date.now(), candles: null, failed: true };
        })
        .then((fresh) => {
          /**
           * A FAILURE MUST NOT CLOBBER THE LAST GOOD READ. This used to
           * `cache.set(key, fresh)` unconditionally, so the moment a 429
           * landed, the candles the reader was just looking at were
           * REPLACED by a null — and every retry inside FAIL_TTL then
           * answered "did not load" from cache while perfectly good data
           * had been thrown away one write earlier.
           */
          const prior = this.cache.get(key);
          const entry: FamilyEntry =
            fresh.failed && prior?.candles
              ? { ...fresh, candles: prior.candles, fetchedAt: prior.fetchedAt, closesOnly: prior.closesOnly }
              : fresh;
          this.cache.set(key, entry);
          return entry;
        })
        .finally(() => this.familyInflight.delete(key));
      this.familyInflight.set(key, flight);
    }
    return this.serveable(await flight, family);
  }

  /** The failure entry's candles are served as long as they are honestly
   *  recent; past the bound the failure is reported as one. */
  private serveable(entry: FamilyEntry, family: Family): FamilyEntry {
    if (!entry.failed) return entry;
    const age = Date.now() - (entry.fetchedAt ?? 0);
    if (entry.candles && age < STALE_MAX_MS[family]) {
      return { ...entry, failed: false };
    }
    return entry.candles ? { ...entry, candles: null } : entry;
  }

  /**
   * Pool address per mint, remembered longer than candles: pools move
   * rarely, and this saves one of the two upstream calls per range.
   *
   * A FAILED LOOKUP IS NOT AN ABSENT POOL, and this cache learned that the
   * hard way. GeckoTerminal rate-limits our server address — the same
   * upstream 429s the geo lookup logs all day — and one refused pool query
   * used to be remembered for THIRTY MINUTES. Every range then answered
   * null from cache without a single request going out, so the chip drew
   * "No chart for this range" on six tabs at once for a token with $1.9M of
   * liquidity and 24 perfectly good hourly candles. Measured live on $ANSEM
   * and $SOL while $PUMP, whose pool happened to be cached from a good
   * read, charted fine beside them.
   *
   * So the two answers are kept apart, exactly as the series cache keeps
   * them: a real absence holds the long line, a failure holds a short one
   * and gets asked again.
   */
  private readonly poolCache = new Map<
    string,
    { at: number; pool: { address: string; side: string } | null; failed?: boolean }
  >();

  /** Same coalescing as the candle fetch, same reason: one hot token's
   *  first screenful must cost one pool lookup, not twenty. */
  private readonly poolInflight = new Map<
    string,
    Promise<{ address: string; side: string } | null>
  >();

  private async topPool(
    mint: string,
  ): Promise<{ address: string; side: string } | null> {
    const hit = this.poolCache.get(mint);
    if (hit && Date.now() - hit.at < (hit.failed ? FAIL_TTL_MS : 6 * TTL_MS)) {
      return hit.pool;
    }
    const going = this.poolInflight.get(mint);
    if (going) return going;
    const flight = this.lookupPool(mint).finally(() =>
      this.poolInflight.delete(mint),
    );
    this.poolInflight.set(mint, flight);
    return flight;
  }

  private async lookupPool(
    mint: string,
  ): Promise<{ address: string; side: string } | null> {

    const pools = await this.get<{
      data?: Array<{
        attributes?: { address?: string };
        relationships?: { base_token?: { data?: { id?: string } } };
      }>;
    }>(`/networks/solana/tokens/${mint}/pools?page=1`);

    // No response at all is the upstream refusing us; a response with no
    // pools is a token that genuinely has none. Only the second is a fact
    // worth keeping for half an hour.
    if (pools === null) {
      this.poolCache.set(mint, { at: Date.now(), pool: null, failed: true });
      return null;
    }

    const top = pools?.data?.[0];
    const address = top?.attributes?.address;
    // The pool prices two tokens; ask for the side that is OUR mint, or the
    // chart would be the counter-asset's. GeckoTerminal ids look like
    // "solana_<mint>".
    const baseId = top?.relationships?.base_token?.data?.id ?? '';
    const pool = address
      ? { address, side: baseId.endsWith(mint) ? 'base' : 'quote' }
      : null;
    this.poolCache.set(mint, { at: Date.now(), pool, failed: false });
    return pool;
  }

  private async fetchFamily(mint: string, family: Family): Promise<FamilyEntry> {
    const at = Date.now();
    const pool = await this.topPool(mint);
    if (!pool) {
      // topPool knows which kind of null it just handed over, so this can
      // inherit that verdict instead of guessing: a token with no pool is
      // a fact, a refused lookup is weather. Either way DefiLlama gets a
      // turn: a refused lookup is exactly what a fallback is for, and a
      // token GeckoTerminal has not indexed yet (this week's launch) may
      // still have a price history there.
      const entry = this.poolCache.get(mint);
      const llama = await this.fetchLlamaFamily(mint, family);
      return llama ?? { at, candles: null, failed: entry?.failed === true };
    }
    const g = FAMILIES[family];

    const ohlcv = await this.get<{
      data?: { attributes?: { ohlcv_list?: Array<number[]> } };
    }>(
      `/networks/solana/pools/${pool.address}/ohlcv/${g.timeframe}?aggregate=${g.aggregate}&limit=${g.limit}&currency=usd&token=${pool.side}`,
    );

    // No response at all is the upstream failing; a SHORT list is the pool
    // honestly not having that much history. Only the second one deserves
    // the full cache line.
    if (ohlcv === null) {
      const llama = await this.fetchLlamaFamily(mint, family);
      return llama ?? { at, candles: null, failed: true };
    }
    const list = ohlcv?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list) || list.length < MIN_POINTS) {
      return { at, candles: null, failed: false };
    }

    // Rows are [ts, open, high, low, close, volume], newest first, and the
    // timestamp is in SECONDS. Oldest first is the drawing order, close is
    // the honest per-candle price, and the time comes along now because the
    // chart's axis is drawn from it.
    const candles = [...list]
      .sort((a, b) => (a?.[0] ?? 0) - (b?.[0] ?? 0))
      .map((row) => ({
        ts: (row?.[0] ?? 0) * 1000,
        open: row?.[1],
        high: row?.[2],
        low: row?.[3],
        close: row?.[4],
      }))
      .filter((c): c is Candle => {
        // Every field or none: a candle missing a high is not a candle, and
        // half of one drawn as if it were whole is a lie about a price.
        const nums = [c.open, c.high, c.low, c.close];
        return (
          Number.isFinite(c.ts) &&
          c.ts > 0 &&
          nums.every((n) => typeof n === 'number' && Number.isFinite(n))
        );
      });

    return candles.length >= MIN_POINTS
      ? { at, candles, failed: false, fetchedAt: at }
      : { at, candles: null, failed: false };
  }

  /**
   * THE FREE FALLBACK — DefiLlama's keyless price history.
   *
   * GeckoTerminal is one shared 30-requests-a-minute budget spent by every
   * user through one server address, and a busy feed can drain it in
   * seconds; the reader then saw "Chart did not load" (field report, KMNO
   * 1W — measured healthy upstream minutes later, so the failure was the
   * storm, not the pool). Llama answers CLOSES only, so the entry is
   * marked closesOnly and the wire hides the candle view rather than
   * fabricating OHLC out of a close — a candle drawn from one price is a
   * lie about three. Probed live before wiring: KMNO answers 95 hourly
   * points, and $PANTS — nine days old — answers 88, so the coverage
   * includes exactly the fresh-memecoin tail GeckoTerminal lags on.
   */
  private async fetchLlamaFamily(
    mint: string,
    family: Family,
  ): Promise<FamilyEntry | null> {
    const at = Date.now();
    const g = LLAMA_FAMILIES[family];
    const url = `https://coins.llama.fi/chart/solana:${mint}?span=${g.span}&period=${g.period}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      let res: Response;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const body = (await res.json()) as {
        coins?: Record<string, { prices?: Array<{ timestamp: number; price: number }> }>;
      };
      const prices = body?.coins?.[`solana:${mint}`]?.prices;
      if (!Array.isArray(prices) || prices.length < MIN_POINTS) return null;
      const candles = prices
        .filter((p) => Number.isFinite(p?.timestamp) && Number.isFinite(p?.price))
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((p) => ({
          ts: p.timestamp * 1000,
          open: p.price,
          high: p.price,
          low: p.price,
          close: p.price,
        }));
      if (candles.length < MIN_POINTS) return null;
      this.logger.debug(`[spark] llama fallback served ${mint}:${family}`);
      return { at, candles, failed: false, fetchedAt: at, closesOnly: true };
    } catch {
      return null;
    }
  }

  /** Throttled so a rate-limit storm is one log line a minute, not thousands. */
  private lastRefusalLog = 0;

  private async get<T>(path: string): Promise<T | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${GT_BASE}${path}`, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        // A 429 is the single most likely reason a chart goes missing for
        // everyone at once, and until this line it left no trace at all —
        // the incident had to be reconstructed by replaying requests by
        // hand. WARN, not debug: this is the difference between "that pool
        // has no candles" and "we are being throttled".
        if (res.status === 429 && Date.now() - this.lastRefusalLog > 60_000) {
          this.lastRefusalLog = Date.now();
          this.logger.warn(`[spark] GeckoTerminal rate-limited us (429)`);
        }
        return null;
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
