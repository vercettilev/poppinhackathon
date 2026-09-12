import { describe, expect, it } from 'vitest';
import { extractCandidates, DEFAULT_TEXT_CAP } from '../src/context/extract';
import { assessIntent } from '../src/intent/index';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('extractCandidates', () => {
  it('finds a bare contract address', () => {
    const c = extractCandidates({ text: `buy it here: ${BONK} now` });
    expect(c.addresses).toEqual([BONK]);
  });

  it('does not match a base58 run embedded in a longer token', () => {
    const c = extractCandidates({ text: `xx${BONK}xx` });
    expect(c.addresses).toEqual([]);
  });

  it('ignores a transaction signature, which is longer than any address', () => {
    const sig = '5'.repeat(88);
    expect(extractCandidates({ text: sig }).addresses).toEqual([]);
  });

  it('de-duplicates a repeated address', () => {
    const c = extractCandidates({ text: `${BONK} ... ${BONK}` });
    expect(c.addresses).toHaveLength(1);
  });

  it('counts ticker mentions and normalises case', () => {
    const c = extractCandidates({ text: '$bonk is up. $BONK again. $Bonk.' });
    expect(c.tickers[0]).toMatchObject({ symbol: 'BONK', count: 3 });
  });

  it('marks a headline ticker as prominent', () => {
    const c = extractCandidates({ headline: 'Why $WIF matters', text: 'some body' });
    expect(c.tickers[0]).toMatchObject({ symbol: 'WIF', prominent: true });
  });

  it('drops stablecoin and fiat tickers', () => {
    const c = extractCandidates({ text: 'priced in $USDC and $USD and $EUR' });
    expect(c.tickers).toEqual([]);
  });

  it('ranks the prominent ticker above a more-mentioned one', () => {
    const c = extractCandidates({
      headline: '$WIF',
      text: '$BONK $BONK $BONK $WIF',
    });
    expect(c.tickers[0]?.symbol).toBe('WIF');
  });

  it('caps the text it scans', () => {
    const padding = 'x'.repeat(DEFAULT_TEXT_CAP);
    const c = extractCandidates({ text: `${padding} ${BONK}` });
    expect(c.addresses).toEqual([]);
  });
});

/**
 * The shape that shipped broken: the mint lives in the URL and the body shows
 * it truncated, which is every Solana explorer and every token page.
 */
describe('extractCandidates — the URL is part of the page', () => {
  it('finds a mint that appears ONLY in the URL', () => {
    const c = extractCandidates({
      url: `https://solscan.io/token/${BONK}`,
      text: 'Address: DezXAZ…pPB263 Price Holders Transfers',
      headline: 'Bonk',
    });
    expect(c.addresses).toEqual([BONK]);
  });

  it('handles the birdeye and dexscreener shapes', () => {
    for (const url of [
      `https://birdeye.so/token/${BONK}?chain=solana`,
      `https://dexscreener.com/solana/${BONK}`,
      `https://solscan.io/token/${BONK}#holders`,
    ]) {
      expect(extractCandidates({ url, text: 'chart' }).addresses).toEqual([BONK]);
    }
  });

  it('does not double-count a mint present in both URL and body', () => {
    const c = extractCandidates({
      url: `https://solscan.io/token/${BONK}`,
      text: `full address ${BONK} here`,
    });
    expect(c.addresses).toEqual([BONK]);
  });

  it('decodes percent-encoded tickers, e.g. a search query', () => {
    const c = extractCandidates({
      url: 'https://x.com/search?q=%24BONK',
      text: 'timeline',
    });
    expect(c.tickers[0]).toMatchObject({ symbol: 'BONK', prominent: true });
  });

  it('treats a URL ticker as prominent, like a headline', () => {
    const c = extractCandidates({ url: 'https://site/?tag=$WIF', text: 'body' });
    expect(c.tickers[0]).toMatchObject({ symbol: 'WIF', prominent: true });
  });

  it('never reads a bare path segment as a ticker', () => {
    // The rule that keeps §5's silence intact: without the `$`, /blog/news and
    // /docs/intro would both produce confident nonsense.
    const c = extractCandidates({
      url: 'https://site.com/blog/news/intro/about/team/pricing',
      text: 'an article about nothing tradable',
    });
    expect(c.tickers).toEqual([]);
    expect(c.addresses).toEqual([]);
  });

  it('survives a malformed percent-encoding rather than throwing', () => {
    expect(() =>
      extractCandidates({ url: 'https://site.com/%E0%A4%A', text: 'x' }),
    ).not.toThrow();
  });

  it('caps the URL it scans', () => {
    const c = extractCandidates({
      url: `https://site.com/${'x'.repeat(2_100)}/${BONK}`,
      text: 'body',
    });
    expect(c.addresses).toEqual([]);
  });
});

