import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  ESTABLISHED_BAR,
  isEstablished,
  thresholdsFromEnv,
} from './open-mint-gate';

/**
 * THE WIDTH OF THE DOOR, pinned with the tokens that measured it.
 *
 * Every number here came from a live sweep on 2026-08-30 (Jupiter Ultra
 * search, exact-symbol matches). They are in this file so the next person
 * to move a threshold can see what moved with it.
 */

/** $APU as measured: refused by the old $25k floor, nothing else wrong. */
const APU = {
  liquidity: 19_160,
  holderCount: 1_432,
  ageMs: 2_060 * 60 * 60 * 1000,
  isVerified: false,
  organicScoreLabel: 'medium',
};

/** $SPX as measured: $45M, 70k holders, verified, organic 'high' — and a
 *  live mint authority, because SPX6900 reaches Solana across a bridge. */
const SPX = {
  liquidity: 3_001_956,
  holderCount: 70_333,
  isVerified: true,
  organicScoreLabel: 'high',
};

/** A fresh copycat from the same sweep: three holders, $3.3k, hours old. */
const COPYCAT = {
  liquidity: 3_313,
  holderCount: 3,
  ageMs: 8 * 60 * 60 * 1000,
  isVerified: false,
  organicScoreLabel: 'low',
};

const passesSize = (t: { liquidity: number; holderCount: number; ageMs: number }) =>
  t.liquidity >= DEFAULT_THRESHOLDS.minLiquidityUsd &&
  t.holderCount >= DEFAULT_THRESHOLDS.minHolderCount &&
  t.ageMs >= DEFAULT_THRESHOLDS.minPoolAgeMs;

describe('the widened size thresholds', () => {
  it('admits the small-but-real token the old floor refused', () => {
    // The owner's rule: "500k market cap bile olsa, orijinal tokenları
    // gösterirsek hiç problem olmaz." $APU is a tenth of that and still
    // a real token with 1,432 holders and an 86-day-old pool.
    expect(passesSize(APU)).toBe(true);
  });

  it('still refuses the fresh copycat', () => {
    // The population the thresholds exist to separate. Widening the door
    // must not be the same thing as removing it.
    expect(passesSize(COPYCAT)).toBe(false);
  });

  it('keeps a real floor rather than opening all the way', () => {
    expect(DEFAULT_THRESHOLDS.minLiquidityUsd).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.minHolderCount).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.minPoolAgeMs).toBeGreaterThan(0);
  });
});

describe('thresholds from the environment', () => {
  it('reads each field, converting hours to milliseconds', () => {
    expect(
      thresholdsFromEnv({
        SPOT_GATE_MIN_LIQUIDITY_USD: '1000',
        SPOT_GATE_MIN_HOLDERS: '50',
        SPOT_GATE_MIN_POOL_AGE_HOURS: '6',
      }),
    ).toEqual({
      minLiquidityUsd: 1000,
      minHolderCount: 50,
      minPoolAgeMs: 6 * 60 * 60 * 1000,
    });
  });

  it('ignores what it cannot parse rather than reading it as zero', () => {
    // A typo in a deploy variable must never silently open the gate all
    // the way — an ignored field falls back to the compiled default.
    expect(
      thresholdsFromEnv({
        SPOT_GATE_MIN_LIQUIDITY_USD: 'lots',
        SPOT_GATE_MIN_HOLDERS: '-5',
      }),
    ).toEqual({});
    expect(thresholdsFromEnv({})).toEqual({});
  });

  it('treats a DECLARED-BUT-EMPTY variable as unset', () => {
    // Review's catch: Number('') and Number('   ') are both 0, which
    // would have sailed through as an explicit "no floor at all" and
    // opened the gate completely — from a variable somebody merely
    // declared and never filled in.
    expect(
      thresholdsFromEnv({
        SPOT_GATE_MIN_LIQUIDITY_USD: '',
        SPOT_GATE_MIN_HOLDERS: '   ',
        SPOT_GATE_MIN_POOL_AGE_HOURS: '\t',
      }),
    ).toEqual({});
  });

  it('accepts an explicit zero, which is a choice and not a typo', () => {
    expect(thresholdsFromEnv({ SPOT_GATE_MIN_HOLDERS: '0' })).toEqual({
      minHolderCount: 0,
    });
  });
});

describe('the established exception to a retained mint authority', () => {
  it('forgives the bridge-minted head of the market', () => {
    // $SPX was refused at $45M with 70k holders because a bridge mints
    // against locked collateral. The shape says bridge, not printer.
    expect(isEstablished(SPX)).toBe(true);
  });

  it('forgives nothing smaller, quieter or unverified', () => {
    expect(isEstablished({ ...SPX, liquidity: 400_000 })).toBe(false);
    expect(isEstablished({ ...SPX, holderCount: 900 })).toBe(false);
    expect(isEstablished({ ...SPX, isVerified: false })).toBe(false);
    // $AI16Z as measured: verified, 97k holders — but 'medium' organic and
    // $38k of liquidity, so its live mint authority still refuses it.
    expect(
      isEstablished({
        liquidity: 38_239,
        holderCount: 97_832,
        isVerified: true,
        organicScoreLabel: 'medium',
      }),
    ).toBe(false);
  });

  it('treats absent fields as failures, never as passes', () => {
    expect(isEstablished({})).toBe(false);
    expect(isEstablished({ liquidity: 9e9, holderCount: 9e9 })).toBe(false);
  });

  it('keeps the bar high enough to be an exception', () => {
    expect(ESTABLISHED_BAR.minLiquidityUsd).toBeGreaterThanOrEqual(100_000);
    expect(ESTABLISHED_BAR.minHolderCount).toBeGreaterThanOrEqual(10_000);
    expect(ESTABLISHED_BAR.requireVerified).toBe(true);
    expect(ESTABLISHED_BAR.requireHighOrganic).toBe(true);
  });
});
