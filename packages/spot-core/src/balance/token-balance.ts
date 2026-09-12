/**
 * Token balance reads, ported from `assetBalance` on
 * `recover/sunrise-sell-side`.
 *
 * The load-bearing detail, and the reason this is not a one-liner: a wallet can
 * hold MORE THAN ONE token account for the same mint — the associated token
 * account plus an older auxiliary one created before ATAs were universal, or
 * one created by a different client. Reading only the first under-reports what
 * the reader actually holds.
 *
 * §13 cuts the sell side from P0, which is what v1 used this for. It is still
 * needed buy-only: USDC is subject to exactly the same multi-account situation,
 * and the card cannot show a spendable balance without summing correctly.
 *
 * Divergence from v1, deliberate: v1 returned a plain `number` and used 0 for
 * both "holds nothing" and "the RPC call failed", then guarded the sell with
 * `held > 0`. Fail-safe in that context, but the two cases are not the same
 * fact and a display path that silently shows 0 for an RPC failure is telling
 * the reader something false. `reliable` separates them without changing the
 * fail-safe direction: a failed read still yields zero.
 */

export interface TokenAccountBalance {
  /** Raw base units, from `tokenAmount.amount`. NOT the UI-scaled figure. */
  amountRaw: bigint;
  decimals: number;
}

export interface TokenAccountReader {
  /**
   * Every token account `owner` holds for `mint`.
   *
   * A web3.js shell implements this over
   * `getParsedTokenAccountsByOwner(owner, { mint })`, mapping each entry's
   * `account.data.parsed.info.tokenAmount` across. Returning an empty array for
   * "no token account at all" is correct and expected — never having held the
   * asset is the normal case, not an error.
   */
  tokenAccountsFor(
    owner: string,
    mint: string,
  ): Promise<TokenAccountBalance[]>;
}

export interface TokenBalance {
  /** Summed raw base units across every token account for this mint. */
  raw: bigint;
  /** Decimals reported by the accounts; undefined when none were found. */
  decimals: number | undefined;
  /** How many token accounts contributed. */
  accounts: number;
  /**
   * False when the read failed and `raw` is a fail-safe zero rather than a
   * fact. Callers showing a balance must not render an unreliable zero as
   * "you hold nothing".
   */
  reliable: boolean;
}

const EMPTY: TokenBalance = {
  raw: 0n,
  decimals: undefined,
  accounts: 0,
  reliable: true,
};

export class TokenBalanceReader {
  constructor(
    private readonly reader: TokenAccountReader,
    private readonly onError?: (err: unknown, ctx: { owner: string; mint: string }) => void,
  ) {}

  async balanceOf(owner: string, mint: string): Promise<TokenBalance> {
    let accounts: TokenAccountBalance[];
    try {
      accounts = await this.reader.tokenAccountsFor(owner, mint);
    } catch (err) {
      this.onError?.(err, { owner, mint });
      // Fail-safe zero, flagged as such. v1 returned a bare 0 here and the
      // caller could not tell the difference.
      return { raw: 0n, decimals: undefined, accounts: 0, reliable: false };
    }

    if (accounts.length === 0) return EMPTY;

    // Sum in BigInt over raw base units rather than over uiAmount floats. v1
    // summed uiAmount and then needed a 1e-9 epsilon at the comparison site to
    // absorb the drift; summing raw removes the need for the epsilon entirely.
    let raw = 0n;
    for (const a of accounts) raw += a.amountRaw;

    return {
      raw,
      decimals: accounts[0]?.decimals,
      accounts: accounts.length,
      reliable: true,
    };
  }

  /** Does the wallet hold at least `wantRaw` of `mint`, across all accounts? */
  async covers(owner: string, mint: string, wantRaw: bigint): Promise<boolean> {
    const bal = await this.balanceOf(owner, mint);
    if (!bal.reliable) return false;
    return bal.raw >= wantRaw;
  }
}

/** UI-scaled view of a raw balance. Returns 0 when decimals are unknown. */
export function toUiAmount(bal: TokenBalance): number {
  if (bal.decimals === undefined) return 0;
  return Number(bal.raw) / 10 ** bal.decimals;
}
