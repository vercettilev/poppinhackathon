import { RouteError } from '../errors';
import type { MintPolicy } from '../route/policy';
import type { JupiterUltraTokenInfo, UltraSearchClient } from '../resolve/ultra';

/**
 * §7 open-mint regime. A HARD GATE: a mint passes only by satisfying every
 * criterion, and anything unknown counts as a failure.
 *
 * NOT for the curated regime. Tokenized equities and commodities would fail
 * these heuristics by construction — low holder counts, thin pools, and
 * authorities the issuer retains on purpose (SPCX keeps a permanentDelegate
 * and a live freezeAuthority). Routing them through here would silently delete
 * the entire category, so they go through a catalog policy instead.
 *
 * §7 SEQUENCING: this ships alongside AllowlistPolicy, not in place of it. The
 * commit that makes this the default is the same commit that removes the
 * allowlist — both at once, never the removal alone.
 *
 * The thresholds below are POLICY, not physics. They were calibrated on
 * 2026-08-11 against 33 established, 122 fresh and 48 no-sell-route mints
 * (`scripts/calibrate.ts`). Each sits in a wide empty gap between the
 * established floor and the fresh ceiling, so the exact value is not delicate:
 *
 *   liquidity   established min $80,121   vs  fresh max $4,884
 *   holders     established min 931       vs  fresh max 120
 *   pool age    established min 54h       vs  fresh max ~0h
 *
 * REMOVED, deliberately: top-holder concentration. It blocked 61% of
 * established tokens (BONK 33%, RAY 78%, TRUMP 82%) and separated nothing —
 * established and fresh had near-identical pass rates at every threshold from
 * 15% to 100%. The cause is structural: Ultra counts LP pools, CEX custody and
 * vesting contracts as holders, so deep liquidity makes the metric worse. Its
 * proposed replacements were swept too and rejected; see PORTING.md.
 */

export interface OpenMintThresholds {
  minLiquidityUsd: number;
  minPoolAgeMs: number;
  minHolderCount: number;
}

/**
 * WIDENED 2026-08-30, owner's call: "500k market cap bile olsa, orijinal
 * tokenları gösterirsek hiç problem olmaz — hatta degenler için daha iyi."
 *
 * The 2026-08-11 numbers were calibrated to separate ESTABLISHED from
 * FRESH, and they did that well. They were then used to answer a different
 * question — "may a reader be offered this at all" — and on that question
 * they were simply too strict for the product's own audience: measured
 * live the same day this changed, $APU (mcap $70k, 1,432 holders, an
 * 86-day-old pool, Jupiter organic score 'medium') was refused for holding
 * $19k of liquidity against a $25k floor. Nothing about that token is a
 * scam; it is small, and small is the market this chip lives in.
 *
 * WHAT MOVED AND WHAT DID NOT. These three are SIZE measures — they say
 * how big a thing is, never whether it will steal from you. They move.
 * The three that prevent theft do not: a live mint authority (supply can
 * be printed against you), a live freeze authority (your balance can be
 * locked), and the sell-route probe (the honeypot check, the only one
 * that asks whether the exit exists rather than inferring it). Those stay
 * exactly as strict, because a wider door is not a door with no lock.
 *
 * Every value is overridable per deployment (fromEnv below), so tuning
 * this again is a config change and not a release.
 */
export const DEFAULT_THRESHOLDS: OpenMintThresholds = {
  minLiquidityUsd: 7_500,
  minPoolAgeMs: 2 * 60 * 60 * 1000,
  minHolderCount: 150,
};

/**
 * Thresholds from the environment, falling back to the defaults per field.
 * A value that does not parse as a positive number is IGNORED rather than
 * treated as zero — a typo in a deploy variable must never silently open
 * the gate all the way.
 */
