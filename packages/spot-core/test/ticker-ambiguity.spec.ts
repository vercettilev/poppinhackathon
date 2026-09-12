import { describe, expect, it } from 'vitest';
import { DOMINANCE_MULTIPLE, resolveTickerFrom } from '../src/resolve/ultra';
import type { JupiterUltraTokenInfo } from '../src/resolve/ultra';

/**
 * WHICH TOKEN A `$TICKER` MEANS when several answer to the name.
 *
 * Every fixture below is a live measurement from 2026-08-30, taken while
 * widening the admission gate — which is how these two rules were found at
 * all. Loosening the gate lets MORE copies through, and because eligibility
 * runs before ambiguity, more copies meant more ties meant more silence:
 * the wider gate gained $SPX and lost $BILLY until these landed.
 */

const tok = (
  over: Partial<JupiterUltraTokenInfo> & { id: string },
): JupiterUltraTokenInfo =>
  ({
    symbol: 'X',
    isVerified: true,
    liquidity: 50_000,
    holderCount: 5_000,
    organicScoreLabel: 'low',
    ...over,
  }) as JupiterUltraTokenInfo;

describe('the organic-label tiebreak', () => {
  it('names the token when Jupiter scores it uniquely highest', () => {
    // $APU as measured: two eligible candidates 1.6x apart on liquidity —
    // far too close to separate by size — and Jupiter's own wash-trading
    // detector scoring the real one 'medium' against the copy's 'low'.
    const got = resolveTickerFrom('APU', [
      tok({ id: 'real', symbol: 'APU', liquidity: 19_160, holderCount: 1_432, organicScoreLabel: 'medium' }),
      tok({ id: 'copy', symbol: 'APU', liquidity: 12_358, holderCount: 821, organicScoreLabel: 'low' }),
    ]);
    expect(got?.id).toBe('real');
  });

  it('keeps two equal labels a tie, exactly as before', () => {
    expect(
      resolveTickerFrom('X', [
        tok({ id: 'a', organicScoreLabel: 'high' }),
        tok({ id: 'b', organicScoreLabel: 'high' }),
      ]),
    ).toBeUndefined();
  });

  it("treats 'low' as the absence of a signal, never as one", () => {
    // $ELIZA and $SNAI as measured: both candidates real, both scored
    // 'low'. Silence is the correct answer — money in the wrong ELIZA is
    // the harm this rule exists to prevent.
    expect(
      resolveTickerFrom('ELIZA', [
        tok({ id: 'a', symbol: 'ELIZA', liquidity: 65_757, holderCount: 22_832 }),
        tok({ id: 'b', symbol: 'ELIZA', liquidity: 45_571, holderCount: 12_202 }),
      ]),
    ).toBeUndefined();
    // A lone 'low' among unlabelled candidates wins nothing either.
    expect(
      resolveTickerFrom('X', [
        tok({ id: 'a', organicScoreLabel: 'low' }),
        tok({ id: 'b', organicScoreLabel: undefined }),
      ]),
    ).toBeUndefined();
  });
});

