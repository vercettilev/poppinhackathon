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
