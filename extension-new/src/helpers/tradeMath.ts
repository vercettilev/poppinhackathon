/**
 * The trade arithmetic and the trade CONSTANTS both money surfaces share.
 *
 * The page card and the panel's trade sheet each turn a typed USD amount
 * into raw base units of a holding. Two copies of this math is how "Max"
 * oversells by a rounding hair on one surface and not the other — the same
 * one-source rule the chips, the ground and the notification wording already
 * live under.
 *
 * Proportional over the KNOWN balance: raw = balanceRaw × (usd / holdingUsd),
 * clamped to the balance so "Max" can never oversell. The sell endpoint takes
 * raw and the client must not invent decimals.
 */
export function usdToRawOfHolding(
  usd: number,
  balance: { uiAmount: number; raw: string },
  usdPrice: number,
): string {
  const holdingUsd = balance.uiAmount * usdPrice
  if (!(holdingUsd > 0)) return "0"
  const frac = Math.min(usd / holdingUsd, 1)
  const raw = (BigInt(balance.raw) * BigInt(Math.round(frac * 1_000_000))) / 1_000_000n
  return String(raw)
}

/**
 * Re-read a holding after a fill until the chain agrees that it CHANGED.
 *
 * The old version of this was one read, fired the moment a trade settled —
 * and one read is not an answer. `confirmed` commitment does not mean every
 * node has the block, so that read lands on either side of the trade at
 * random. Landing on the old side is what made "Max" sell less than
 * everything right after a buy, and it left the sell chips describing a
 * position the reader no longer had.
 *
 * So: keep reading until the raw amount differs from what it was BEFORE the
 * trade, then stop. Bounded, and it keeps the last successful read if the
 * chain never gets around to differing — a stale number beats a blank one.
 * Failure-silent by contract: the trade already happened, and a balance probe
 * that could not answer is not a reason to put an error on it.
 *
 * Both money surfaces use this over their own transport (the panel calls the
 * API directly, the card goes through the background worker), which is why
 * the read is injected rather than imported.
 */
export async function settledBalance<T extends { raw: string }>(
  read: () => Promise<T | null>,
  before: string | null,
  attempts = 5,
  gapMs = 900,
): Promise<T | null> {
  let last: T | null = null
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapMs))
    try {
      const b = await read()
      if (!b) continue
      last = b
      if (before === null || b.raw !== before) return b
    } catch {
      // Silent on purpose — see above.
    }
  }
  return last
}

/** A short server reason if one came back, the fallback otherwise. */
export function reasonOf(e: unknown, fallback: string): string {
  const m = (e as { message?: string })?.message
  return typeof m === "string" && m.length > 0 && m.length < 120 ? m : fallback
}

/**
 * The three pre-typed buy amounts.
 *
 * The card settled these (10/25/100) and the panel's sheet shipped with
 * 1/5/20 because I retyped them instead of importing — the exact drift this
 * codebase keeps burying. They live here now so there is one answer.
 */
export const PRESET_USD = [10, 25, 100] as const

/** Sell presets are FRACTIONS of the holding — a $100 chip against a $4
 *  position is an answer to a question nobody asked. */
export const SELL_FRACTIONS = [0.25, 0.5, 1] as const
