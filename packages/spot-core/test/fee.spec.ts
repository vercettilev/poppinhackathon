import { describe, expect, it } from 'vitest';
import {
  FEES_OFF,
  feeConfigFromEnv,
  rawToUsd,
  splitFee,
  usdToRaw,
} from '../src/route/fee';

describe('splitFee', () => {
  it('takes nothing when fees are off — the shipped §8 posture', () => {
    expect(splitFee(1_000_000n)).toEqual({ feeRaw: 0n, netRaw: 1_000_000n });
    expect(splitFee(1_000_000n, FEES_OFF)).toEqual({
      feeRaw: 0n,
      netRaw: 1_000_000n,
    });
  });

  it('splits exactly with BigInt division when a fee is configured', () => {
    const fee = { bps: 100, tokenAccount: 'FEEWALLET' };
    expect(splitFee(1_000_000n, fee)).toEqual({
      feeRaw: 10_000n,
      netRaw: 990_000n,
    });
  });

  it('rounds the fee DOWN, leaving the remainder with the user', () => {
    const fee = { bps: 100, tokenAccount: 'FEEWALLET' };
    // 999 * 100 / 10000 = 9.99 -> 9
    const { feeRaw, netRaw } = splitFee(999n, fee);
    expect(feeRaw).toBe(9n);
    expect(netRaw).toBe(990n);
    expect(feeRaw + netRaw).toBe(999n);
  });

  it('never loses a base unit — fee + net always reconstructs gross', () => {
    const fee = { bps: 137, tokenAccount: 'FEEWALLET' };
    for (const gross of [1n, 7n, 12_345n, 999_999_999n, 10n ** 12n]) {
      const { feeRaw, netRaw } = splitFee(gross, fee);
      expect(feeRaw + netRaw).toBe(gross);
    }
  });

  it('ignores a fee with no destination tokenAccount', () => {
    expect(splitFee(1_000_000n, { bps: 500 })).toEqual({
      feeRaw: 0n,
      netRaw: 1_000_000n,
    });
  });

  it('rejects a negative gross', () => {
    expect(() => splitFee(-1n, FEES_OFF)).toThrow(RangeError);
  });
});

describe('feeConfigFromEnv', () => {
  it('defaults to OFF with no env at all (§8)', () => {
    expect(feeConfigFromEnv({})).toEqual(FEES_OFF);
  });

  it('stays OFF when bps is set but no tokenAccount is configured', () => {
    expect(feeConfigFromEnv({ POPPIN_FEE_BPS: '100' })).toEqual(FEES_OFF);
  });

  it('stays OFF when a tokenAccount is set but bps is absent', () => {
    expect(feeConfigFromEnv({ POPPIN_FEE_TOKEN_ACCOUNT: 'W' })).toEqual(FEES_OFF);
  });

  it('enables only when both are present and valid', () => {
    expect(
      feeConfigFromEnv({ POPPIN_FEE_BPS: '100', POPPIN_FEE_TOKEN_ACCOUNT: 'W' }),
    ).toEqual({ bps: 100, tokenAccount: 'W' });
  });

  it('falls back to OFF on an out-of-range or unparseable bps', () => {
    const w = { POPPIN_FEE_TOKEN_ACCOUNT: 'W' };
    expect(feeConfigFromEnv({ ...w, POPPIN_FEE_BPS: '-5' })).toEqual(FEES_OFF);
    expect(feeConfigFromEnv({ ...w, POPPIN_FEE_BPS: '20000' })).toEqual(FEES_OFF);
    expect(feeConfigFromEnv({ ...w, POPPIN_FEE_BPS: 'abc' })).toEqual(FEES_OFF);
  });
});

describe('usd <-> raw', () => {
  it('round-trips whole and fractional dollars', () => {
    expect(usdToRaw(1)).toBe(1_000_000n);
    expect(usdToRaw(0.25)).toBe(250_000n);
    expect(rawToUsd(1_000_000n)).toBe(1);
    expect(rawToUsd(250_000n)).toBe(0.25);
  });

  it('rounds to the nearest base unit rather than truncating float noise', () => {
    // 0.1 + 0.2 style drift must not silently shave a base unit.
    expect(usdToRaw(0.1 + 0.2)).toBe(300_000n);
  });
});
