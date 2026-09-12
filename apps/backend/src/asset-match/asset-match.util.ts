import {
  CURATED_CATALOG,
  matchCatalogTerms,
  matchCatalogThematic,
  type CuratedAsset,
} from '@repo/spot-core';
import type { PageSignals } from '../keyword-extraction/keyword-extraction.util';
import { matchByMintInText, matchByVenueUrl } from './venue-match';

/**
 * Whether the asset was READ off the page or inferred from its prose.
 * See AssetMatch.certainty and venue-match.ts.
 */
export type MatchCertainty = 'exact' | 'inferred';

/**
 * Match a page to a tradeable continuous-price asset.
 *
 * ONE CATALOG. This reads `CURATED_CATALOG` from @repo/spot-core, the same rows
 * the routing engine, the open-mint gate and the card's issuer line already
 * use. It previously read a second, older list that held SpaceX and nothing
 * else, which meant an NVIDIA article could not match NVDAx no matter how
 * plainly it was about NVIDIA — the asset was tradeable, priced, and in the
 * card's own catalog, yet unreachable from a page. Two catalogs is one more
 * than a thing can have and still be true.
 *
 * ── WHAT "MATCH" MEANS HERE ─────────────────────────────────────────────────
 * The page must be ABOUT the asset. Being MENTIONED is not enough, and the
 * difference is the entire tuning problem. A CNBC piece about NVIDIA's funding
 * plans previously produced a SPACEX card, because the word "SpaceX" appeared
 * once in a related-links rail at the bottom. That is not a near miss; it is
 * the product offering someone a securities trade on the strength of a link
 * they did not read.
 *
 * Three rules now stand between a page and a card, and each exists because of a
 * specific way the old scoring was wrong:
 *
 *   1. A FLOOR. Score must clear MIN_SCORE. One passing mention cannot.
 *   2. PLACE MATTERS. A hit in the title or h1 is worth HEADLINE_WEIGHT body
 *      mentions. The headline is what a page is about; the body is what it
 *      happens to contain.
 *   3. NO WINNING BY A HAIR. If two assets score within DOMINANCE_RATIO of each
 *      other, nothing is shown. An article comparing NVIDIA and Micron is
 *      genuinely about both, and picking the one ahead by 8% would be a coin
 *      toss presented as a recommendation.
 *
 * Silence is the correct output for the overwhelming majority of pages, and
 * every rule here is written to fail towards it.
 */

/**
 * ── CALIBRATION ─────────────────────────────────────────────────────────────
 * Measured, not guessed. `asset-match/calibrate.ts` scores a labelled corpus of
 * real pages and prints the score of every true and false match; the constants
 * below are where those two populations separated. Re-run it when the catalog
 * changes — the report is the artefact, these are just where the answer is
 * written down.
 */

/** A headline hit is worth this many body mentions. */
const HEADLINE_WEIGHT = 8;
/** Each distinct corroborating term, once the page already names the asset. */
const THEMATIC_WEIGHT = 2;
/**
 * Body mentions stop counting past this. An article naming the asset forty
 * times is not four times better evidence than one naming it ten times, and
 * without a cap the LENGTH of a page starts to dominate its subject.
 */
const BODY_CAP = 12;
/**
 * The floor. Below this, a page is not about the asset.
 *
 * MEASURED over 23 real pages, 2026-08-12 (see calibrate.ts). Every score the
 * scorer produced, sorted, labelled by whether it was the right answer:
 *
 *   true   24, 28, 32, 34, 34, 34, 36, 36, 40, 48
 *   false   1, 1, 2, 3, 3, 3, 3, 4, 7, 9, 10, 10, 10, 12, 16, 18, 22
 *
 * Every one of those false matches is body-only, which is what
 * MIN_SCORE_WITHOUT_HEADLINE below is for. Among matches that DO hit the
 * headline there is no overlap at all: the weakest true one scores 24 and there
 * are no false ones. 20 leaves margin under it without reaching down into the
 * body-only population.
 *
 * A live browser run scores slightly differently from this harness, because the
 * extension sends innerText and this sends stripped HTML. Elon Musk's page
 * scores 18 here and 20 through the real pipeline — worth knowing before
 * trusting a two-point margin anywhere in this file.
 *
 * For reference, the failure that started this: a single "SpaceX" in a
 * related-links rail scored 4.
 */