export function thresholdsFromEnv(
  env: Record<string, string | undefined>,
): Partial<OpenMintThresholds> {
  const num = (raw: string | undefined): number | undefined => {
    // A DECLARED-BUT-EMPTY variable is the trap here, and review found it:
    // Number('') and Number('   ') are both 0, which would sail through a
    // finite-and-non-negative check as an explicit "no floor at all" and
    // open the gate completely. An empty value is an unset value.
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const out: Partial<OpenMintThresholds> = {};
  const liq = num(env.SPOT_GATE_MIN_LIQUIDITY_USD);
  if (liq !== undefined) out.minLiquidityUsd = liq;
  const holders = num(env.SPOT_GATE_MIN_HOLDERS);
  if (holders !== undefined) out.minHolderCount = holders;
  const ageH = num(env.SPOT_GATE_MIN_POOL_AGE_HOURS);
  if (ageH !== undefined) out.minPoolAgeMs = ageH * 60 * 60 * 1000;
  return out;
}

/**
 * THE ESTABLISHED EXCEPTION, for a retained mint authority only.
 *
 * A live mint authority is a real risk and the refusal is right for the
 * long tail. It is wrong for the head: measured 2026-08-30, $SPX — $45M
 * market cap, $3.0M of liquidity, 70,333 holders, Jupiter-verified, an
 * organic score of 84/'high', a pool over two years old — was refused,
 * because SPX6900 reaches Solana across a bridge and a bridge mints
 * against locked collateral. The authority is the bridge program, not a
 * person with a printer, and no metadata field says so outright.
 *
 * What DOES say so is the shape of the thing: nothing at this size and
 * this age with this much organic volume is a fresh mint waiting to
 * inflate. So a mint authority is forgiven only for a token that clears
 * every one of these at once. Freeze authority is NEVER forgiven — a
 * frozen balance is the reader's money taken, not diluted.
 */
export interface EstablishedBar {
  minLiquidityUsd: number;
  minHolderCount: number;
  requireVerified: boolean;
  requireHighOrganic: boolean;
}

export const ESTABLISHED_BAR: EstablishedBar = {
  minLiquidityUsd: 500_000,
  minHolderCount: 25_000,
  requireVerified: true,
  requireHighOrganic: true,
};

export function isEstablished(
  info: {
    liquidity?: number;
    holderCount?: number;
    isVerified?: boolean;
    organicScoreLabel?: string;
  },
  bar: EstablishedBar = ESTABLISHED_BAR,
): boolean {
  if (typeof info.liquidity !== 'number' || info.liquidity < bar.minLiquidityUsd) {
    return false;
  }
  if (
    typeof info.holderCount !== 'number' ||
    info.holderCount < bar.minHolderCount
  ) {
    return false;
  }
  if (bar.requireVerified && info.isVerified !== true) return false;
  if (bar.requireHighOrganic && info.organicScoreLabel !== 'high') return false;
  return true;
}

export type GateFailure =
  | 'lookup_failed'
  | 'not_found'
  | 'insufficient_liquidity'
  | 'mint_authority_retained'
  | 'freeze_authority_retained'
  | 'not_sellable'
  | 'pool_too_young'
  | 'too_few_holders';

/**
 * One criterion's result, carrying the RAW observed value alongside the
 * threshold it was measured against.
 *
 * Pass/fail alone is useless for calibration: knowing that 40% of a sample
 * failed on `too_few_holders` says nothing about whether the threshold sits in
 * the gap between the populations or straight through the middle of one. The
 * observed values are the input to that decision, and they are also what makes
 * a shadow-mode log worth keeping.
 */
export interface GateCheck {
  criterion: GateFailure;
  passed: boolean;
  /** What Ultra actually reported. `null` means the field was absent. */
  observed: string | number | boolean | null;
  /** What it was compared against; `null` for non-numeric criteria. */
  threshold: string | number | null;
}

export interface GateVerdict {
  passed: boolean;
  failures: GateFailure[];
  checks: GateCheck[];
  info?: JupiterUltraTokenInfo | undefined;
}

/**
 * §7's sixth criterion, the one Ultra cannot answer: is the position
 * exitable? A mint that quotes beautifully on the way in and has no route out
 * is the honeypot shape, and no metadata field reveals it. The only honest
 * check is to ask for the sell route.
 */
export interface SellRouteChecker {
  /** Does a route exist to sell `mint` back to USDC right now? */
  canSell(mint: string, amountRaw: string): Promise<boolean>;
}

export class OpenMintGate implements MintPolicy {
  private readonly thresholds: OpenMintThresholds;

  constructor(
    private readonly ultra: UltraSearchClient,
    /**
     * Required, not optional. §7 lists sellability among the criteria a mint
     * must pass, so a gate constructed without the ability to check it could
     * only ever pass mints on five of six — which is the silent partial
     * enforcement this gate exists to prevent.
     */
    private readonly sellRoute: SellRouteChecker,
    private readonly now: () => number = () => Date.now(),
    thresholds: Partial<OpenMintThresholds> = {},
    private readonly establishedBar: EstablishedBar = ESTABLISHED_BAR,
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /** The thresholds actually in force, for callers that pre-filter with the
   *  same numbers. Reading DEFAULT_THRESHOLDS instead is how a per-instance
   *  override silently desyncs the two. */
  get inForce(): OpenMintThresholds {
    return this.thresholds;
  }

  async assert(mint: string): Promise<void> {
    const verdict = await this.evaluate(mint);
    if (!verdict.passed) {
      const err = new RouteError(
        'not_allowed',
        `Mint failed the safety gate: ${verdict.failures.join(', ')}`,
      );
      /**
       * THE REASONS RIDE ALONG, because one `not_allowed` covers two very
       * different events: "this token does not qualify" and "we could not
       * find out". Callers that cache a refusal must be able to tell them
       * apart — the ticker resolver's five-minute memory was writing an
       * Ultra outage into itself as "no such token" and serving that to
       * every reader on the instance. A message string is not an API;
       * this list is.
       */
      (err as RouteError & { gateFailures?: GateFailure[] }).gateFailures =
        verdict.failures;
      throw err;
    }
  }

  /** The full verdict, for §5 logging. Every negative carries its reasons. */
  async evaluate(mint: string): Promise<GateVerdict> {
    const found = await this.ultra.search(mint);
    if (!found.ok) {
      // Fail closed. v1's metadata path swallowed errors into an empty result;
      // here "we could not check" must never be indistinguishable from "it
      // passed".
      return {
        passed: false,
        failures: ['lookup_failed'],
        checks: [
          {
            criterion: 'lookup_failed',
            passed: false,
            observed: found.reason,
            threshold: null,
          },
        ],
      };
    }

    const info = found.value.find((t) => t.id === mint);
    if (!info) {
      return {
        passed: false,
        failures: ['not_found'],
        checks: [
          { criterion: 'not_found', passed: false, observed: null, threshold: null },
        ],
      };
    }

    const t = this.thresholds;
    const checks: GateCheck[] = [];

    // Absent fields are failures, not passes. An undefined liquidity reading is
    // not evidence of a deep pool.
    const liq = info.liquidity;
    checks.push({
      criterion: 'insufficient_liquidity',
      passed: typeof liq === 'number' && liq >= t.minLiquidityUsd,
      observed: typeof liq === 'number' ? liq : null,
      threshold: t.minLiquidityUsd,
    });

    // Null/absent means revoked. A present authority means someone can still
    // mint supply or freeze a holder's balance after they have bought.
    //
    // The one exception, and only for MINTING: a token established enough
    // that the authority is structurally a bridge or a DAO rather than a
    // printer (see isEstablished — measured on $SPX, refused at $45M mcap
    // and 70k holders because SPX6900 reaches Solana across a bridge).
    checks.push({
      criterion: 'mint_authority_retained',
      passed: !info.mintAuthority || isEstablished(info, this.establishedBar),
      observed: info.mintAuthority ?? null,
      threshold: null,
    });
    checks.push({
      criterion: 'freeze_authority_retained',
      passed: !info.freezeAuthority,
      observed: info.freezeAuthority ?? null,
      threshold: null,
    });

    const holders = info.holderCount;
    checks.push({
      criterion: 'too_few_holders',
      passed: typeof holders === 'number' && holders >= t.minHolderCount,
      observed: typeof holders === 'number' ? holders : null,
      threshold: t.minHolderCount,
    });

    const createdAt = info.firstPool?.createdAt;
    const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
    const ageMs = Number.isFinite(createdMs) ? this.now() - createdMs : null;
    checks.push({
      criterion: 'pool_too_young',
      passed: ageMs !== null && ageMs >= t.minPoolAgeMs,
      observed: ageMs,
      threshold: t.minPoolAgeMs,
    });

    // Asked last: it costs a network round trip, and there is no point pricing
    // an exit for a mint that has already failed on its metadata.
    if (checks.every((c) => c.passed)) {
      const probe = String(10 ** Math.min(info.decimals ?? 0, 9));
      try {
        const sellable = await this.sellRoute.canSell(mint, probe);
        checks.push({
          criterion: 'not_sellable',
          passed: sellable,
          observed: sellable,
          threshold: null,
        });
      } catch (err) {
        // "We could not ask" is not "there is no way out". Both reject the
        // mint — the gate stays fail-closed either way — but recording a
        // throttled probe as `not_sellable` would write a honeypot verdict
        // into the shadow log for an asset that is probably fine, and
        // calibration reads that log.
        const failure = (err as RouteError)?.failure;
        checks.push({
          criterion: failure === 'rate_limited' ? 'lookup_failed' : 'not_sellable',
          passed: false,
          observed: failure ?? 'probe_failed',
          threshold: null,
        });
      }
    }

    const failures = checks.filter((c) => !c.passed).map((c) => c.criterion);
    return { passed: failures.length === 0, failures, checks, info };
  }
}
