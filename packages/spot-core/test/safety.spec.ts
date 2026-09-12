import { describe, expect, it } from 'vitest';
import {
  OpenMintGate,
  type GateFailure,
  type SellRouteChecker,
} from '../src/safety/open-mint-gate';
import {
  resolveTickerFrom,
  type JupiterUltraTokenInfo,
  type UltraOutcome,
  type UltraSearchClient,
} from '../src/resolve/ultra';

/** Fields Ultra may simply not return; each one must fail the gate closed. */
type OmittableField = 'liquidity' | 'holderCount' | 'firstPool';

const MINT = 'BonkTokenMint1111111111111111111111111111111';
const NOW = Date.parse('2026-08-11T00:00:00Z');
const OLD_POOL = '2026-01-01T00:00:00Z';

/** A mint that passes every criterion; each test spoils exactly one. */
function healthy(over: Partial<JupiterUltraTokenInfo> = {}): JupiterUltraTokenInfo {
  return {
    id: MINT,
    name: 'Bonk',
    symbol: 'BONK',
    decimals: 5,
    liquidity: 4_200_000,
    mintAuthority: null,
    freezeAuthority: null,
    holderCount: 90_000,
    audit: { topHoldersPercentage: 12 },
    firstPool: { id: 'pool', createdAt: OLD_POOL },
    isVerified: true,
    ...over,
  };
}

class FakeUltra implements UltraSearchClient {
  calls = 0;
  constructor(
    private readonly outcome: UltraOutcome<JupiterUltraTokenInfo[]>,
  ) {}
  async search(): Promise<UltraOutcome<JupiterUltraTokenInfo[]>> {
    this.calls += 1;
    return this.outcome;
  }
}

class FakeSellRoute implements SellRouteChecker {
  calls = 0;
  constructor(private readonly sellable: boolean | Error = true) {}
  async canSell(): Promise<boolean> {
    this.calls += 1;
    if (this.sellable instanceof Error) throw this.sellable;
    return this.sellable;
  }
}

function gate(
  info: JupiterUltraTokenInfo | 'lookup_failed',
  sell: FakeSellRoute = new FakeSellRoute(true),
) {
  const ultra =
    info === 'lookup_failed'
      ? new FakeUltra({ ok: false, reason: 'timeout' })
      : new FakeUltra({ ok: true, value: [info] });
  return { gate: new OpenMintGate(ultra, sell, () => NOW), ultra, sell };
}

const failuresOf = async (
  info: JupiterUltraTokenInfo | 'lookup_failed',
  sell?: FakeSellRoute,
): Promise<GateFailure[]> => (await gate(info, sell).gate.evaluate(MINT)).failures;

