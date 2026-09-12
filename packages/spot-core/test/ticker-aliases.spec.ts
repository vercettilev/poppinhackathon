import { describe, expect, it } from 'vitest';
import {
  CURATED_CATALOG,
  curatedByTicker,
  curatedTickerAliases,
} from '../src/catalog/index';

/**
 * "BTC $0.01540 ▲81.7%" UNDER A TWEET ABOUT BITCOIN.
 *
 * Reported on 2026-09-11. Bitcoin IS in this catalog — WBTC (Portal), 28M of
 * liquidity, 80k holders — but BY_TICKER is keyed on the on-chain symbol, and
 * nobody writes the on-chain symbol. `$BTC` missed the catalog entirely, fell
 * through to open search, and a memecoin squatting the ticker won the chip.
 *
 * Every tokenized equity had the same hole: TSLAx, NVDAx, SPYx, QQQx and
 * thirteen more were unreachable by the four letters a reader writes. The
 * curated catalog exists to be the authority on assets like these, and its
 * front door did not open for their names.
 *
 * These tests are about the RULES, not the table. The table will grow; the
 * rules are what keep it from letting a decoy in.
 */
describe('the ticker a reader writes', () => {
  it('resolves $BTC to the catalog Bitcoin, not to whatever calls itself BTC', () => {
    const btc = curatedByTicker('BTC');
    expect(btc?.ticker).toBe('WBTC');
    expect(btc?.displayName).toBe('Bitcoin');
    expect(btc?.mint).toBe('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');
    // With or without the dollar, the way both callers pass it.
    expect(curatedByTicker('$BTC')?.mint).toBe(btc?.mint);
    expect(curatedByTicker('btc')?.mint).toBe(btc?.mint);
  });

  it('resolves the tokenized equities by their underlying ticker', () => {
    for (const [written, onChain] of [
      ['TSLA', 'TSLAx'],
      ['NVDA', 'NVDAx'],
      ['SPY', 'SPYx'],
      ['QQQ', 'QQQx'],
      ['AAPL', 'AAPLx'],
      ['COIN', 'COINx'],
      ['HOOD', 'HOODx'],
    ] as const) {
      expect(curatedByTicker(written)?.ticker).toBe(onChain);
    }
  });

  it('resolves the wrapped assets through the symbol their ticker contains', () => {
    expect(curatedByTicker('XRP')?.ticker).toBe('wXRP');
  });

  it('NEVER lets an alias shadow a real ticker', () => {
    // $META is MetaDAO, whose on-chain symbol is literally META. The Meta
    // xStock's derived alias must lose, or a cashtag for one asset buys
    // another one.
    const meta = curatedByTicker('META');
    expect(meta?.ticker).toBe('META');
    expect(meta?.name).toBe('MetaDAO');
    expect(curatedTickerAliases().has('meta')).toBe(false);
  });

  it('refuses brand names, which belong to entity matching and not to cashtags', () => {
    // $STARSHIP, $TESLA and $NASDAQ are real and unrelated tokens. The
    // containment test is what keeps them out: a term is only an alias when
    // the entry's own ticker contains it.
    for (const brand of ['STARSHIP', 'STARLINK', 'SPACEX', 'TESLA', 'NASDAQ', 'NVIDIA', 'ROBINHOOD', 'MICRON']) {
      expect(curatedTickerAliases().has(brand.toLowerCase())).toBe(false);
    }
  });

  it('drops any alias two entries could claim', () => {
    const aliases = curatedTickerAliases();
    const byTicker = new Map(
      CURATED_CATALOG.map((a) => [a.ticker.replace(/^\$/, '').trim().toLowerCase(), a]),
    );
    for (const [alias, asset] of aliases) {
      // No alias collides with a real ticker...
      expect(byTicker.has(alias)).toBe(false);
      // ...and each one names exactly one asset.
      expect(asset.mint).toBeTruthy();
    }
  });

  it('leaves every real ticker answering exactly as before', () => {
    for (const a of CURATED_CATALOG) {
      const written = a.ticker.replace(/^\$/, '').trim();
      expect(curatedByTicker(written)?.mint).toBe(a.mint);
    }
  });
});
