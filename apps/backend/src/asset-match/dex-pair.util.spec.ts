import { resolveDexPairBaseMint } from './dex-pair.util';

/**
 * The pair resolver runs behind a PUBLIC route with an attacker-controllable
 * pair, so the guards that bound its cost are the point of the test: it
 * returns the base token, never a quote token, caches the answer, and the
 * outbound rate cap refuses rather than fans out.
 */
const okResponse = (address: string) => ({
  ok: true,
  json: async () => ({ pairs: [{ baseToken: { address } }] }),
});

describe('resolveDexPairBaseMint', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns the base token address and caches it', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return okResponse('BaseMint1111111111111111111111111111111111') as never;
    }) as never;
    const p = 'Pair111111111111111111111111111111111111111a';
    expect(await resolveDexPairBaseMint(p)).toBe(
      'BaseMint1111111111111111111111111111111111',
    );
    // Second call is a cache hit — no fetch.
    expect(await resolveDexPairBaseMint(p)).toBe(
      'BaseMint1111111111111111111111111111111111',
    );
    expect(calls).toBe(1);
  });

  it('never returns SOL/USDC/USDT as "the token"', async () => {
    global.fetch = (async () =>
      okResponse('So11111111111111111111111111111111111111112') as never) as never;
    expect(
      await resolveDexPairBaseMint('Pair22222222222222222222222222222222222222b'),
    ).toBeNull();
  });

  it('is null on a non-ok response, and does not throw on network failure', async () => {
    global.fetch = (async () => ({ ok: false, json: async () => ({}) }) as never) as never;
    expect(
      await resolveDexPairBaseMint('Pair33333333333333333333333333333333333333c'),
    ).toBeNull();
    global.fetch = (async () => {
      throw new Error('network down');
    }) as never;
    expect(
      await resolveDexPairBaseMint('Pair44444444444444444444444444444444444444d'),
    ).toBeNull();
  });

  it('the outbound rate cap refuses rather than fanning out on varied pairs', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return okResponse(`Mint${String(calls).padStart(40, '1')}`) as never;
    }) as never;
    // Fire far more distinct pairs than the bucket holds (capacity 20). The
    // fetch count must be BOUNDED, not one-per-pair — that bound is the
    // whole defense against a rotating-proxy amplifier.
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        resolveDexPairBaseMint(`Z${String(i).padStart(43, 'a')}`),
      ),
    );
    expect(calls).toBeLessThanOrEqual(25);
    // Over-budget calls returned null WITHOUT caching the refusal.
    expect(results.filter((r) => r === null).length).toBeGreaterThan(0);
  });
});
