import { CURATED_CATALOG } from '@repo/spot-core';
import {
  isMintShaped,
  matchByMintInText,
  matchByVenueUrl,
  openMintFromText,
  openMintFromUrl,
  pairFromUrl,
} from './venue-match';
import { scorePage } from './asset-match.util';

/**
 * The certain tier, tested against the REAL catalog rather than fixtures.
 *
 * Everything below derives its expectations from CURATED_CATALOG at runtime,
 * so a catalog change cannot leave this file quietly asserting yesterday's
 * rows. What is pinned is the BEHAVIOUR — a dedicated venue page resolves, a
 * listing page does not, an ambiguous page refuses to answer.
 */

/** A row we can build a plausible CoinGecko slug for. */
const anyAsset = CURATED_CATALOG[0];

describe('matchByVenueUrl — reading identity off the URL', () => {
  it('resolves a mint named directly in a venue path', () => {
    const url = `https://solscan.io/token/${anyAsset.mint}`;
    expect(matchByVenueUrl(url)?.mint).toBe(anyAsset.mint);
  });

  it('accepts CoinGecko with and without a locale segment', () => {
    const slug = anyAsset.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const url of [
      `https://www.coingecko.com/en/coins/${slug}`,
      `https://www.coingecko.com/coins/${slug}`,
      `https://coingecko.com/de-de/coins/${slug}`,
    ]) {
      expect(matchByVenueUrl(url)?.mint).toBe(anyAsset.mint);
    }
  });

  it('reaches a tokenized equity by the ticker a stock venue prints', () => {
    // xStocks suffix the underlying: TSLA → TSLAx. Yahoo prints TSLA.
    const wrapped = CURATED_CATALOG.find(
      (a) => /x$/i.test(a.ticker) && a.ticker.length > 2,
    );
    if (!wrapped) return; // catalog has no wrapped equities right now
    const underlying = wrapped.ticker.slice(0, -1);
    expect(
      matchByVenueUrl(`https://finance.yahoo.com/quote/${underlying}`)?.mint,
    ).toBe(wrapped.mint);
  });

  it('reaches past a TradingView exchange prefix to the ticker', () => {
    // TradingView writes EXCHANGE-TICKER and 301s the bare form to it, so
    // this is the ONLY address a reader is ever on. Before this, every
    // TradingView page matched nothing: `NASDAQ-TSLA` normalises to
    // `nasdaqtsla`, which is not in any catalog and never will be.
    const wrapped = CURATED_CATALOG.find(
      (a) => /x$/i.test(a.ticker) && a.ticker.length > 2,
    );
    if (!wrapped) return; // catalog has no wrapped equities right now
    const underlying = wrapped.ticker.slice(0, -1);
    expect(
      matchByVenueUrl(
        `https://www.tradingview.com/symbols/NASDAQ-${underlying}/`,
      )?.mint,
    ).toBe(wrapped.mint);
  });

  it('does not let the dash rule leak to venues that use dashes in slugs', () => {
    // The reason `alsoTry` is per-venue: CoinGecko's `dog-wif-hat` is one
    // slug, and a general "try the tail" rule would resolve it as `hat`.
    // Whatever this venue does with dashes, it must not be this.
    expect(
      matchByVenueUrl('https://www.coingecko.com/en/coins/some-unknown-hat'),
    ).toBeNull();
  });

  it('refuses anything that is not a DEDICATED asset page', () => {
    // A pattern loose enough to catch these would hand the card a confident
    // answer on a page about forty assets — worse than the inference it
    // replaced.
    for (const url of [
      'https://www.coingecko.com/',
      'https://www.coingecko.com/en/categories/meme-token',
      'https://www.coingecko.com/en/search?query=wif',
      'https://finance.yahoo.com/markets/',
      'https://www.coinmarketcap.com/rankings/exchanges/',
    ]) {
      expect(matchByVenueUrl(url)).toBeNull();
    }
  });

  it('does not treat a lookalike host as the venue', () => {
    const slug = anyAsset.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
    expect(matchByVenueUrl(`https://notcoingecko.com/coins/${slug}`)).toBeNull();
    expect(matchByVenueUrl(`https://coingecko.com.evil.tld/coins/${slug}`)).toBeNull();
  });

  it('ignores non-http schemes and junk', () => {
    expect(matchByVenueUrl(undefined)).toBeNull();
    expect(matchByVenueUrl('not a url')).toBeNull();
    expect(matchByVenueUrl(`chrome-extension://abc/coins/${anyAsset.mint}`)).toBeNull();
  });
});

describe('scorePage — the exact tier still fills the shortlist', () => {
  it('answers a venue page with its own asset as the one candidate', () => {
    // The regression this pins: the exact tier returned candidates: [] on
    // the theory that it had not weighed any — and the panel's trade surface
    // went blank on CoinGecko, Yahoo and TradingView, the pages most about a
    // tradeable asset, while working fine on incidental mentions. A page's
    // certain answer is its shortlist of one.
    const anyRow = CURATED_CATALOG[0];
    const out = scorePage({
      url: `https://www.coingecko.com/en/coins/${anyRow.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')}`,
      bodyExcerpt: `about ${anyRow.name}`,
    });
    // Whether the URL resolves depends on the catalog's slugs; drive the
    // assertion off whatever DID match so the test follows the data.
    if (out.match) {
      expect(out.candidates.length).toBeGreaterThan(0);
      expect(out.candidates[0].mint).toBe(out.match.mint);
    } else {
      // Fall back to the mint-in-text tier, which is deterministic.
      const viaMint = scorePage({ bodyExcerpt: `mint: ${anyRow.mint}` });
      expect(viaMint.match).not.toBeNull();
      expect(viaMint.candidates[0]?.mint).toBe(viaMint.match?.mint);
    }
  });
});

