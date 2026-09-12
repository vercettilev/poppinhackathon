/**
 * Jupiter Ultra search — one call, two jobs.
 *
 * §6 resolution: `$TICKER` → mint.
 * §7 safety gate: the audit fields nothing in v1 ever read.
 *
 * Ported from `terminal.service.ts` getTokenMetadata and the
 * `JupiterUltraTokenInfo` interface. Two deliberate changes:
 *
 *   TIMEOUT. v1 used 15000ms. §9 gives the whole `$TICKER` path 2s, so a 15s
 *   timeout is not a slow path, it is a path that renders nothing every time
 *   the upstream is unwell. Default here is 1500ms, and exceeding the budget
 *   yields nothing rather than arriving late.
 *
 *   ERROR POSTURE. v1 caught and returned an empty Map, so a failed call and a
 *   token that does not exist were the same answer. Harmless for metadata
 *   display; unacceptable for §7, where "we could not check" must never read as
 *   "it passed". This client reports failure distinctly and the gate fails
 *   closed on it.
 */

/** Jupiter Ultra API token search response. */
export interface JupiterUltraTokenInfo {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  twitter?: string;
  website?: string;
  dev?: string;
  circSupply?: number;
  totalSupply?: number;
  tokenProgram?: string;
  /** Present and non-null means the authority was RETAINED. */
  mintAuthority?: string | null;
  /** Present and non-null means the issuer can still freeze holdings. */
  freezeAuthority?: string | null;
  firstPool?: { id: string; createdAt: string };
  holderCount?: number;
  audit?: { topHoldersPercentage?: number; devMints?: number };
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  tags?: string[];
  createdAt?: string;
  fdv?: number;
  mcap?: number;
  usdPrice?: number;
  liquidity?: number;
  /** Jupiter's rolling stats. priceChange is PERCENT over the window. */
  stats24h?: { priceChange?: number };
}

export type UltraOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** `rate_limited` is separate from `http_error` for the same reason
       *  RouteFailure separates it: throttling says nothing about the asset,
       *  and §11 cannot read conversion off a field that merges the two. */
      reason:
        | 'timeout'
        | 'http_error'
        | 'network_error'
        | 'bad_shape'
        | 'rate_limited';
    };

export interface UltraSearchClient {
  /**
   * Search by mint address(es) or by symbol. Comma-join for multiple mints.
   *
   * `timeoutMs` overrides the client default per call, because §9's budget
   * belongs to the resolution PATH and one client serves all three: the
   * contract-address path gets 500ms and the entity path 3s, and a single
   * constructor-time timeout cannot be both.
   */
  search(
    query: string,
    opts?: { timeoutMs?: number },
  ): Promise<UltraOutcome<JupiterUltraTokenInfo[]>>;
}

const ULTRA_BASE = 'https://lite-api.jup.ag';
/** §9: the whole $TICKER path is 2s. This call cannot own more than a slice. */
const DEFAULT_TIMEOUT_MS = 1500;
/** One retry, short — matching HttpJupiterClient. */
const RETRY_BACKOFF_MS = 300;

