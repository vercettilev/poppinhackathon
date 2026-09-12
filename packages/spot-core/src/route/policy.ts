import { RouteError } from '../errors';

/**
 * §7 SEQUENCING CONSTRAINT — read before touching this file.
 *
 *   "the gate ships in the same commit that removes `assertAllowed`.
 *    Never before."
 *
 * So v1's `assertAllowed` is carried forward here UNCHANGED in behaviour, not
 * dropped. Until the open-mint gate (min liquidity, mint/freeze authority
 * revoked, sellability, holder concentration, pool age) exists and is wired,
 * this closed allowlist is the only thing standing between a caller-supplied
 * mint and a transaction we hand a user to sign.
 *
 * Replacing this with the §7 gate is a single commit that does both: delete
 * `AllowlistPolicy` as the default AND land the gate. A commit that only does
 * the first opens an arbitrary-mint hole.
 */

export interface MintPolicy {
  /** Throws RouteError('not_allowed') if the mint may not be routed. */
  assert(mint: string): Promise<void> | void;
}

/** v1 parity: a fixed set, defaulting to the Sunrise prototype's SPCX mint. */
export class AllowlistPolicy implements MintPolicy {
  private readonly allowed: ReadonlySet<string>;

  constructor(mints: readonly string[]) {
    if (mints.length === 0) {
      throw new Error('AllowlistPolicy requires at least one mint');
    }
    this.allowed = new Set(mints);
  }

  assert(mint: string): void {
    if (!this.allowed.has(mint)) {
      throw new RouteError(
        'not_allowed',
        `Asset not tradeable from here: ${mint}`,
      );
    }
  }
}
