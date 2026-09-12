import { describe, expect, it } from 'vitest';
import {
  readEnv,
  readEnvInt,
  readEnvList,
  readFeatureFlag,
  readSafetyFlag,
} from '../src/config/env';

/**
 * §14: "Deployed env values arrive with quotes, whitespace, mixed case. Do not
 * write `=== 'true'`." These are the exact shapes that broke the assumption in
 * the source service — and the two flag classes that need opposite handling.
 */

describe('readEnv', () => {
  it('trims whitespace and strips wrapping quotes', () => {
    expect(readEnv('  value  ')).toBe('value');
    expect(readEnv('"value"')).toBe('value');
    expect(readEnv("'value'")).toBe('value');
    expect(readEnv('  " value "  ')).toBe('value');
  });

  it('treats unset and empty as undefined', () => {
    expect(readEnv(undefined)).toBeUndefined();
    expect(readEnv(null)).toBeUndefined();
    expect(readEnv('')).toBeUndefined();
    expect(readEnv('   ')).toBeUndefined();
    expect(readEnv('""')).toBeUndefined();
  });

  it('leaves interior quotes alone', () => {
    expect(readEnv('a"b')).toBe('a"b');
  });
});

describe('readFeatureFlag — lenient, default OFF', () => {
  it('is off when unset or empty', () => {
    expect(readFeatureFlag(undefined)).toBe(false);
    expect(readFeatureFlag(null)).toBe(false);
    expect(readFeatureFlag('')).toBe(false);
    expect(readFeatureFlag('   ')).toBe(false);
  });

  it.each(['true', 'TRUE', ' True ', '"true"', "'true'", '1', 'yes', 'ON'])(
    'turns on for %p',
    (v) => {
      expect(readFeatureFlag(v)).toBe(true);
    },
  );

  it.each(['false', 'FALSE', '0', 'no', 'off', 'maybe', 'truthy'])(
    'stays off for %p',
    (v) => {
      expect(readFeatureFlag(v)).toBe(false);
    },
  );
});

describe('readSafetyFlag — strict, default ARMED', () => {
  /**
   * The original dry-run spec's it.each, carried over verbatim in intent: every
   * wrong, absent, typo'd or differently-cased value keeps the guard up. A test
   * that only checked the happy path would let a later refactor invert this and
   * stay green.
   */
  it.each([
    undefined,
    null,
    '',
    '   ',
    'true',
    'TRUE',
    'False',
    'FALSE',
    '0',
    'no',
    'off',
    'falsey',
    ' false',
    'false ',
    ' false ',
    '"false"',
    "'false'",
    'FaLsE',
  ])('stays ARMED for %p', (v) => {
    expect(readSafetyFlag(v)).toBe(true);
  });

  it("disarms ONLY for the exact string 'false'", () => {
    expect(readSafetyFlag('false')).toBe(false);
  });

  it('does not share readFeatureFlag’s leniency — this is the inversion guard', () => {
    // The single-parser bug: a lenient reader calls these false and takes the
    // protection down. Under readSafetyFlag they must all stay armed.
    for (const v of ['0', 'no', 'off', '"false"', ' false ']) {
      expect(readFeatureFlag(v)).toBe(false); // lenient reading: "off"
      expect(readSafetyFlag(v)).toBe(true); // strict reading: still armed
    }
  });
});

describe('readEnvInt', () => {
  it('parses with quotes and whitespace', () => {
    expect(readEnvInt(' "42" ', 0)).toBe(42);
  });

  it('applies the default on NaN and out-of-range', () => {
    expect(readEnvInt('abc', 7)).toBe(7);
    expect(readEnvInt('-1', 7, { min: 0 })).toBe(7);
    expect(readEnvInt('101', 7, { max: 100 })).toBe(7);
    expect(readEnvInt(undefined, 7)).toBe(7);
  });
});

describe('readEnvList', () => {
  it('splits, trims and drops empties', () => {
    expect(readEnvList(' a, b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(readEnvList('"a,b"')).toEqual(['a', 'b']);
    expect(readEnvList(undefined)).toEqual([]);
  });
});