describe('the dominance tiebreak', () => {
  it('names the token that towers over its namesake on both axes', () => {
    // $BILLY as measured: 12.7x the liquidity and 11.7x the holders of the
    // copy that the widened gate had just made eligible. Both 'low', so
    // the label could not separate them; the size could.
    const got = resolveTickerFrom('BILLY', [
      tok({ id: 'real', symbol: 'BILLY', liquidity: 188_414, holderCount: 35_245 }),
      tok({ id: 'copy', symbol: 'BILLY', liquidity: 14_871, holderCount: 3_018 }),
    ]);
    expect(got?.id).toBe('real');
  });

  it('requires BOTH axes, so a lead on one is not identity', () => {
    // $SNAI as measured: 16.8x the holders but only 2.2x the liquidity.
    // One axis is luck; two is the token standing beside an imitator.
    expect(
      resolveTickerFrom('SNAI', [
        tok({ id: 'a', symbol: 'SNAI', liquidity: 65_822, holderCount: 25_447 }),
        tok({ id: 'b', symbol: 'SNAI', liquidity: 29_707, holderCount: 1_513 }),
      ]),
    ).toBeUndefined();
  });

  it('leaves a near-tie silent', () => {
    expect(
      resolveTickerFrom('X', [
        tok({ id: 'a', liquidity: 100_000, holderCount: 10_000 }),
        tok({
          id: 'b',
          liquidity: 100_000 / (DOMINANCE_MULTIPLE - 1),
          holderCount: 10_000 / (DOMINANCE_MULTIPLE - 1),
        }),
      ]),
    ).toBeUndefined();
  });

  it('never divides by a candidate with nothing to divide', () => {
    const got = resolveTickerFrom('X', [
      tok({ id: 'a', liquidity: 100_000, holderCount: 10_000 }),
      tok({ id: 'b', liquidity: 0, holderCount: 0 }),
    ]);
    expect(got).toBeUndefined();
  });
});

describe('what review found before this shipped', () => {
  it('a labelled minnow cannot take the ticker from a landslide', () => {
    // The worst kind of bug: no attacker needed. Jupiter's organic label
    // is not monotone in size — measured the same day, $APU scored
    // 'medium' at $19k of liquidity while $BILLY scored 'low' at $188k —
    // so without a size guard a small copy with a middling score simply
    // takes the cashtag, and a reader buys it from under a tweet about
    // the real token. Silence turning into WRONG TOKEN is the one
    // direction this function must never move.
    const got = resolveTickerFrom('X', [
      tok({ id: 'copy', liquidity: 9_000, holderCount: 160, organicScoreLabel: 'medium' }),
      tok({ id: 'real', liquidity: 900_000, holderCount: 90_000, organicScoreLabel: undefined }),
    ]);
    // Not merely silent: the size rule below then names the real one.
    expect(got?.id).toBe('real');
  });

  it('keeps the label decisive among peers', () => {
    // $APU, the case the rung exists for: 1.6x apart, and the labelled
    // one is also the larger. Nothing out-sizes it, so the label rules.
    expect(
      resolveTickerFrom('APU', [
        tok({ id: 'real', symbol: 'APU', liquidity: 19_160, holderCount: 1_432, organicScoreLabel: 'medium' }),
        tok({ id: 'copy', symbol: 'APU', liquidity: 12_358, holderCount: 821, organicScoreLabel: 'low' }),
      ])?.id,
    ).toBe('real');
  });

  it('cannot be beaten by a planted decoy', () => {
    // The $30k attack: size a third mint between yourself and the real
    // token so the real token is no longer the runner-up, and its holder
    // count — the fact that says which mint the tweet meant — is never
    // read. Comparing against the MAX of every other candidate is what
    // makes inserting a body between them worthless.
    const got = resolveTickerFrom('X', [
      tok({ id: 'imposter', liquidity: 250_000, holderCount: 1_500 }),
      tok({ id: 'decoy', liquidity: 30_000, holderCount: 200 }),
      tok({ id: 'real', liquidity: 20_000, holderCount: 30_000 }),
    ]);
    expect(got).toBeUndefined();
  });
});

describe('what neither tiebreak changes', () => {
  it('one candidate still wins outright', () => {
    expect(resolveTickerFrom('X', [tok({ id: 'only' })])?.id).toBe('only');
  });

  it('a verified candidate still shuts out the unverified', () => {
    const got = resolveTickerFrom('X', [
      tok({ id: 'ver', isVerified: true, liquidity: 10_000, holderCount: 100 }),
      tok({ id: 'unver', isVerified: false, liquidity: 900_000, holderCount: 90_000 }),
    ]);
    expect(got?.id).toBe('ver');
  });

  it('an unmatched symbol is still nothing', () => {
    expect(resolveTickerFrom('NOPE', [tok({ id: 'a', symbol: 'X' })])).toBeUndefined();
  });
});