export class HttpUltraSearchClient implements UltraSearchClient {
  /**
   * Normalised in the constructor for the same reason as HttpJupiterClient:
   * a bare `fetch` invoked as a property of an object throws Illegal
   * invocation. This class happened to escape it by assigning to a local
   * before calling, which is a correctness that depends on the shape of one
   * statement. Making it explicit removes the accident.
   */
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly opts: {
      apiKey?: string | undefined;
      base?: string;
      timeoutMs?: number;
      fetchFn?: typeof fetch;
    } = {},
  ) {
    const f = opts.fetchFn ?? fetch;
    this.fetchFn = (...args) => f(...args);
  }

  async search(
    query: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<UltraOutcome<JupiterUltraTokenInfo[]>> {
    const fetchFn = this.fetchFn;
    const base = this.opts.base ?? ULTRA_BASE;
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${base}/ultra/v1/search?query=${encodeURIComponent(query)}`;
      // Header values stay plain ASCII: a non-Latin-1 character in a header
      // value makes fetch throw before the request is ever made.
      const headers: Record<string, string> = {};
      if (this.opts.apiKey) headers['x-api-key'] = this.opts.apiKey;

      let res = await fetchFn(url, { headers, signal: controller.signal });

      // One retry on 429, inside the existing timeout. The AbortController
      // already bounds the total, so this cannot push the call past §9's
      // budget: if the backoff would exceed the timeout, the abort fires and
      // the outcome is `timeout` rather than a late success.
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        res = await fetchFn(url, { headers, signal: controller.signal });
        if (res.status === 429) return { ok: false, reason: 'rate_limited' };
      }

      if (!res.ok) return { ok: false, reason: 'http_error' };

      const body = await res.json();
      if (!Array.isArray(body)) return { ok: false, reason: 'bad_shape' };
      return { ok: true, value: body as JupiterUltraTokenInfo[] };
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      return { ok: false, reason: aborted ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * §6 path B: `$TICKER` → a single mint, or nothing.
 *
 * "Ambiguity resolves to nothing, not to a guess." Symbols are not unique on
 * Solana and never will be — the same three letters are reused by dozens of
 * launches. So: take exact symbol matches, prefer the verified ones, and
 * return a mint ONLY when exactly one candidate survives. Two candidates is a
 * silent render, not a coin flip.
 */
export function resolveTickerFrom(
  symbol: string,
  results: readonly JupiterUltraTokenInfo[],
  /**
   * "Could this one be traded here at all?" — the SAME question the safety
   * gate asks, applied to the candidate list before the ambiguity rule runs.
   * Optional so existing callers keep the old behaviour exactly.
   */
  tradeable?: (t: JupiterUltraTokenInfo) => boolean,
): JupiterUltraTokenInfo | undefined {
  const wanted = symbol.replace(/^\$/, '').trim().toLowerCase();
  if (!wanted) return undefined;

  const exact = results.filter((t) => t.symbol?.toLowerCase() === wanted);
  if (exact.length === 0) return undefined;

  /**
   * ELIGIBILITY BEFORE AMBIGUITY, and the order matters more than it looks.
   *
   * "Two candidates is silence" is the right instinct and, alone, too blunt
   * for a launchpad world: every ticker that works acquires copies within
   * days. Measured 2026-08-25 on $BULLSHIT — Jupiter answered two exact
   * matches, one with $541k of liquidity and 7,785 holders and one with $56
   * and 15 — and the rule called that a tie, so a tweet whose whole subject
   * was that token could not be traded at all.
   *
   * A copy that cannot pass the safety gate is not a rival reading of the
   * symbol; it is a token this product would refuse on its own terms. So
   * candidates are filtered by the gate's own criteria FIRST, and the
   * ambiguity rule then runs on what is left. Nothing is loosened: every
   * mint returned here still goes through the real gate afterwards. What
   * changes is that a genuine ambiguity — two tokens both worth trading —
   * still resolves to silence, which is the case the rule was written for.
   */
  const eligible = tradeable ? exact.filter(tradeable) : exact;
  if (eligible.length === 0) return undefined;

  const verified = eligible.filter((t) => t.isVerified === true);
  const pool = verified.length > 0 ? verified : eligible;
  if (pool.length === 1) return pool[0];

  /**
   * THE ORGANIC TIEBREAK, for the launchpad world's common case.
   *
   * Measured on $Pistacio, 2026-08-28: SIX exact-symbol tokens, THREE past
   * the gate ($523k / $118k / $28k of liquidity — all genuinely tradeable),
   * so eligibility alone called it a tie and a tweet whose whole subject
   * was the token got silence. But Jupiter's own wash-trading detector had
   * already told the copies apart: the real one scored 92.5/high on
   * organicScore, both copies 0/low. Same shape on $PANTS the same day.
   *
   * So: when EXACTLY ONE eligible candidate carries the 'high' label, it
   * is not a rival reading of the symbol, it is the token and its
   * imitators. Two highs is a genuine ambiguity and stays silence — this
   * loosens nothing about that case, and every winner still passes the
   * real admission gate afterwards.
   */
  /**
   * ONE RUNG LOWER THAN 'HIGH', because the head of the market is not the
   * only place copies appear.
   *
   * The rule already trusted Jupiter's wash-trading detector to name the
   * real token when exactly one candidate scored 'high'. The same evidence
   * exists a rung down and was being thrown away: measured 2026-08-30,
   * $APU's two eligible candidates sat 1.6x apart on liquidity — far too
   * close for the dominance rule below — while Jupiter scored the real one
   * 'medium' and the copy 'low'.
   *
   * 'low' is NOT a positive signal, it is the absence of one, so a lone
   * 'low' among unlabelled candidates wins nothing. The winner must hold a
   * genuinely positive label, hold it alone, and hold it above everyone
   * else. Two 'high's remain a tie, exactly as before.
   *
   * THE LABEL IS VOLATILE, which is the other reason it never decides
   * alone: $APU was measured 'medium' in the morning and 'low' the same
   * afternoon, with its liquidity and holders barely moved. A token can
   * fall in and out of this tiebreak on a third party's rolling window,
   * so the size guard below is not belt-and-braces — it is what keeps a
   * momentary score from being read as identity.
   */
  const RANK: Record<string, number | undefined> = { high: 3, medium: 2, low: 1 };
  const POSITIVE = 2; // 'medium' and above; 'low' is the absence of a signal
  const scored = pool.map((t) => RANK[t.organicScoreLabel ?? ''] ?? 0);
  const best = Math.max(...scored);
  if (best >= POSITIVE && scored.filter((s) => s === best).length === 1) {
    const winner = pool[scored.indexOf(best)]!;
    /**
     * A LABEL CANNOT OUTVOTE A LANDSLIDE.
     *
     * Adversarial review caught this before it shipped, and the accidental
     * case is worse than the attack: Jupiter's organic label is NOT
     * monotone in size (measured the same day — $APU scored 'medium' at
     * $19k of liquidity while $BILLY scored 'low' at $188k), so without a
     * guard a small copy holding a middling score takes the cashtag from
     * a token a hundred times its size, and the reader buys the copy from
     * under a tweet about the real one. Silence became WRONG TOKEN, which
     * is the one direction this function must never move.
     *
     * So the label decides only among peers. If any other candidate beats
     * the labelled winner on BOTH liquidity and holders, the label is not
     * evidence of identity and the question falls through to size below.
     */
    const outsized = pool.some(
      (t) =>
        t !== winner &&
        (t.liquidity ?? 0) > (winner.liquidity ?? 0) &&
        (t.holderCount ?? 0) > (winner.holderCount ?? 0),
    );
    if (!outsized) return winner;
  }

  /**
   * THE DOMINANCE TIEBREAK, and the reason it had to exist.
   *
   * Widening the gate on 2026-08-30 had a cost nobody would have guessed:
   * eligibility runs BEFORE ambiguity, so a lower floor lets more copies
   * through, and more copies means more ties, which means SILENCE. Measured
   * over 37 live tickers, the wider gate gained $SPX and LOST $BILLY —
   * whose second candidate ($14,871 and 3,018 holders) had simply been too
   * small to qualify before, and now stood beside the real one ($188,414
   * and 35,245 holders) as an equal.
   *
   * Both carried Jupiter's 'low' organic label, so the score could not
   * separate them. The SIZE could, by more than ten times on both axes.
   * A token with an order of magnitude more liquidity AND an order of
   * magnitude more holders than its nearest namesake is not one reading of
   * an ambiguous symbol; it is the token, standing next to an imitator.
   *
   * The multiple sits in a wide empty gap, the same standard the gate's own
   * thresholds were calibrated to. Measured the same day: $BILLY 12.7x
   * liquidity / 11.7x holders (the real one) against $SNAI 2.2x / 16.8x and
   * $ELIZA 1.4x / 1.9x — two genuine ambiguities that must stay silent, and
   * do. BOTH axes are required precisely so $SNAI's holder spread cannot
   * carry it alone.
   */
  const ranked = [...pool].sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
  const top = ranked[0];
  const rest = ranked.slice(1);
  if (
    rest.length > 0 &&
    typeof top?.liquidity === 'number' &&
    typeof top?.holderCount === 'number'
  ) {
    /**
     * AGAINST THE BEST OF EVERYONE ELSE, not against the runner-up.
     *
     * The first version compared the top only to the next candidate by
     * liquidity, and review showed what that buys an attacker for $30k:
     * plant a decoy sized between yourself and the real token, and the
     * real token's holder count — the one fact that says which mint the
     * tweet meant — is never read at all. Taking the MAXIMUM of each axis
     * across every other candidate means no third party can be inserted
     * to hide a second one.
     */
    const rivalLiq = Math.max(...rest.map((t) => t.liquidity ?? 0));
    const rivalHolders = Math.max(...rest.map((t) => t.holderCount ?? 0));
    if (
      rivalLiq > 0 &&
      rivalHolders > 0 &&
      top.liquidity >= rivalLiq * DOMINANCE_MULTIPLE &&
      top.holderCount >= rivalHolders * DOMINANCE_MULTIPLE
    ) {
      return top;
    }
  }
  return undefined;
}

/** How far ahead of its nearest namesake a token must stand before the
 *  lead counts as identity rather than luck. See the tiebreak above. */
export const DOMINANCE_MULTIPLE = 5;
