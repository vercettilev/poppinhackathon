/**
 * Nest-free error surface.
 *
 * The source service threw `BadRequestException` / `ServiceUnavailableException`
 * from `@nestjs/common`, which coupled the swap engine to an HTTP framework it
 * has no reason to know about. Here the engine throws a plain typed error and
 * the shell (server or extension) decides what an HTTP status is.
 *
 * `reason` is the §5 negative-decision vocabulary. Every silent outcome the
 * engine produces has to be attributable to one of these, because §5 makes the
 * negatives the primary dataset — an error that collapses to a generic string
 * is a row we cannot analyse later.
 */

export type DecisionReason =
  | 'no_entity'
  | 'no_asset'
  | 'low_confidence'
  | 'no_intent'
  | 'failed_safety'
  | 'no_route'
  | 'geo_blocked';

/** Failure modes internal to routing, distinct from the §5 render decisions. */
export type RouteFailure =
  | 'bad_input'
  | 'no_route'
  | 'quote_stale'
  | 'quote_unavailable'
  /**
   * Distinct from `quote_unavailable` on purpose. "We were throttled" and
   * "this asset has no route" are opposite facts that a single code would
   * merge, and §11 reads conversion off exactly this field. Rate limits
   * correlate with traffic, so merging them understates conversion hardest
   * at peak — the moment the numbers are being read.
   */
  | 'rate_limited'
  | 'build_failed'
  | 'decimals_unavailable'
  /**
   * The chain refused a swap for a reader whose issuer restricts them.
   *
   * SEPARATE FROM `no_route` AND `quote_unavailable` ON PURPOSE, and the
   * separation is the entire point of the code: those say something about the
   * market, this says something about the reader. Merging them would put the
   * one number that answers "is this restriction actually enforced at the
   * mint?" inside a bucket dominated by ordinary liquidity failures.
   *
   * ATTRIBUTION, NOT DIAGNOSIS — do not read it as more than it is. It is
   * assigned when a simulation was rejected ON CHAIN *and* an issuer
   * restriction applied to that reader. It does not mean the issuer's transfer
   * hook returned an error we decoded; nobody here has decoded one. A
   * simulation can be rejected for reasons that have nothing to do with the
   * issuer — an empty wallet being the obvious one — and those land here too
   * when the reader happens to be restricted.
   *
   * Which is why the raw chain error travels with it. The flag is the
   * hypothesis; the program error is the evidence, and only the evidence can
   * settle whether a hard block is warranted.
   */
  | 'issuer_restricted'
  | 'not_allowed';

export class RouteError extends Error {
  readonly failure: RouteFailure;

  constructor(failure: RouteFailure, message: string) {
    super(message);
    this.name = 'RouteError';
    this.failure = failure;
  }
}

export const badInput = (m: string) => new RouteError('bad_input', m);
export const noRoute = (m = 'No route for this asset right now') =>
  new RouteError('no_route', m);
