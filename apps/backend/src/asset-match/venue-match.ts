import { CURATED_CATALOG, type CuratedAsset } from '@repo/spot-core';

/**
 * The certain half of asset matching: read the page's identity instead of
 * inferring it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * asset-match.util.ts scores a page's TEXT — headline hits, capped body
 * mentions, corroborating terms — and it is good at what it does. But it was
 * calibrated on a corpus that is 42/47 Wikipedia, and it never looks at the
 * URL. On the pages that actually matter that is backwards:
 *
 *   coingecko.com/en/coins/dogwifhat        the answer is IN THE PATH
 *   finance.yahoo.com/quote/TSLA            the answer is IN THE PATH
 *   solscan.io/token/EKpQG…65zcjm           the answer is THE MINT ITSELF
 *
 * A dedicated asset page is not evidence about its subject, it IS its
 * subject. Scoring the prose of such a page is guessing at something the URL
 * already states, and guessing can be wrong where reading cannot.
 *
 * ── WHAT THIS BUYS THE PRODUCT ──────────────────────────────────────────────
 * A certainty TIER, not a better number. The card's "should I open myself or
 * stay a tab" decision needed a score threshold, and any threshold I picked
 * would have been invented — the score is an unbounded weighted sum whose
 * scale means nothing on its own. With tiers the rule needs no number at all:
 * exact opens, inferred waits to be asked.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Not a replacement for the scorer. This covers a hand-written list of venues
 * and the mints they name; the whole rest of the web is still the scorer's
 * job, and always will be. Every venue added here is a place we chose to be
 * exactly right about, and the list is expected to grow one site at a time.
 */

/** Base58, Solana's alphabet: no 0, O, I or l. Mints are 32-44 characters. */
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

const BY_MINT = new Map<string, CuratedAsset>(
  CURATED_CATALOG.map((a) => [a.mint, a]),
);

/** Loose identity: case and punctuation carry no meaning across venues.
 *  "dogwifhat", "Dogwifhat" and "dog-wif-hat" are one thing. */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Every written form a venue might use for a catalog row.
 *
 * The tokenized-equity convention is the one non-obvious entry: xStocks and
 * friends suffix the underlying's ticker with an 'x' (TSLA → TSLAx), so a
 * venue naming the UNDERLYING has to reach the wrapper. That mapping is
 * spelled out rather than inferred with a fuzzy match, because "close enough"
 * on a money surface buys the wrong asset.
 */
const BY_NAME = new Map<string, CuratedAsset>();
for (const a of CURATED_CATALOG) {
  for (const form of [a.ticker, a.name, a.displayName]) {
    if (!form) continue;
    const k = norm(form);
    if (k && !BY_NAME.has(k)) BY_NAME.set(k, a);
  }
  // TSLAx is reachable as "tsla" — the ticker a stock venue actually prints.
  const t = norm(a.ticker);
  if (t.endsWith('x') && t.length > 2) {
    const underlying = t.slice(0, -1);
    if (!BY_NAME.has(underlying)) BY_NAME.set(underlying, a);
  }
}

/** Resolve one venue-supplied identifier: a mint, a ticker, or a slug. */
function resolveIdentifier(raw: string): CuratedAsset | null {
  if (!raw) return null;
  const direct = BY_MINT.get(raw);
  if (direct) return direct;
  return BY_NAME.get(norm(raw)) ?? null;
}

interface Venue {
  /** Host suffix, so www./m. and country subdomains all land. */
  host: string;
  /** Capture group 1 is the identifier. Anchored at a path segment so a
   *  search page or a listing cannot masquerade as an asset page. */
  path: RegExp;
  /**
   * A second spelling to try when the captured identifier does not resolve.
   *
   * Venue-specific ON PURPOSE rather than a general rule. The obvious general
   * version — "if it has a dash, also try the part after it" — would break
   * CoinGecko, where `dog-wif-hat` is one slug and its tail is `hat`. What is
   * true of one venue's address scheme is not true of the next, so each one
   * that needs a rewrite states its own.
   */
  alsoTry?: (raw: string) => string | null;
}

/**
 * The venues we choose to be exactly right about.
 *
 * Each pattern targets the site's DEDICATED page for one asset and nothing
 * else: not its search results, not its category listings, not its homepage
 * rails. A pattern that also matched a listing would hand the card a
 * confident answer on a page about forty assets, which is worse than the
 * inference it replaced.
 */
