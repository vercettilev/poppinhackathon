import {
  curatedByMint,
  type CuratedAsset,
  type IssuerRestriction,
} from '../catalog/index';
import { RouteError, type RouteFailure } from '../errors';
import type { MintPolicy } from '../route/policy';
import type { AssetCategory } from '../telemetry/events';

/**
 * The fork between the two safety regimes, in one place, so that "which rules
 * applied to this mint" is a question with a single answer and a single
 * implementation.
 *
 * Every mint takes exactly one of these paths and they never blend:
 *
 *   curated  In `CURATED_CATALOG`. Membership IS the check — a person put the
 *            row there against a named issuer, and §7's measured criteria are
 *            not consulted because they would reject it for holding exactly
 *            the authorities its issuer is required to hold.
 *   open     Everything else. §7's gate, unchanged, fail-closed.
 *
 * WHY THIS IS A CLASS AND NOT AN `if` AT THE CALL SITE. There are two callers —
 * the match path, which needs the regime for telemetry, and `RouteEngine`,
 * which needs the assertion when it builds a swap. Two call sites each doing
 * their own catalog check is how they drift, and the drift that matters is the
 * one where the card path treats a mint as curated and the build path runs it
 * through the open gate, so the reader gets a card and then an error. One
 * object decides once.
 *
 * The bypass is narrow ON PURPOSE. `CatalogPolicy` alone would be the dangerous
 * shape: a policy that passes what it knows and rejects everything else reads
 * as safe, but combined carelessly it becomes "curated OR open", where a mint
 * failing the open gate could still slip through a stale catalog entry. Here
 * the catalog is consulted FIRST and its answer is final for its own rows;
 * everything else goes to the gate and the gate's answer is final. No mint is
 * ever offered two chances to pass.
 */
export type Regime = 'curated' | 'open';

export interface RegimeVerdict {
  regime: Regime;
  /**
   * The §10 funnel split. `equity` comes off the catalog row, `token` is
   * everything the open gate admits.
   */
  category: AssetCategory;
  /** Present only for the curated regime. */
  curated?: CuratedAsset | undefined;
}

/** Sync classification: which regime owns this mint, before any network call. */
export function regimeOf(mint: string): RegimeVerdict {
  const curated = curatedByMint(mint);
  return curated
    ? { regime: 'curated', category: curated.category, curated }
    : { regime: 'open', category: 'token' };
}

export class RegimePolicy implements MintPolicy {
  constructor(private readonly openMint: MintPolicy) {}

  /**
   * Throws exactly as `MintPolicy` requires, so `RouteEngine` needs no
   * knowledge of regimes at all.
   */
  async assert(mint: string): Promise<void> {
    await this.admit(mint);
  }

  /**
   * The same decision as `assert`, with the regime returned rather than
   * discarded — for the match path, which has to stamp `category` on the
   * telemetry and would otherwise have to ask the catalog a second time.
   *
   * Throws `RouteError('not_allowed')` when the open gate rejects. A curated
   * mint cannot reach that throw: it is admitted by being in the list, which is
   * the whole content of the curated regime.
   */
  async admit(mint: string): Promise<RegimeVerdict> {
    const verdict = regimeOf(mint);
    if (verdict.regime === 'curated') return verdict;

    // Not in the catalog: §7, unchanged, and its RouteError propagates.
    await this.openMint.assert(mint);
    return verdict;
  }
}

/**
 * Was this failure the issuer's restriction, or an ordinary routing failure?
 *
 * Lives here rather than in the extension because it is a DECISION, and the
 * shell decides nothing. It is also the subtlest rule in the curated regime and
 * the one whose output someone will eventually use to justify a hard block, so
 * it should be somewhere it can be read and tested rather than inline in a
 * message handler.
 *
 * Both conditions are required and neither is sufficient:
 *
 *   `chainRefused`  the SIMULATION was rejected on chain. Not a quote failure,
 *                   not a rate limit, not a build error, not our own structural
 *                   checks — those are statements about Jupiter or about us,
 *                   and a mint-level transfer restriction cannot surface in any
 *                   of them.
 *   `restriction`   the issuer's terms cover the country the geofence resolved
 *                   for this reader.
 *
 * A rate limit is a rate limit in every jurisdiction, and a restricted reader
 * hitting one must not be counted as evidence that the restriction is enforced.
 * That inflation is exactly what would make a premature hard block look
 * justified.
 *
 * And read the positive result carefully too: it means "the chain refused a
 * reader the issuer restricts", not "the issuer's hook rejected this". An empty
 * wallet also fails simulation, and a restricted reader with an empty wallet
 * lands here. The raw program error is what separates those, which is why it is
 * carried rather than discarded.
 */
export function attributeBuildFailure(opts: {
  chainRefused: boolean;
  restriction: IssuerRestriction | undefined;
  failure: RouteFailure | 'unknown';
}): { failure: RouteFailure | 'unknown'; issuerRestricted: boolean } {
  const issuerRestricted = opts.chainRefused && opts.restriction !== undefined;
  return {
    failure: issuerRestricted ? 'issuer_restricted' : opts.failure,
    issuerRestricted,
  };
}

/**
 * Curated membership on its own, for callers that want the catalog rule without
 * the open-mint fallback — a build that intends to ship ONLY the catalog.
 *
 * Not what the extension uses. Kept separate from `RegimePolicy` rather than
 * folded in as a flag, because "catalog only" and "catalog then gate" are
 * different products and a boolean makes it possible to be in the wrong one by
 * accident.
 */
export class CatalogPolicy implements MintPolicy {
  assert(mint: string): void {
    if (!curatedByMint(mint)) {
      throw new RouteError(
        'not_allowed',
        `Not in the curated catalog: ${mint}`,
      );
    }
  }
}
