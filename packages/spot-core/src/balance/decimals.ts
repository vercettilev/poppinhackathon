import { RouteError } from '../errors';

/**
 * Mint decimals, cached for the process lifetime — mint decimals are immutable,
 * so a hit is always valid and the cache never needs invalidation.
 *
 * v1 read this through a Nest-injected `Connection` from `@solana/web3.js`.
 * Core takes a narrow reader instead: the engine needs exactly one fact about a
 * mint, and depending on the whole web3 client to learn it would drag a heavy,
 * network-bound dependency into every unit test. The web3 implementation lives
 * in the shell that has a Connection anyway.
 */

export interface MintInfoReader {
  /** Returns the mint's decimals, or undefined if it cannot be determined. */
  decimalsOf(mint: string): Promise<number | undefined>;
  /**
   * Which token program owns the mint, or undefined if it cannot be
   * determined. OPTIONAL, so every existing reader and every test double
   * keeps compiling and keeps its old behaviour.
   *
   * Needed because a mint's token program decides whether Jupiter can take
   * a platform fee into the account we own. See MintProgramCache.
   */
  tokenProgramOf?(mint: string): Promise<string | undefined>;
}

/** Token-2022, the program every tokenized equity on this catalog uses. */
export const TOKEN_2022_PROGRAM_ID =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * WHICH TOKEN PROGRAM OWNS A MINT, cached for the process lifetime.
 *
 * A mint's owning program is immutable, exactly like its decimals, so this
 * shares DecimalsCache's shape and its reasoning: a hit is always valid and
 * the cache never needs invalidation. It is a separate class rather than two
 * methods on one, because a class called DecimalsCache that also answers
 * questions about programs is a name that will mislead the next reader.
 *
 * WHY THE ENGINE NEEDS IT. Jupiter takes its platform fee out of the OUTPUT
 * mint. The fee account we own is a classic SPL account holding USDC, which
 * is correct on a sell (USDC is the output) and wrong on a buy of anything
 * that is not a classic SPL token. Handing Jupiter a classic account for a
 * Token-2022 output makes its Route instruction throw IncorrectTokenProgramID
 * — custom error 6014 — and the swap never happens.
 *
 * Measured 2026-09-14, same swap three ways, one variable:
 *
 *     USDC -> NVDAx  no fee account        simulation succeeded
 *     USDC -> NVDAx  our fee account       InstructionError [2, Custom 6014]
 *     USDC -> WIF    our fee account       simulation succeeded
 *
 * Every xStock is Token-2022 (NVDAx, TSLAx and AAPLx all checked on chain),
 * so with fees on, every tokenized stock purchase was failing while every
 * classic SPL purchase went through. That asymmetry is why this sat unfound:
 * the catalog was memecoins when the error was first seen.
 *
 * Answering "undefined" is not a failure. The engine treats an unknown
 * program as classic and keeps the fee, which is the behaviour that shipped
 * before this existed.
 */
export class MintProgramCache {
  private readonly cache = new Map<string, string>();

  constructor(private readonly reader: MintInfoReader) {}

  /** Undefined when the reader cannot say, which is never fatal. */
  async tokenProgramOf(mint: string): Promise<string | undefined> {
    const hit = this.cache.get(mint);
    if (hit) return hit;
    if (!this.reader.tokenProgramOf) return undefined;
    const program = await this.reader.tokenProgramOf(mint);
    if (typeof program !== 'string' || program.length === 0) return undefined;
    this.cache.set(mint, program);
    return program;
  }

  /** True only when we positively know it is Token-2022. */
  async isToken2022(mint: string): Promise<boolean> {
    return (await this.tokenProgramOf(mint)) === TOKEN_2022_PROGRAM_ID;
  }

  clear(): void {
    this.cache.clear();
  }
}

export class DecimalsCache {
  private readonly cache = new Map<string, number>();

  constructor(private readonly reader: MintInfoReader) {}

  async decimalsOf(mint: string): Promise<number> {
    const hit = this.cache.get(mint);
    if (typeof hit === 'number') return hit;

    const dec = await this.reader.decimalsOf(mint);
    if (typeof dec !== 'number' || !Number.isInteger(dec) || dec < 0) {
      throw new RouteError(
        'decimals_unavailable',
        'Could not read asset decimals',
      );
    }
    this.cache.set(mint, dec);
    return dec;
  }

  /** Test/ops affordance — the cache is process-lifetime by design. */
  clear(): void {
    this.cache.clear();
  }
}