const VENUES: Venue[] = [
  // /en/coins/dogwifhat, /coins/dogwifhat — locale segment optional.
  { host: 'coingecko.com', path: /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/coins\/([^/?#]+)/i },
  { host: 'coinmarketcap.com', path: /^\/currencies\/([^/?#]+)/i },
  { host: 'yahoo.com', path: /^\/quote\/([^/?#]+)/i },
  // TradingView addresses a symbol as EXCHANGE-TICKER, and the bare form is
  // not a page you can be on: /symbols/TSLA/ answers 301 to
  // /symbols/NASDAQ-TSLA/ (verified live 2026-08-19). So the prefixed shape
  // is the ONLY one a reader ever sees, and until now the card never appeared
  // on TradingView at all — `NASDAQ-TSLA` normalises to `nasdaqtsla`, which
  // is nothing. The exchange is not ours to resolve; the ticker after it is.
  //
  // Splitting on the FIRST dash, not the last: the exchange is the prefix.
  // Everything after it is the venue's own symbol, dashes and all.
  {
    host: 'tradingview.com',
    path: /^\/symbols\/([^/?#]+)/i,
    alsoTry: (raw) => {
      const i = raw.indexOf('-');
      return i > 0 ? raw.slice(i + 1) : null;
    },
  },
  // These three name the MINT in the path, so resolveIdentifier hits BY_MINT.
  { host: 'birdeye.so', path: /^\/token\/([^/?#]+)/i },
  { host: 'solscan.io', path: /^\/token\/([^/?#]+)/i },
  { host: 'dexscreener.com', path: /^\/solana\/([^/?#]+)/i },
  // pump.fun names the MINT in the path (/coin/<mint>). A catalog hit
  // resolves here; a non-catalog one is caught by openMintFromUrl below
  // and admitted through the gate — pump.fun is where a memecoin is born,
  // and refusing to read its own address would be the whole point missed.
  { host: 'pump.fun', path: /^\/coin\/([^/?#]+)/i },
];

/**
 * MINT-IN-PATH venues: the captured segment IS the token's own mint, so a
 * NON-catalog hit is a real open mint we can admit — as opposed to
 * dexscreener/geckoterminal, whose path carries a POOL/PAIR address that
 * needs resolving before it names a token. Kept as a separate list so the
 * open-mint reader never mistakes a pair for a mint.
 */
const MINT_PATH_VENUES: Array<{ host: string; path: RegExp }> = [
  { host: 'birdeye.so', path: /^\/token\/([^/?#]+)/i },
  { host: 'solscan.io', path: /^\/token\/([^/?#]+)/i },
  { host: 'pump.fun', path: /^\/coin\/([^/?#]+)/i },
  // Dexscreener's /solana/<x> is AMBIGUOUS: <x> is a token mint on a token
  // page (dexscreener.com/solana/<mint>, verified live 2026-08-31) and a
  // pool on a pair page. Read it as a mint FIRST — the gate proves which:
  // a real mint admits, a pair fails and falls through to pairFromUrl.
  { host: 'dexscreener.com', path: /^\/solana\/([^/?#]+)/i },
];

/**
 * PAIR/POOL venues: the path names a market, not a mint. Reading the base
 * token out of it takes a network call (resolveDexPair), so these are
 * returned as a pair for the caller to resolve rather than admitted here.
 */
const PAIR_PATH_VENUES: Array<{ host: string; path: RegExp }> = [
  // Dexscreener is the FALLBACK when its segment did not admit as a mint.
  { host: 'dexscreener.com', path: /^\/solana\/([^/?#]+)/i },
  // geckoterminal.com/solana/pools/<pair> — always a pool, never a mint.
  { host: 'geckoterminal.com', path: /^\/solana\/pools\/([^/?#]+)/i },
];

/** Solana mint shape: a lone base58 run of exactly mint length. */
const MINT_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isMintShaped = (s: string): boolean => MINT_SHAPE.test(s);

/**
 * A MAXIMAL base58 run of exactly mint length — bounded by a non-base58
 * char (or string edge) on both sides. BASE58_RUN is capped at 44 and
 * unanchored, so a 46-char IPFS CID matched as its 44-char PREFIX and
 * passed isMintShaped; NFT/web3 pages are full of those. This rejects the
 * over-long run instead of truncating it into a false mint.
 */
const MINT_RUN =
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

/**
 * TIER 1 — the page's URL names the asset.
 *
 * Returns null for every URL that is not one of the dedicated shapes above,
 * including other pages on the same sites. Silence here costs nothing: the
 * scorer still gets its turn.
 */
export function matchByVenueUrl(rawUrl: string | undefined): CuratedAsset | null {
  if (!rawUrl) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  for (const v of VENUES) {
    // Suffix match on a DOT boundary: "notcoingecko.com" must not pass.
    if (host !== v.host && !host.endsWith(`.${v.host}`)) continue;
    const m = v.path.exec(u.pathname);
    if (!m) continue;
    const raw = decodeURIComponent(m[1]);
    // The address as written wins. `alsoTry` is a fallback, not a rewrite:
    // a catalog row that genuinely spells itself the venue's way keeps it.
    const alt = v.alsoTry?.(raw);
    const hit = resolveIdentifier(raw) ?? (alt ? resolveIdentifier(alt) : null);
    if (hit) return hit;
  }
  return null;
}

/**
 * TIER 0 — the page prints a mint we hold in the catalog.
 *
 * The strongest signal available in crypto and the cheapest to read: an
 * asset page shows its own contract address, so the identifier is sitting in
 * the text as an exact string. No scoring, no ambiguity — a 32-44 character
 * base58 run either IS one of our mints or it is not.
 *
 * ONE MINT ONLY. A page listing several catalog mints (a portfolio tracker, a
 * "top movers" table) is not about any one of them, and answering with
 * whichever appeared first would be the confident version of a coin flip.
 * Ambiguity here returns null and lets the scorer weigh the prose instead.
 */
export function matchByMintInText(text: string | undefined): CuratedAsset | null {
  if (!text) return null;
  const found = new Set<CuratedAsset>();
  for (const run of text.match(BASE58_RUN) ?? []) {
    const hit = BY_MINT.get(run);
    if (hit) found.add(hit);
    if (found.size > 1) return null;
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * A page-discovered OPEN (non-catalog) mint — the address a token wears on
 * its OWN venue page. Catalog mints are already answered by
 * matchByVenueUrl; this is the birdeye/solscan/pump.fun page of a coin the
 * catalog has never heard of, which is most of them.
 *
 * URL only, and only the mint-in-path venues: a mint sitting in a
 * dedicated token URL is the reader looking AT that token, which earns the
 * 'exact' auto-open. Returns the bare mint string for the caller to admit
 * through the gate; null for everything else.
 */
export function openMintFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  for (const v of MINT_PATH_VENUES) {
    if (host !== v.host && !host.endsWith(`.${v.host}`)) continue;
    const m = v.path.exec(u.pathname);
    if (!m) continue;
    const seg = decodeURIComponent(m[1]);
    // Catalog is matchByVenueUrl's job; this reader only answers for the
    // open mints it does not hold, and only when the segment is mint-shaped.
    if (isMintShaped(seg) && !BY_MINT.has(seg)) return seg;
  }
  return null;
}

/**
 * A dexscreener/geckoterminal PAIR the page's URL names, for the caller to
 * resolve to a base mint over the network. `{ pair }` or null; catalog
 * pairs that happen to equal a mint are left to matchByVenueUrl.
 */
export function pairFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  for (const v of PAIR_PATH_VENUES) {
    if (host !== v.host && !host.endsWith(`.${v.host}`)) continue;
    const m = v.path.exec(u.pathname);
    if (!m) continue;
    const seg = decodeURIComponent(m[1]);
    if (isMintShaped(seg) && !BY_MINT.has(seg)) return seg;
  }
  return null;
}

/**
 * EXACTLY ONE distinct non-catalog mint in the page's text — a Reddit
 * thread, a blog post, a Discord embed printing a single contract address.
 * Same one-mint discipline as matchByMintInText, and deliberately weaker:
 * a bare address in prose is the reader NEAR a token, not looking at its
 * page, so the caller gives it 'inferred' (the card is available, it does
 * not pop). Catalog mints disqualify the page from this reader — those are
 * matchByMintInText's, at 'exact'.
 */
export function openMintFromText(text: string | undefined): string | null {
  if (!text) return null;
  const open = new Set<string>();
  // MINT_RUN, not BASE58_RUN: a maximal 32-44 run, so an over-long base58
  // string (an IPFS CID, a base58 blob) is rejected whole rather than
  // truncated into a lookalike mint.
  for (const run of text.match(MINT_RUN) ?? []) {
    if (BY_MINT.has(run)) return null; // a catalog page; not ours to guess on
    open.add(run);
    if (open.size > 1) return null; // ambiguous, the confident coin flip
  }
  return open.size === 1 ? [...open][0] : null;
}
