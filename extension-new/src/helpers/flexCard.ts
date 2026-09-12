import { usd } from "~/helpers/panelSurface"
import type { TradeCardData } from "~/helpers/tradeCard"

/**
 * A POSITION, COMPOSED INTO A FLEX CARD.
 *
 * The owner's rule: "FOMO'da flex unrealized pnl ile oluyor ve bence bir
 * mantığı var." So the flex leads with UNREALIZED profit — what the reader
 * is holding right now, not what they have already banked — because that is
 * the number that makes someone else want in. A closed position (nothing
 * held) flexes its REALIZED result instead, which is the only honest number
 * left once the coins are gone.
 *
 * UNREALIZED IS NOT pnlUsd. positions() reports pnlUsd as TOTAL profit
 * (realized + unrealized folded together), so on a mint the reader has
 * partly sold, pnlUsd overstates what they still hold. The honest unrealized
 * number is (price_now − average_cost) × units_held, and it needs a real
 * average cost — a position that predates the ledger's quantity columns has
 * none, and flexes nothing rather than a guess.
 */
export interface FlexInput {
  ticker: string
  uiAmount: number
  priceUsd: number | null
  avgEntryPriceUsd?: number | null
  realizedPnlUsd?: number | null
  callerSourceUrl?: string | null
}

/** @x from an x.com/<handle>/status/<id> permalink, else null. */
export function callerHandle(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null
  const m = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(
    sourceUrl,
  )
  return m ? m[1] : null
}

export interface FlexParts {
  /** The headline the card prints big, colored by tone. */
  action: string
  /** The quieter line under it. */
  subline: string
  tone: "up" | "down"
  /** "via @caller", or null. */
  credit: string | null
}

/**
 * The card's action / subline / tone / credit for a position, or null when
 * there is nothing honest to flex (no basis, no held units and nothing
 * banked, no live price).
 */
export function flexParts(input: FlexInput): FlexParts | null {
  const held = input.uiAmount > 0
  const hasEntry =
    typeof input.avgEntryPriceUsd === "number" && input.avgEntryPriceUsd > 0
  const price = input.priceUsd

  // A position still open flexes its UNREALIZED profit — the point of a flex.
  if (held && hasEntry && price !== null && price > 0) {
    const entry = input.avgEntryPriceUsd as number
    const unreal = (price - entry) * input.uiAmount
    const pct = ((price - entry) / entry) * 100
    const tone = unreal >= 0 ? "up" : "down"
    return {
      // The WORD carries the direction, so the number is a bare magnitude —
      // "Up $150", not "Up +$150" (the sign and the word said it twice).
      action: `${tone === "up" ? "Up" : "Down"} ${usd(Math.abs(unreal))}`,
      subline: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% on $${input.ticker.replace(/^\$/, "")} · holding`,
      tone,
      credit: creditLine(input.callerSourceUrl),
    }
  }

  // Nothing held but something banked: the closed position flexes its
  // realized result. Realized only — an exited position has no "now" to
  // mark against, so there is no unrealized number to lead with.
  if (
    !held &&
    typeof input.realizedPnlUsd === "number" &&
    Math.abs(input.realizedPnlUsd) >= 0.005
  ) {
    const r = input.realizedPnlUsd
    const tone = r >= 0 ? "up" : "down"
    return {
      action: `${tone === "up" ? "Banked" : "Lost"} ${usd(Math.abs(r))}`,
      subline: `Closed $${input.ticker.replace(/^\$/, "")} · realized`,
      tone,
      credit: creditLine(input.callerSourceUrl),
    }
  }

  return null
}

function creditLine(sourceUrl: string | null | undefined): string | null {
  const h = callerHandle(sourceUrl)
  return h ? `via @${h}` : null
}

/**
 * Fold the flex parts onto a TradeCardData. The caller supplies the shared
 * fields (series, mcap, price, handle, icon, logo) exactly as the buy card
 * does; this only sets the flex-specific action/subline/tone/credit.
 */
export function flexCardData(
  base: Omit<TradeCardData, "action" | "tone" | "subline" | "credit">,
  parts: FlexParts,
): TradeCardData {
  return {
    ...base,
    action: parts.action,
    tone: parts.tone,
    subline: parts.subline,
    credit: parts.credit,
  }
}
