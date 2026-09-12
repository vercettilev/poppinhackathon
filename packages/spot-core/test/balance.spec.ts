import { describe, expect, it } from 'vitest';
import {
  TokenBalanceReader,
  toUiAmount,
  type TokenAccountBalance,
  type TokenAccountReader,
} from '../src/balance/token-balance';

const OWNER = 'PUBKEY_OWNER';
const MINT = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';

/** UI amounts in, raw out — mirrors what the RPC shell will hand over. */
function accounts(ui: number[], decimals = 6): TokenAccountBalance[] {
  return ui.map((u) => ({
    amountRaw: BigInt(Math.round(u * 10 ** decimals)),
    decimals,
  }));
}

class FakeReader implements TokenAccountReader {
  calls = 0;
  constructor(
    private readonly result: TokenAccountBalance[] | Error,
  ) {}
  async tokenAccountsFor(): Promise<TokenAccountBalance[]> {
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe('TokenBalanceReader', () => {
  it('sums multiple token accounts for the same mint', async () => {
    // The original spec's case: two accounts holding 0.4 each. A reader holding
    // 0.8 across two ATAs must be able to spend 0.7; reading only the first
    // account would refuse it.
    const r = new TokenBalanceReader(new FakeReader(accounts([0.4, 0.4])));

    const bal = await r.balanceOf(OWNER, MINT);
    expect(bal.accounts).toBe(2);
    expect(bal.raw).toBe(800_000n);
    expect(toUiAmount(bal)).toBe(0.8);

    await expect(r.covers(OWNER, MINT, 700_000n)).resolves.toBe(true);
  });

  it('sums exactly, with no float epsilon needed', async () => {
    // 0.4 + 0.4 as floats is 0.8000000000000001, which is why v1 needed a 1e-9
    // tolerance at the comparison site. In raw base units the sum is exact.
    const r = new TokenBalanceReader(new FakeReader(accounts([0.4, 0.4])));
    const bal = await r.balanceOf(OWNER, MINT);
    expect(bal.raw).toBe(800_000n);
    await expect(r.covers(OWNER, MINT, 800_000n)).resolves.toBe(true);
    await expect(r.covers(OWNER, MINT, 800_001n)).resolves.toBe(false);
  });

  it('reads a single account', async () => {
    const r = new TokenBalanceReader(new FakeReader(accounts([2])));
    const bal = await r.balanceOf(OWNER, MINT);
    expect(bal.raw).toBe(2_000_000n);
    expect(bal.accounts).toBe(1);
    expect(bal.reliable).toBe(true);
  });

  it('treats "no token account at all" as a reliable zero, not an error', async () => {
    const r = new TokenBalanceReader(new FakeReader([]));
    const bal = await r.balanceOf(OWNER, MINT);
    expect(bal.raw).toBe(0n);
    expect(bal.accounts).toBe(0);
    expect(bal.reliable).toBe(true);
    expect(toUiAmount(bal)).toBe(0);
  });

  it('refuses to cover anything when the wallet holds nothing', async () => {
    const r = new TokenBalanceReader(new FakeReader([]));
    await expect(r.covers(OWNER, MINT, 1n)).resolves.toBe(false);
  });

  it('fails safe to zero on a read error, and flags it as unreliable', async () => {
    const seen: unknown[] = [];
    const r = new TokenBalanceReader(
      new FakeReader(new Error('rpc down')),
      (err) => seen.push(err),
    );

    const bal = await r.balanceOf(OWNER, MINT);
    expect(bal.raw).toBe(0n);
    expect(bal.reliable).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('never reports coverage from an unreliable read', async () => {
    // The divergence from v1 that matters: a failed RPC must not read as
    // "holds nothing" to a display path, but it must still refuse to cover.
    const r = new TokenBalanceReader(new FakeReader(new Error('rpc down')));
    await expect(r.covers(OWNER, MINT, 0n)).resolves.toBe(false);
  });

  it('scales to UI amounts using the accounts’ own decimals', async () => {
    const r = new TokenBalanceReader(new FakeReader(accounts([1.5], 9)));
    const bal = await r.balanceOf(OWNER, MINT);
    expect(bal.raw).toBe(1_500_000_000n);
    expect(toUiAmount(bal)).toBe(1.5);
  });

  it('returns 0 from toUiAmount when decimals are unknown', async () => {
    const r = new TokenBalanceReader(new FakeReader([]));
    expect(toUiAmount(await r.balanceOf(OWNER, MINT))).toBe(0);
  });
});