const MIN_SCORE = 20;
/**
 * The floor for a match with NO headline hit, and it is much higher, because
 * the corpus was blunt about this: of 16 false matches, all 16 were
 * body-only. Not most — all of them. The headline turned out to be doing
 * nearly all of the discriminating, and a score assembled purely from
 * repetition is the shape every wrong answer had.
 *
 * The worst of them scored 20 (Elon Musk's page, which names Starlink and Crew
 * Dragon throughout while being about a person the catalog does not trade, and
 * which produced a live SPCX card at exactly the general floor). 28 puts eight
 * points between that and anything shown.
 *
 * BE HONEST ABOUT WHAT THIS DOES: at 28, body-only matching is not merely
 * strict, it is unreachable for most of the catalog. The maximum a body-only
 * match can score is BODY_CAP + 2 x (number of thematic terms the row has):
 *
 *   SPCX   12 + 28 = 40   reachable
 *   NVDAx  12 + 16 = 28   reachable, exactly, and only by naming every term
 *   MU     12 + 12 = 24   NOT reachable
 *   SPYx   12 + 10 = 22   NOT reachable
 *   CRCLx  12 +  8 = 20   NOT reachable
 *
 * So for three of five rows a page that never puts the asset in its headline
 * cannot produce a card at all, whatever it says. That is the current, measured
 * trade — chosen because the alternative was a two-point margin against a
 * pipeline whose scores already move by two points between this harness and a
 * live browser.
 *
 * The way to give a row back its body-only reach is to enrich its `thematic`
 * vocabulary in the catalog, which is evidence about the asset. Lowering this
 * number is not; it just moves the line into the population of pages that were
 * all wrong.
 */
const MIN_SCORE_WITHOUT_HEADLINE = 28;
/**
 * Body-only matches need real repetition. One passing mention is the exact
 * failure this pass exists to remove, so a page that never puts the asset in
 * its headline must say the name at least this many times.
 */
const MIN_BODY_MENTIONS_WITHOUT_HEADLINE = 3;
/**
 * The winner must beat the runner-up by this factor. Anything closer is a page
 * about both, and a page about both gets no card.
 */
const DOMINANCE_RATIO = 1.5;

export type AssetMatchConfidence = 'confident' | 'tentative';

export interface AssetMatch {
  mint: string;
  symbol: string;
  name: string;
  confidence: AssetMatchConfidence;
  score: number;
  /**
   * HOW the page was identified, which is a different question from how
   * strongly. `exact` means we READ the asset's identity — the URL is a
   * venue's dedicated page for it, or the page prints its mint. `inferred`
   * means the text scorer weighed the prose and concluded.
   *
   * Kept separate from `score` and `confidence` on purpose. Both of those
   * are degrees of the same guess; this says whether a guess was made at
   * all. It is what lets the card decide whether to open itself without
   * anybody inventing a threshold on an unbounded weighted sum.
   */
  certainty: MatchCertainty;
  /** which catalog terms fired, for debugging a bad match without a rerun */
  matchedDirect: string[];
  matchedThematic: string[];
}

/**
 * Why nothing was shown. Diagnostic only — the route returns `asset: null`
 * either way, because a reader must not be able to tell a near miss from a page
 * that was never a candidate.
 */
export type NoMatchReason =
  | 'no_terms'
  | 'below_floor'
  | 'mention_only'
  | 'low_confidence';

export interface MatchOutcome {
  match: AssetMatch | null;
  reason?: NoMatchReason;
  /** Every scored candidate, best first. For calibration and for logs. */
  candidates: AssetMatch[];
}

/**
 * The page's two surfaces, kept apart because rule 2 depends on the difference.
 * `title` and `h1` are what the page claims to be about; everything else is
 * what it contains. metaDescription sits with the body: it is author-written,
 * but it is also where SEO boilerplate lists every company a site covers.
 */
function surfaces(signals: PageSignals): { headline: string; body: string } {
  return {
    headline: [signals.title ?? '', signals.h1 ?? ''].join('\n'),
    body: [signals.metaDescription ?? '', signals.bodyExcerpt ?? ''].join('\n'),
  };
}

const BY_MINT = new Map<string, CuratedAsset>(
  CURATED_CATALOG.map((a) => [a.mint, a]),
);

/**
 * Score every catalog asset against a page and decide whether one of them wins
 * clearly enough to show.
 */
