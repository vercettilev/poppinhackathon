import type { DecisionReason } from '../errors';
import type { Candidates } from '../context/extract';

/**
 * §5 step 3 — does THIS context plausibly create transaction intent?
 *
 * This is the module the whole product rests on. From §1: as asset coverage
 * grows, the odds of finding some match on any page approach 1, at which point
 * the extension becomes adware unless this filter holds. Coverage makes this
 * file more important, not less.
 *
 * The heuristic below is deliberately conservative and deliberately dumb. It is
 * a starting position, not a model: §5 says the negative logs are the map of
 * which contexts create intent, and there is no such map yet. Every rule here
 * should be replaced by evidence from `decision_reason` counts, not by adding
 * more rules on a hunch.
 *
 * Two signals are treated very differently:
 *
 *   A contract address is close to conclusive. Nobody pastes a base58 mint into
 *   a page incidentally — it appears because someone means for a reader to act
 *   on it. One occurrence anywhere is enough.
 *
 *   A `$TICKER` is not. It appears in market commentary, in passing comparisons,
 *   in someone's portfolio anecdote. So it needs corroboration: either the page
 *   is visibly ABOUT it (title or heading), or it is discussed repeatedly. A
 *   single mention buried in a paragraph is exactly the "passing mention" §5
 *   names as insufficient.
 *
 *   A CATALOG ENTITY TERM (§6 path C — "Nvidia", "SpaceX") is weaker still, and
 *   is ordered last for that reason. `$NVDA` is somebody writing in the
 *   register of trading; "Nvidia" is somebody writing in English. The word
 *   appears in earnings coverage, in a laptop review, in a sentence about
 *   someone's job. The corroboration rule applied to it is the SAME one used
 *   for tickers rather than a stricter one, which is a deliberate starting
 *   position and the one most likely to need moving: §5 says the negative logs
 *   are the map, and `decision_reason` on this path is what should move it.
 *   The containment that does not depend on tuning is that the vocabulary is
 *   closed — a term reaches an asset only because it is written in the catalog.
 */

export const MIN_TICKER_MENTIONS = 2;

export type IntentVerdict =
  | { act: true; entity: { kind: 'address'; value: string } }
  | { act: true; entity: { kind: 'ticker'; value: string } }
  /** Path C. `value` is a catalog MINT: the term already resolved the asset. */
  | { act: true; entity: { kind: 'entity'; value: string; term: string } }
  | { act: false; reason: DecisionReason };

export function assessIntent(candidates: Candidates): IntentVerdict {
  const address = candidates.addresses[0];
  if (address) {
    return { act: true, entity: { kind: 'address', value: address } };
  }

  const entities = candidates.entities ?? [];

  if (candidates.tickers.length === 0 && entities.length === 0) {
    return { act: false, reason: 'no_entity' };
  }

  // §1: one page, one best action. If two tickers are equally corroborated the
  // page is a market roundup, not a decision, and picking one would be a guess.
  const qualified = candidates.tickers.filter(isCorroborated);
  if (qualified.length > 1 && !isClearWinner(qualified)) {
    return { act: false, reason: 'low_confidence' };
  }
  if (qualified.length === 1 || (qualified.length > 1 && isClearWinner(qualified))) {
    return { act: true, entity: { kind: 'ticker', value: qualified[0]!.symbol } };
  }

  // Path C, reached only when no ticker qualified. An explicit `$TICKER` on the
  // page is a better statement of what the reader is looking at than a company
  // name, so the two never compete — a page carrying both is decided by the
  // ticker, and this path is what a page with only prose has left.
  const qualifiedEntities = entities.filter(isCorroborated);
  if (qualifiedEntities.length === 0) {
    return { act: false, reason: 'no_intent' };
  }
  if (qualifiedEntities.length > 1 && !isClearWinner(qualifiedEntities)) {
    // Two catalog companies discussed equally is a market roundup in prose. The
    // same rule, for the same reason.
    return { act: false, reason: 'low_confidence' };
  }

  const winner = qualifiedEntities[0]!;
  return {
    act: true,
    entity: { kind: 'entity', value: winner.mint, term: winner.term },
  };
}

/** Both candidate kinds carry the same two signals, so one rule serves both. */
interface Corroborable {
  count: number;
  prominent: boolean;
}

const isCorroborated = (t: Corroborable): boolean =>
  t.prominent || t.count >= MIN_TICKER_MENTIONS;

/**
 * A winner is clear when it is in the headline and its nearest rival is not, or
 * when it is mentioned at least twice as often. Anything closer than that is a
 * roundup.
 */
function isClearWinner(sorted: Corroborable[]): boolean {
  const [first, second] = sorted;
  if (!first || !second) return true;
  if (first.prominent && !second.prominent) return true;
  if (first.prominent === second.prominent) return first.count >= second.count * 2;
  return false;
}
