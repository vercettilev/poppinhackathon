/**
 * §5 step 1 — page signals to candidate entities.
 *
 * Runs on text the shell has already harvested and capped. It does no DOM work
 * and knows nothing about a browser, which is what makes it testable and what
 * keeps §14's "content script must never block rendering" a shell concern
 * rather than a matching concern.
 */

import { matchCatalogTerms, type EntityCandidate } from '../catalog/index';

export type { EntityCandidate };

/**
 * Base58, 32-44 chars. Solana addresses are the only thing on a page shaped
 * like this, but plenty of things are shaped like this and are not addresses:
 * transaction signatures (88 chars, excluded by the upper bound), block hashes,
 * and base58-looking substrings of longer tokens. The boundary assertions
 * matter more than the character class.
 */
const BASE58_ADDRESS = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

/** `$TICKER`: a dollar sign, a letter, then up to nine more alphanumerics. */
const TICKER = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

/**
 * Tickers that are almost always currency or a stock, not a Solana mint.
 * Matching these produces confident nonsense, which is worse than silence.
 */
const TICKER_STOPLIST = new Set([
  'USD', 'USDT', 'USDC', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'CHF',
]);

export interface TickerCandidate {
  symbol: string;
  count: number;
  /** Appeared in the title or a heading — the page is ABOUT this, not just
   *  mentioning it. Feeds the §5 intent step. */
  prominent: boolean;
}

export interface Candidates {
  addresses: string[];
  tickers: TickerCandidate[];
  /**
   * §6 path C. Catalog entity terms found on the page — "Nvidia", "SpaceX".
   *
   * Matched HERE, in the extractor, rather than in the worker, and that is a
   * privacy constraint rather than a layering preference: the content script
   * empties `text` before sending signals across the boundary (see STORE.md's
   * policy text — the page's words never leave the extension's own worker). So
   * anything that needs the page's prose has to read it on this side, and what
   * crosses is the resolved candidate, not the paragraph it came from.
   */
  entities: EntityCandidate[];
}

export interface ExtractInput {
  /** Visible body text, already capped by the shell. */
  text: string;
  /** Page title plus any headings, kept separate so prominence is knowable. */
  headline?: string;
  /**
   * The page URL.
   *
   * Explorer and token pages — solscan, birdeye, dexscreener — carry the mint
   * HERE and render it truncated in the body ("DezXAZ…pPB263"). Scanning only
   * visible text makes us blind on exactly the pages most likely to imply
   * intent, which is what shipped: a solscan token page produced zero
   * candidates and never reached the matcher at all.
   */
  url?: string;
}

export const DEFAULT_TEXT_CAP = 20_000;
const URL_CAP = 2_000;

/**
 * Percent-decoded, because `x.com/search?q=%24BONK` is a real ticker mention
 * and `%24` is where it hides. Malformed encoding decodes to itself rather
 * than throwing.
 */
function decodeUrl(raw: string | undefined): string {
  if (!raw) return '';
  const capped = raw.slice(0, URL_CAP);
  try {
    return decodeURIComponent(capped);
  } catch {
    return capped;
  }
}

export function extractCandidates(input: ExtractInput): Candidates {
  const text = input.text.slice(0, DEFAULT_TEXT_CAP);
  const headline = (input.headline ?? '').slice(0, 1_000);
  const url = decodeUrl(input.url);
  const haystack = `${headline}\n${text}`;

  // The URL is searched separately rather than concatenated, so a match there
  // can be weighted differently: a mint in the path means the page IS that
  // token, which is a stronger claim than a mention in the body.
  const addresses = [
    ...new Set([
      ...(haystack.match(BASE58_ADDRESS) ?? []),
      ...(url.match(BASE58_ADDRESS) ?? []),
    ]),
  ];

  const counts = new Map<string, number>();
  for (const m of `${haystack}\n${url}`.matchAll(TICKER)) {
    const sym = m[1]!.toUpperCase();
    if (TICKER_STOPLIST.has(sym)) continue;
    counts.set(sym, (counts.get(sym) ?? 0) + 1);
  }

  // A ticker in the URL is at least as strong a signal as one in the title.
  //
  // NOTE what is deliberately NOT done: a bare path segment is never read as a
  // ticker. `/coins/bonk` would be a correct match and `/blog/news`,
  // `/docs/intro`, `/about/team` would all be confident nonsense from the same
  // rule. §5 makes silence the default, so the `$` stays required.
  const headlineSymbols = new Set(
    [...`${headline}\n${url}`.matchAll(TICKER)].map((m) => m[1]!.toUpperCase()),
  );

  const tickers: TickerCandidate[] = [...counts.entries()]
    .map(([symbol, count]) => ({
      symbol,
      count,
      prominent: headlineSymbols.has(symbol),
    }))
    // Most-discussed first: if a page mentions several, the one it is actually
    // about is nearly always the one it repeats.
    .sort((a, b) => Number(b.prominent) - Number(a.prominent) || b.count - a.count);

  // The URL is NOT searched for catalog terms. A ticker in a path is a claim
  // about the page's subject; a company name in a path is usually a publisher's
  // taxonomy — /tech/nvidia/, /tag/spacex/ — and reading those as intent would
  // fire on every index page a news site has.
  const entities = matchCatalogTerms({ text, headline });

  return { addresses, tickers, entities };
}