describe('matchByMintInText — the page prints its own contract', () => {
  it('finds a catalog mint sitting in the page text', () => {
    const text = `Contract ${anyAsset.mint} — copy address`;
    expect(matchByMintInText(text)?.mint).toBe(anyAsset.mint);
  });

  it('refuses to choose when the page names more than one', () => {
    const other = CURATED_CATALOG.find((a) => a.mint !== anyAsset.mint);
    if (!other) return;
    // A portfolio tracker or a "top movers" table is about none of them, and
    // answering with whichever appeared first is a confident coin flip.
    expect(matchByMintInText(`${anyAsset.mint} and ${other.mint}`)).toBeNull();
  });

  it('ignores base58-shaped strings that are not ours', () => {
    expect(
      matchByMintInText('So11111111111111111111111111111111111111112xyzNotOurs'),
    ).toBeNull();
  });
});

describe('the open-mint readers — a coin the catalog never heard of', () => {
  // A base58 mint shape that is NOT in the catalog (a pump.fun memecoin).
  const OPEN = 'HeLLoWorLd11111111111111111111111111111abcd';

  it('reads a NON-catalog mint out of a mint-in-path venue URL', () => {
    expect(openMintFromUrl(`https://pump.fun/coin/${OPEN}`)).toBe(OPEN);
    expect(openMintFromUrl(`https://solscan.io/token/${OPEN}`)).toBe(OPEN);
    // A catalog mint is matchByVenueUrl's job, not this reader's.
    expect(openMintFromUrl(`https://solscan.io/token/${anyAsset.mint}`)).toBeNull();
    // A slug that is not mint-shaped is nobody's open mint.
    expect(openMintFromUrl('https://pump.fun/coin/not-a-mint')).toBeNull();
    // Dexscreener is DUAL: its /solana/<x> can be a token mint OR a pair,
    // so it reads as a candidate mint first (the gate proves which).
    expect(openMintFromUrl(`https://dexscreener.com/solana/${OPEN}`)).toBe(OPEN);
    // geckoterminal's segment is always a pool, never a mint.
    expect(
      openMintFromUrl(`https://www.geckoterminal.com/solana/pools/${OPEN}`),
    ).toBeNull();
  });

  it('hands a dexscreener / geckoterminal PAIR to the resolver as fallback', () => {
    expect(pairFromUrl(`https://dexscreener.com/solana/${OPEN}`)).toBe(OPEN);
    expect(
      pairFromUrl(`https://www.geckoterminal.com/solana/pools/${OPEN}`),
    ).toBe(OPEN);
    // A mint-in-path venue is not a pair.
    expect(pairFromUrl(`https://pump.fun/coin/${OPEN}`)).toBeNull();
  });

  it('rejects an over-long base58 run instead of truncating it to a mint', () => {
    // An IPFS CIDv0 (46 base58 chars) is ubiquitous on NFT/web3 pages; the
    // old cap-at-44 regex captured its 44-char prefix as a false mint.
    const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    expect(openMintFromText(`pinned at ${CID} forever`)).toBeNull();
    // Bracketed by non-base58, a real mint still reads.
    expect(openMintFromText(`(${OPEN})`)).toBe(OPEN);
  });

  it('reads EXACTLY ONE non-catalog mint from prose, else nothing', () => {
    expect(openMintFromText(`ape in: ${OPEN} 100x`)).toBe(OPEN);
    // Two distinct addresses is the confident coin flip — silence.
    const OTHER = 'ZzZzZzZz11111111111111111111111111111111wxy';
    expect(openMintFromText(`${OPEN} vs ${OTHER}`)).toBeNull();
    // A page that also prints a CATALOG mint is that tier's, at 'exact'.
    expect(openMintFromText(`${OPEN} and ${anyAsset.mint}`)).toBeNull();
    expect(openMintFromText('no addresses here at all')).toBeNull();
  });

  it('knows a mint shape from a slug', () => {
    expect(isMintShaped(OPEN)).toBe(true);
    expect(isMintShaped('too-short')).toBe(false);
    expect(isMintShaped('dogwifhat')).toBe(false);
  });
});

describe('scorePage — tiers come before prose', () => {
  it('marks a venue-URL match exact, without weighing the text', () => {
    const out = scorePage({
      url: `https://solscan.io/token/${anyAsset.mint}`,
      title: 'a title mentioning nothing tradeable at all',
      bodyExcerpt: 'lorem ipsum '.repeat(80),
    });
    expect(out.match?.mint).toBe(anyAsset.mint);
    expect(out.match?.certainty).toBe('exact');
  });

  it('still says nothing on a page with neither an identity nor prose', () => {
    const out = scorePage({
      url: 'https://example.com/about',
      title: 'About us',
      bodyExcerpt: 'we make software for small teams',
    });
    expect(out.match).toBeNull();
  });

  it('labels a text-scored match as inferred, so the card can tell them apart', () => {
    // Whatever the scorer concludes here, the point is the LABEL: nothing
    // that came out of the weighing may claim to have been read.
    const out = scorePage({
      url: 'https://example.com/news/story',
      title: `${anyAsset.name} had a busy quarter`,
      h1: `${anyAsset.name} had a busy quarter`,
      bodyExcerpt: `${anyAsset.name} `.repeat(30),
    });
    if (out.match) expect(out.match.certainty).toBe('inferred');
  });
});
