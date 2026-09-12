import { describe, expect, it, vi } from 'vitest';
import { executedTokenDelta } from './simulator';

/**
 * THE ONLY HONEST QUANTITY FOR A BUY, and the reasons it is read this way.
 *
 * A buy's asset is the swap's OUTPUT, so everything before broadcast is an
 * estimate. Only the confirmed transaction knows, and it says so in
 * meta.pre/postTokenBalances.
 */

const OWNER = '5J6Xgdir5CwKGDy5tKEGG7e8Lmpi9f3kbnmGhBeaE1jC';
const MINT = 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp';
const OTHER = 'C7hF6MSomebodyElseEntirely';

const reply = (meta: unknown) =>
  ({ ok: true, json: async () => ({ result: { meta } }) }) as unknown as Response;

const bal = (owner: string, mint: string, amount: string) => ({
  owner,
  mint,
  uiTokenAmount: { amount },
});

describe('executedTokenDelta', () => {
  it('reads what the chain moved, not what was quoted', async () => {
    const fetchFn = vi.fn(async () =>
      reply({
        preTokenBalances: [bal(OWNER, MINT, '0')],
        postTokenBalances: [bal(OWNER, MINT, '61452000')],
      }),
    );
    expect(await executedTokenDelta('rpc', 'sig', OWNER, MINT, { fetchFn })).toBe(61452000n);
  });

  it('matches by OWNER AND MINT, never by position', async () => {
    // A swap through two pools touches several token accounts. The prior
    // art in this repo takes postTokenBalances[0] in one branch, which is
    // how you silently read somebody else's account.
    const fetchFn = vi.fn(async () =>
      reply({
        preTokenBalances: [bal(OTHER, MINT, '1854718229'), bal(OWNER, MINT, '0')],
        postTokenBalances: [bal(OTHER, MINT, '1854656777'), bal(OWNER, MINT, '61452000')],
      }),
    );
    expect(await executedTokenDelta('rpc', 'sig', OWNER, MINT, { fetchFn })).toBe(61452000n);
  });

  it('treats a missing PRE row as zero — the shape of a first buy', async () => {
    // The token account did not exist before the swap created it, so there
    // is no pre row at all. Safe only because the post row proved it exists.
    const fetchFn = vi.fn(async () =>
      reply({ preTokenBalances: [], postTokenBalances: [bal(OWNER, MINT, '61452000')] }),
    );
    expect(await executedTokenDelta('rpc', 'sig', OWNER, MINT, { fetchFn })).toBe(61452000n);
  });

  it('reports a sell as a negative delta', async () => {
    const fetchFn = vi.fn(async () =>
      reply({
        preTokenBalances: [bal(OWNER, MINT, '61452000')],
        postTokenBalances: [bal(OWNER, MINT, '0')],
      }),
    );
    expect(await executedTokenDelta('rpc', 'sig', OWNER, MINT, { fetchFn })).toBe(-61452000n);
  });

  it('returns NULL, not zero, when it cannot tell', async () => {
    // "Nothing moved" and "we could not read it" are different facts, and
    // storing one as the other records a swap that credited nothing.
    const fetchFn = vi.fn(async () => reply({ postTokenBalances: [] }));
    expect(await executedTokenDelta('rpc', 'sig', OWNER, MINT, { fetchFn })).toBeNull();
  });

  it('retries, because confirmed can precede served', async () => {
    // getSignatureStatuses reports confirmed a few hundred ms before
    // getTransaction will serve the transaction at all.
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n < 3) return { ok: false, status: 404 } as unknown as Response;
      return reply({
        preTokenBalances: [bal(OWNER, MINT, '0')],
        postTokenBalances: [bal(OWNER, MINT, '999')],
      });
    });
    const got = await executedTokenDelta('rpc', 'sig', OWNER, MINT, {
      fetchFn,
      sleep: async () => {},
    });
    expect(got).toBe(999n);
    expect(n).toBe(3);
  });

  it('gives up rather than hanging', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    const got = await executedTokenDelta('rpc', 'sig', OWNER, MINT, {
      fetchFn,
      attempts: 2,
      sleep: async () => {},
    });
    expect(got).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
