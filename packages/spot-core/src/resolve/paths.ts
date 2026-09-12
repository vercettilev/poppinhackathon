import { curatedByTicker, type CuratedAsset } from '../catalog/index';
import type { Candidates } from '../context/extract';
import type { DecisionReason } from '../errors';
import { assessIntent } from '../intent/index';
import { regimeOf, type Regime } from '../safety/regime';
import type { AssetCategory } from '../telemetry/events';
import {
  resolveTickerFrom,
  type JupiterUltraTokenInfo,
  type UltraSearchClient,
} from './ultra';

/**
 * §6 resolution, all three paths, with §9's per-path budgets attached to the
 * path that owns them.
 *
 * This used to live in the extension's service worker. It moved here when path
 * C arrived, because the shell "harvests and renders and decides nothing" and
 * path selection had become a decision with three branches, two regimes and
 * three different deadlines.
 *
 *   A  address  →  identity. No scoring, no ambiguity, no model.       500ms
 *   B  ticker   →  catalog first, then Jupiter with the ambiguity rule.   2s
 *   C  entity   →  catalog ONLY. "Nvidia" → NVDAx, and nothing else.      3s
 *
 * §9 BUDGETS ARE CEILINGS, NOT TARGETS, and the ordering is not a claim that
 * prose is slower to resolve. Path C's resolution is a regex over text the
 * shell already had — it is the FASTEST of the three to decide and does not
 * touch the network to do it. It gets the widest budget because it is the
 * furthest from a user's explicit request: a page that says "Nvidia" has not
 * asked for anything, so the cost of arriving late there is lower than on a
 * pasted contract address, where a reader is plainly waiting.
 *
 * What the budget actually bounds on every path is the Ultra metadata call —
 * the card cannot render without decimals, price and liquidity, and that is
 * true for a curated asset too. Curated resolution decides the MINT locally;
 * it does not conjure the numbers on the card.
 */

/** §9. The contract-address path: a reader has pasted a mint and is waiting. */
export const ADDRESS_PATH_BUDGET_MS = 500;
/** §9. The `$TICKER` path. */
export const TICKER_PATH_BUDGET_MS = 2_000;
/** §9. The entity path — widest, because nobody asked. */
export const ENTITY_PATH_BUDGET_MS = 3_000;

export type ResolutionPath = 'address' | 'ticker' | 'entity';

export const BUDGET_FOR: Readonly<Record<ResolutionPath, number>> = {
  address: ADDRESS_PATH_BUDGET_MS,
  ticker: TICKER_PATH_BUDGET_MS,
  entity: ENTITY_PATH_BUDGET_MS,
};

export interface Resolution {
  ok: true;
  path: ResolutionPath;
  regime: Regime;
  category: AssetCategory;
  /** Live metadata, needed to render the card whichever regime applied. */
  info: JupiterUltraTokenInfo;
  /** The catalog row, when the curated regime owns this mint. */
  curated?: CuratedAsset | undefined;
}

export interface NoResolution {
  ok: false;
  reason: DecisionReason;
  /** Absent when the page produced no entity at all — no path was taken. */
  path?: ResolutionPath | undefined;
  /** Known as soon as a mint is, so a silent outcome still lands in a funnel. */
  category: AssetCategory;
}

export type ResolutionOutcome = Resolution | NoResolution;

/**
 * One Ultra lookup, bounded by the path's budget rather than the client's
 * default. `search` is given the deadline instead of being raced against it: a
 * raced call would return late and keep running, and on the address path that
 * is a request still in flight after the reader has already been told nothing
 * matched.
 */
export async function resolveEntity(
  candidates: Candidates,
  ultra: UltraSearchClient,
): Promise<ResolutionOutcome> {
  const verdict = assessIntent(candidates);
  if (!verdict.act) return { ok: false, reason: verdict.reason, category: 'unknown' };

  const path: ResolutionPath =
    verdict.entity.kind === 'address'
      ? 'address'
      : verdict.entity.kind === 'ticker'
        ? 'ticker'
        : 'entity';
  const timeoutMs = BUDGET_FOR[path];

  // §6 paths A and C, plus the curated half of B, all end at a known mint. The
  // difference between them is how the mint was decided; from here the work is
  // identical, which is why the metadata fetch is written once.
  const mint = mintFor(verdict.entity);
  if (mint) {
    const regime = regimeOf(mint);
    const found = await ultra.search(mint, { timeoutMs });
    if (!found.ok) return { ok: false, reason: 'no_asset', path, category: regime.category };

    const info = found.value.find((t) => t.id === mint);
    // A curated mint Jupiter cannot describe is still not renderable: the card
    // needs decimals and a price, and inventing either is worse than silence.
    if (!info) return { ok: false, reason: 'no_asset', path, category: regime.category };

    return {
      ok: true,
      path,
      regime: regime.regime,
      category: regime.category,
      info,
      curated: regime.curated,
    };
  }

  // §6 path B, open half: a `$TICKER` that is not in the catalog. Jupiter
  // decides, under the ambiguity rule — two candidates is silence, not a coin
  // flip.
  const symbol = verdict.entity.value;
  const found = await ultra.search(symbol, { timeoutMs });
  if (!found.ok) return { ok: false, reason: 'no_asset', path, category: 'unknown' };

  const info = resolveTickerFrom(symbol, found.value);
  if (!info) return { ok: false, reason: 'low_confidence', path, category: 'unknown' };

  // Resolved through the open world, so the open regime owns it — even if the
  // mint turns out to be a catalog row reached by an unlisted alias, in which
  // case `regimeOf` corrects the category here rather than letting a curated
  // asset be reported as an open-mint one.
  const regime = regimeOf(info.id);
  return {
    ok: true,
    path,
    regime: regime.regime,
    category: regime.category,
    info,
    curated: regime.curated,
  };
}

/**
 * The mint a path already knows, or undefined when Jupiter still has to decide.
 *
 * Path B consults the catalog HERE rather than in the ticker branch below, so
 * that a curated ticker never reaches `resolveTickerFrom`. That ordering is the
 * point of curating: Ultra's own answer for `SPCX` on 2026-08-12 was eight
 * tokens sharing the symbol, separated only by a `verified` flag that is
 * Jupiter's editorial call. For an asset we have already reviewed, re-deriving
 * the mint per request from a third party's metadata adds a way to be wrong and
 * nothing else.
 */
function mintFor(entity: {
  kind: 'address' | 'ticker' | 'entity';
  value: string;
}): string | undefined {
  if (entity.kind === 'address') return entity.value;
  // Path C's value IS a catalog mint — the term resolved the asset already.
  if (entity.kind === 'entity') return entity.value;
  return curatedByTicker(entity.value)?.mint;
}