describe('assessIntent — §5: silence is the default', () => {
  it('acts on a contract address with a single occurrence', () => {
    const v = assessIntent({ addresses: [BONK], tickers: [], entities: [] });
    expect(v).toEqual({ act: true, entity: { kind: 'address', value: BONK } });
  });

  it('prefers an address over any ticker on the same page', () => {
    const v = assessIntent({
      addresses: [BONK],
      tickers: [{ symbol: 'WIF', count: 9, prominent: true }],
      entities: [],
    });
    expect(v).toMatchObject({ entity: { kind: 'address' } });
  });

  it('stays silent with nothing to go on', () => {
    expect(assessIntent({ addresses: [], tickers: [], entities: [] })).toEqual({
      act: false,
      reason: 'no_entity',
    });
  });

  it('refuses a single passing ticker mention', () => {
    const v = assessIntent({
      addresses: [],
      tickers: [{ symbol: 'BONK', count: 1, prominent: false }],
      entities: [],
    });
    expect(v).toEqual({ act: false, reason: 'no_intent' });
  });

  it('acts on a ticker the page is visibly about', () => {
    const v = assessIntent({
      addresses: [],
      tickers: [{ symbol: 'BONK', count: 1, prominent: true }],
      entities: [],
    });
    expect(v).toMatchObject({ entity: { kind: 'ticker', value: 'BONK' } });
  });

  it('acts on a ticker discussed repeatedly', () => {
    const v = assessIntent({
      addresses: [],
      tickers: [{ symbol: 'BONK', count: 2, prominent: false }],
      entities: [],
    });
    expect(v).toMatchObject({ entity: { kind: 'ticker', value: 'BONK' } });
  });

  it('stays silent on a market roundup with two equal candidates', () => {
    const v = assessIntent({
      addresses: [],
      tickers: [
        { symbol: 'BONK', count: 3, prominent: false },
        { symbol: 'WIF', count: 3, prominent: false },
      ],
      entities: [],
    });
    expect(v).toEqual({ act: false, reason: 'low_confidence' });
  });

  it('acts when one candidate clearly dominates', () => {
    const v = assessIntent({
      addresses: [],
      tickers: [
        { symbol: 'BONK', count: 8, prominent: false },
        { symbol: 'WIF', count: 2, prominent: false },
      ],
      entities: [],
    });
    expect(v).toMatchObject({ entity: { kind: 'ticker', value: 'BONK' } });
  });

  it('acts when only one candidate is in the headline', () => {
    const v = assessIntent({
      addresses: [],
      tickers: [
        { symbol: 'BONK', count: 2, prominent: true },
        { symbol: 'WIF', count: 5, prominent: false },
      ],
      entities: [],
    });
    expect(v).toMatchObject({ entity: { kind: 'ticker', value: 'BONK' } });
  });

  it('ignores uncorroborated rivals when picking a winner', () => {
    const v = assessIntent({
      addresses: [],
      tickers: [
        { symbol: 'BONK', count: 4, prominent: false },
        { symbol: 'WIF', count: 1, prominent: false },
      ],
      entities: [],
    });
    expect(v).toMatchObject({ entity: { kind: 'ticker', value: 'BONK' } });
  });
});
