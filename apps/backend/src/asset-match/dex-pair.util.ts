/**
 * PAIR → BASE MINT, over Dexscreener's public API.
 *
 * A dexscreener or geckoterminal URL names a MARKET (a pair/pool address),
 * not a token. To trade the token the reader is looking at, we need the
 * pair's base mint — and Dexscreener publishes exactly that, free and
 * unauthenticated: GET /latest/dex/pairs/solana/<pair> answers
 * { pairs: [{ baseToken: { address } }] }.
 *
 * Best-effort by contract: any failure (network, shape, quote token) is a
 * null, and the caller falls back to the scorer exactly as if no pair had
 * been found. Cached because a pair's base token never changes, and this
 * runs on a public endpoint that must not fan a scroll into a request.
 */
const cache = new Map<string, { at: number; mint: string | null }>();
const TTL_MS = 60 * 60 * 1000;

/**
 * A GLOBAL OUTBOUND BUDGET, because this runs behind a PUBLIC route whose
 * `pair` is attacker-controllable: a rotating-proxy pool sending a fresh
 * base58 each request bypasses the per-pair cache and would otherwise fan
 * one request into one Dexscreener fetch each. The token bucket caps the
 * TOTAL fetch rate no matter how varied the input — over budget, the
 * resolver returns null (the same "could not resolve" the caller already
 * handles) instead of making the call. Sized for real usage (a burst of
 * genuine token-page visits) and far below anything Dexscreener throttles.
 */
const RATE_CAPACITY = 20;
const RATE_REFILL_PER_MS = 5 / 1000; // 5 per second
let tokens = RATE_CAPACITY;
let lastRefill = Date.now();
function takeToken(): boolean {
  const now = Date.now();
  tokens = Math.min(RATE_CAPACITY, tokens + (now - lastRefill) * RATE_REFILL_PER_MS);
  lastRefill = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

// Solana's own mints, never the "base" a reader means: a SOL- or
// USDC-quoted pair lists the memecoin as base, but a mis-ordered pair
// could put one of these there, and admitting SOL/USDC as "the page's
// token" would be absurd.
const NOT_A_TOKEN = new Set<string>([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export async function resolveDexPairBaseMint(
  pair: string,
): Promise<string | null> {
  const held = cache.get(pair);
  if (held && Date.now() - held.at < TTL_MS) return held.mint;

  // Over the outbound budget: refuse the fetch, and do NOT cache the
  // refusal (a null here means "we did not look", not "no base token").
  if (!takeToken()) return null;

  let mint: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${encodeURIComponent(pair)}`,
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (res.ok) {
      const body = (await res.json()) as {
        pairs?: Array<{ baseToken?: { address?: string } }>;
      };
      const addr = body.pairs?.[0]?.baseToken?.address;
      if (typeof addr === 'string' && addr && !NOT_A_TOKEN.has(addr)) {
        mint = addr;
      }
    }
  } catch {
    mint = null;
  }
  cache.set(pair, { at: Date.now(), mint });
  // Oldest out, not a full flush: a burst of junk pairs must not evict the
  // genuine resolutions real users depend on.
  if (cache.size > 5_000) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return mint;
}