describe('OpenMintGate — passes a clean mint', () => {
  it('accepts a mint meeting every criterion', async () => {
    const { gate: g } = gate(healthy());
    const v = await g.evaluate(MINT);
    expect(v.passed).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('assert() resolves for a passing mint', async () => {
    const { gate: g } = gate(healthy());
    await expect(g.assert(MINT)).resolves.toBeUndefined();
  });
});

describe('OpenMintGate — one criterion at a time', () => {
  it('rejects a thin pool', async () => {
    expect(await failuresOf(healthy({ liquidity: 900 }))).toContain(
      'insufficient_liquidity',
    );
  });

  it('rejects a retained mint authority', async () => {
    expect(await failuresOf(healthy({ mintAuthority: 'SomeAuthority' }))).toContain(
      'mint_authority_retained',
    );
  });

  it('rejects a retained freeze authority', async () => {
    expect(
      await failuresOf(healthy({ freezeAuthority: 'SomeAuthority' })),
    ).toContain('freeze_authority_retained');
  });

  it('rejects a pool younger than the minimum', async () => {
    const fresh = new Date(NOW - 60 * 60 * 1000).toISOString();
    expect(
      await failuresOf(healthy({ firstPool: { id: 'p', createdAt: fresh } })),
    ).toContain('pool_too_young');
  });

  it('rejects too few holders', async () => {
    expect(await failuresOf(healthy({ holderCount: 3 }))).toContain(
      'too_few_holders',
    );
  });

  it('rejects a mint with no sell route — the honeypot shape', async () => {
    expect(await failuresOf(healthy(), new FakeSellRoute(false))).toContain(
      'not_sellable',
    );
  });

  it('treats a throwing sell-route check as not sellable', async () => {
    const sell = new FakeSellRoute(new Error('jupiter down'));
    expect(await failuresOf(healthy(), sell)).toContain('not_sellable');
  });
});

describe('OpenMintGate — absent data is failure, never a pass', () => {
  // The field is DELETED rather than set to undefined: under
  // exactOptionalPropertyTypes those are different states, and the one Ultra
  // actually produces is an absent key.
  it.each<[OmittableField, GateFailure]>([
    ['liquidity', 'insufficient_liquidity'],
    ['holderCount', 'too_few_holders'],
    ['firstPool', 'pool_too_young'],
  ])('missing %s fails closed', async (field, expected) => {
    const info = healthy();
    delete info[field];
    expect(await failuresOf(info)).toContain(expected);
  });

  it('fails closed when the Ultra lookup itself fails', async () => {
    const v = await gate('lookup_failed').gate.evaluate(MINT);
    expect(v.passed).toBe(false);
    expect(v.failures).toEqual(['lookup_failed']);
  });

  it('fails closed when the mint is absent from the response', async () => {
    const ultra = new FakeUltra({ ok: true, value: [] });
    const g = new OpenMintGate(ultra, new FakeSellRoute(), () => NOW);
    expect((await g.evaluate(MINT)).failures).toEqual(['not_found']);
  });

  it('assert() throws RouteError(not_allowed) with the reasons attached', async () => {
    const { gate: g } = gate(healthy({ liquidity: 1 }));
    await expect(g.assert(MINT)).rejects.toMatchObject({
      failure: 'not_allowed',
    });
  });
});

describe('OpenMintGate — cost discipline', () => {
  it('does not price an exit for a mint that already failed on metadata', async () => {
    const sell = new FakeSellRoute(true);
    await gate(healthy({ liquidity: 1 }), sell).gate.evaluate(MINT);
    expect(sell.calls).toBe(0);
  });

  it('collects every metadata failure rather than stopping at the first', async () => {
    const failures = await failuresOf(
      healthy({ liquidity: 1, mintAuthority: 'A', holderCount: 0 }),
    );
    expect(failures).toEqual(
      expect.arrayContaining([
        'insufficient_liquidity',
        'mint_authority_retained',
        'too_few_holders',
      ]),
    );
  });
});

describe('resolveTickerFrom — §6: ambiguity resolves to nothing', () => {
  const bonk = healthy();
  const impostor = healthy({ id: 'Fake111', isVerified: false });

  it('resolves a single exact match', () => {
    expect(resolveTickerFrom('$BONK', [bonk])?.id).toBe(MINT);
  });

  it('strips the leading $ and ignores case', () => {
    expect(resolveTickerFrom('bonk', [bonk])?.id).toBe(MINT);
  });

  it('prefers the verified token when unverified ones share the symbol', () => {
    expect(resolveTickerFrom('$BONK', [impostor, bonk])?.id).toBe(MINT);
  });

  it('returns nothing when two verified tokens share a symbol', () => {
    const other = healthy({ id: 'Other111' });
    expect(resolveTickerFrom('$BONK', [bonk, other])).toBeUndefined();
  });

  /**
   * The launchpad reality the bare rule could not survive: every ticker that
   * works acquires copies within days. Measured on $BULLSHIT — $541k of
   * liquidity and 7,785 holders against $56 and 15 — where "two candidates"
   * was true and calling it a tie made the token untradeable.
   */
  it('drops candidates that could not pass the gate, then applies the rule', () => {
    const real = healthy({ id: 'Real111', isVerified: false });
    const copy = healthy({ id: 'Copy111', isVerified: false });
    const tradeable = (t: { id: string }) => t.id === 'Real111';
    // Without the filter this is a tie and answers nothing.
    expect(resolveTickerFrom('$BONK', [real, copy])).toBeUndefined();
    // With it, only one candidate was ever tradeable, so there is no tie.
    expect(resolveTickerFrom('$BONK', [real, copy], tradeable)?.id).toBe('Real111');
  });

  it('still answers nothing when TWO candidates could both be traded', () => {
    // The case the rule was written for survives untouched: a real
    // ambiguity between two viable tokens is still silence.
    const a = healthy({ id: 'A', isVerified: false });
    const b = healthy({ id: 'B', isVerified: false });
    expect(resolveTickerFrom('$BONK', [a, b], () => true)).toBeUndefined();
  });

  /**
   * The tiebreak past eligibility, measured on $Pistacio (2026-08-28):
   * THREE copies past the gate — $523k, $118k and $28k of liquidity, all
   * genuinely tradeable — but Jupiter's wash-trading detector had already
   * told them apart: 92.5/high against 0/low and 0/low. Exactly one
   * 'high' is the token and its imitators; two highs is a real ambiguity
   * and stays silence.
   */
  it('breaks an eligible tie on the ONE organically-high candidate', () => {
    const real = healthy({ id: 'Real111', isVerified: false, organicScoreLabel: 'high' });
    const copy1 = healthy({ id: 'Copy111', isVerified: false, organicScoreLabel: 'low' });
    const copy2 = healthy({ id: 'Copy222', isVerified: false, organicScoreLabel: 'low' });
    expect(resolveTickerFrom('$BONK', [copy1, real, copy2], () => true)?.id).toBe('Real111');
  });

  it('two organically-high candidates is still a genuine ambiguity', () => {
    const a = healthy({ id: 'A', isVerified: false, organicScoreLabel: 'high' });
    const b = healthy({ id: 'B', isVerified: false, organicScoreLabel: 'high' });
    expect(resolveTickerFrom('$BONK', [a, b], () => true)).toBeUndefined();
  });

  it('answers nothing when the filter rejects everyone', () => {
    expect(resolveTickerFrom('$BONK', [bonk], () => false)).toBeUndefined();
  });

  it('returns nothing when several unverified tokens share a symbol', () => {
    const a = healthy({ id: 'A', isVerified: false });
    const b = healthy({ id: 'B', isVerified: false });
    expect(resolveTickerFrom('$BONK', [a, b])).toBeUndefined();
  });

  it('returns nothing when no symbol matches', () => {
    expect(resolveTickerFrom('$WIF', [bonk])).toBeUndefined();
  });

  it('ignores near-misses rather than guessing', () => {
    const near = healthy({ id: 'N', symbol: 'BONKINU' });
    expect(resolveTickerFrom('$BONK', [near])).toBeUndefined();
  });

  it('returns nothing for an empty ticker', () => {
    expect(resolveTickerFrom('$', [bonk])).toBeUndefined();
  });
});