export function scorePage(signals: PageSignals): MatchOutcome {
  const { headline, body } = surfaces(signals);

  /**
   * READ BEFORE SCORING. A venue's dedicated page for an asset, or a page
   * printing that asset's mint, is not evidence about its subject — it IS
   * its subject, and weighing the prose of such a page is guessing at
   * something already stated. See venue-match.ts.
   *
   * The URL is checked first: it is the page's own claim about what it is,
   * where a mint in the text could belong to something the page merely
   * links to. Both are exact; the URL is exact about the SUBJECT.
   */
  const exact =
    matchByVenueUrl(signals.url) ?? matchByMintInText(signals.bodyExcerpt);
  if (exact) {
    const match = {
      mint: exact.mint,
      symbol: exact.ticker,
      name: exact.name,
      confidence: 'confident' as const,
      // Above every floor by construction. The number is not a measurement
      // here — nothing was measured — it exists so the field keeps one
      // meaning ("how strong is the case") for callers that sort on it.
      score: Number.MAX_SAFE_INTEGER,
      certainty: 'exact' as const,
      matchedDirect: [exact.ticker],
      matchedThematic: [],
    };
    return {
      match,
      // THE MATCH IS A CANDIDATE TOO. This used to be [], which read as
      // consistent ("the exact tier doesn't weigh candidates") and shipped
      // an absurdity: /candidates answered EMPTY on exactly the pages most
      // about a tradeable asset — CoinGecko, Yahoo, TradingView — because
      // their identity was decided before the candidate list was ever
      // built. The panel's trade surface was blank on the product's home
      // turf while working on incidental mentions. A page's certain answer
      // is its shortlist of one, not a reason to have no shortlist.
      candidates: [match],
    };
  }

  const named = matchCatalogTerms({ text: body, headline });
  if (named.length === 0) {
    return { match: null, reason: 'no_terms', candidates: [] };
  }

  const thematic = matchCatalogThematic({ text: body, headline });

  const candidates: AssetMatch[] = named.map((c) => {
    const asset = BY_MINT.get(c.mint);
    const thematicHits = thematic.get(c.mint) ?? 0;
    return {
      mint: c.mint,
      symbol: asset?.ticker ?? c.mint.slice(0, 6),
      name: asset?.name ?? c.term,
      // A headline hit is the page declaring its subject. Body-only is an
      // inference from repetition, and it is reported as such.
      confidence: c.headlineCount > 0 ? 'confident' : 'tentative',
      // Everything reaching this map was weighed, not read.
      certainty: 'inferred' as const,
      score:
        c.headlineCount * HEADLINE_WEIGHT +
        Math.min(c.bodyCount, BODY_CAP) +
        thematicHits * THEMATIC_WEIGHT,
      matchedDirect: [c.term],
      matchedThematic: thematicHits > 0 ? [`${thematicHits} corroborating`] : [],
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const runnerUp = candidates[1];
  if (!best) return { match: null, reason: 'no_terms', candidates };

  const bestNamed = named.find((c) => c.mint === best.mint);

  // Rule 1, and the body-only variant of it.
  if (
    bestNamed &&
    bestNamed.headlineCount === 0 &&
    bestNamed.bodyCount < MIN_BODY_MENTIONS_WITHOUT_HEADLINE
  ) {
    return { match: null, reason: 'mention_only', candidates };
  }
  const floor =
    best.confidence === 'confident' ? MIN_SCORE : MIN_SCORE_WITHOUT_HEADLINE;
  if (best.score < floor) {
    return { match: null, reason: 'below_floor', candidates };
  }

  // Rule 3. Deliberately AFTER the floor: two assets both scoring below the
  // floor are not "ambiguous", they are both simply absent.
  if (runnerUp && best.score < runnerUp.score * DOMINANCE_RATIO) {
    return { match: null, reason: 'low_confidence', candidates };
  }

  return { match: best, candidates };
}

/**
 * Best asset for a page, or null.
 *
 * Thin wrapper for callers that only want the answer. The reason is dropped
 * here rather than returned and ignored — the route must not start branching on
 * WHY there was no match, since every one of those branches ends in the same
 * `asset: null`.
 */
export function findAssetForPage(signals: PageSignals): AssetMatch | null {
  return scorePage(signals ?? {}).match;
}
