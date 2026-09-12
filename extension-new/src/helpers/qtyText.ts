/**
 * HOW MUCH OF A THING, WRITTEN SO IT IS NOT A LIE.
 *
 * One rule, in one place, because it was learned twice and applied once.
 *
 * TradeHistory worked it out first and wrote the reason down: four fraction
 * digits print any quantity under 0.00005 as zero, which turns a receipt into
 * a claim that nothing was traded at a price. The inline buy under a tweet
 * never got the memo, and on 2026-09-11 a real $1.00 purchase of Bitcoin
 * — 0.0000127 WBTC at $78,968 — came back as:
 *
 *     ✓ $1.00 → 0 WBTC
 *
 * Money moved, the chain agreed, and the only sentence the reader got said
 * they had received nothing. Every high-priced asset does this: the catalog
 * now resolves $BTC properly, which is precisely what made it visible.
 *
 * Three bands, and the reason for each:
 *
 *   >= 1000   no fraction at all. Nobody reads 1,240.0000 ORE, and the
 *             fourth decimal of a thousand-unit position is noise.
 *   >= 1      four fractions. The ordinary case, and the one place a
 *             trailing digit carries information a reader acts on.
 *   < 1       significant digits, not fractions. This is the band that was
 *             broken: what matters below one is the first few digits that
 *             are not zero, however far down they start.
 */
export const qtyText = (n: number): string =>
  n >= 1000
    ? n.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : n >= 1
      ? n.toLocaleString("en-US", { maximumFractionDigits: 4 })
      : n.toLocaleString("en-US", { maximumSignificantDigits: 4 })
