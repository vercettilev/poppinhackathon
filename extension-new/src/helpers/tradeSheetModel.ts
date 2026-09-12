import { MIN_ORDER_USD, planBuyOrder, planSellOrder } from "./orderMath"
import { PRESET_USD } from "./tradeMath"
import { priceText } from "./priceText"

/**
 * ONE TRADE SHEET, THREE SURFACES.
 *
 * The X chip, the docked card and the sidebar panel all ask a reader the same
 * four questions — which direction, at the market or at a price, how much,
 * and (for a limit) what price — and all three then have to answer the same
 * ones back: is this a profit, is it a valid order, can it be paid for, and
 * what will the button do.
 *
 * They used to answer them separately, and the drift was measured rather than
 * feared: the chip knew about cost basis in nineteen places and the panel in
 * zero, so the same "+10%" button meant a profit on one surface and a number
 * off the tape on the other. The panel is the surface this product calls the
 * app, and it was the wrong one.
 *
 * So the decisions live here, as a pure function of (market, reader, state) →
 * a view. This module renders nothing and fetches nothing: it is the rulebook
 * the three renderers read, the same way orderMath is the rulebook this one
 * reads. A surface may lay the view out however it likes; it may not disagree
 * with it.
 */

export type Side = "buy" | "sell"
export type Kind = "market" | "limit"

/**
 * What the reader has. `null` while it is still loading — which is NOT the
 * same as "nothing", and never blocks a trade: an unread balance must not
 * refuse an order the server would have accepted.
 */
export interface Reader {
  /** Spendable USD. */
  cashUsd: number
  /** Holding in UI units, for display. */
  uiAmount: number
  /** Holding in RAW units, echoed from the server — what a sell is sized in. */
  raw: string
  /**
   * Average cost of one unit. `null` = unknowable (the position predates the
   * ledger), which is NOT zero and must never be printed as if it were.
   */
  /**
   * Market cap at the reader's FIRST buy of this asset. Replaces the
   * `entryUsd` this file used to divide into existence: recorded at the
   * trade, so it needs no cost basis, no division and no lot matching, and
   * it survives partial sells, deposits from outside and trades made
   * anywhere else. Null for anything bought before the ledger recorded it,
   * which stays silent rather than guessing from today's.
   */
  entryMcapUsd: number | null
  /**
   * True average cost of one unit still held — the avg-cost walk's answer,
   * immune to partial sells (unlike a net-invested quotient). Null when the
   * ledger cannot compute it. The chart's dashed entry level reads this.
   */
  avgEntryPriceUsd?: number | null
}

export interface SheetState {
  side: Side
  kind: Kind
  /** Raw text from the price field, so an empty field stays distinguishable. */
  priceText: string
  /** Buy size, in dollars. */
  usd: number
  /** Sell size, as a percentage of the holding. */
  pct: number
  /**
   * USD escrowed in standing BUY orders, when the sheet has been told.
   * Absent changes nothing — the balance line simply says less, which is
   * what it said before this existed.
   */
  committedUsd?: number
}

/**
 * WHY THERE ARE NO PERCENTAGE BUTTONS HERE ANY MORE.
 *
 * There were: -5/-10/-20 to buy, +10/+25/+50 to sell, filling the price
 * field on one tap. They were mine, not the product's, and the product owner
 * was right to cut them. A limit order asks one question — at what price —
 * and answering it with a percentage of something else makes the reader
 * translate twice: from the percentage to a price, and from the price back
 * to whether they meant it.
 *
 * What survives is the READING, which is the same arithmetic pointed the
 * other way: type a price and the sheet says what it means. That is an
 * answer, not a control, and for a sell it is still measured from the
 * average entry rather than the tape.
 */
/** A sell is a decision about how much of a position to let go. */
export const SELL_PCTS = [25, 50, 100] as const

/**
 * A fraction of a raw balance, in raw units, without touching a float.
 * Balances are u64 strings for a reason — 1e-9 of a token is a real amount,
 * and Number would round somebody's exit. 100% is exact by construction.
 */
export function fractionRaw(raw: string | null, pct: number): string {
  if (raw === null) return "0"
  try {
    if (pct >= 100) return BigInt(raw).toString()
    return ((BigInt(raw) * BigInt(Math.round(pct * 100))) / 10_000n).toString()
  } catch {
    return "0"
  }
}

/** Prices are printed with more decimals under a dollar, everywhere. */
export function decimalsFor(usd: number): number {
  return usd < 1 ? 6 : 2
}

export interface SizeOption {
  label: string
  value: number
  selected: boolean
}

export type Tone = "good" | "bad" | "muted"

/** Exactly what the surface will send, or null when it must not send. */
export type TradeIntent =
  | { kind: "market-buy"; usd: number }
  | { kind: "market-sell"; pct: number; amountRaw: string }
  | { kind: "limit-buy"; usd: number; triggerPriceUsd: number }
  | { kind: "limit-sell"; pct: number; amountRaw: string; triggerPriceUsd: number }

export interface SheetView {
  /** Heading over the price field. Absent on a market trade. */
  priceLabel: string | null
  sizeLabel: string
  sizes: SizeOption[]
  /**
   * What the typed price MEANS, against the thing it should be compared to.
   * `null` on a market trade, which has no price to judge.
   */
  /** `word` is the prose half of `text` — the surface renders it in the
   *  product face so a reading stops sounding like a terminal readout. */
  reading: { text: string; tone: Tone; word?: string } | null
  /** The line about the reader, or null while it is unknown. */
  balance: { text: string; low: boolean } | null
  action: {
    label: string
    /** `fund` is the door out, not a trade. */
    tone: Side | "wait" | "fund"
    armed: boolean
  }
  /** The live reason the action is not armed, shown verbatim. */
  note: string | null
  /** How the note is dressed: a plan problem is an error, a statement of
   *  fact ("That's your whole position") is information. */
  noteTone: "err" | "info"
  intent: TradeIntent | null
}

/**
 * A BALANCE and a PRICE are not written the same way, and one helper for both
 * gets one of them wrong. Cash carries its cents — "$432.10", never "$432.1".
 * A price does not carry trailing zeros, and under a dollar it needs more
 * digits than cash ever does: "$142", "$0.005178".
 */
function cash(usd: number): string {
  return usd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtPrice(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: decimalsFor(usd) })
}

/**
 * A market cap, in the units traders speak it in: $2.9M, $340K, $1.2B.
 * Deliberately coarse — three significant figures is how a cap is quoted,
 * and the coarseness is also what lets this number be honest where a
 * per-unit price cannot be, since it absorbs the difference between a
 * quoted and an executed fill.
 */
function mcap(usd: number): string {
  const [div, suffix] =
    usd >= 1e9 ? [1e9, "B"] : usd >= 1e6 ? [1e6, "M"] : usd >= 1e3 ? [1e3, "K"] : [1, ""]
  const v = usd / div
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : v < 100 ? 1 : 0 })}${suffix}`
}

function units(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 })
}

function signed(pct: number): string {
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`
}

export function viewTradeSheet(args: {
  ticker: string
  /** Live price, or null when the feed is down. */
  marketUsd: number | null
  reader: Reader | null
  state: SheetState
  /**
   * Whether THIS surface can move money in without leaving the page — true
   * only where an injected wallet exists (the chip and the card on a real
   * page; never the side panel, which no wallet reaches).
   *
   * It changes one thing: the words on the funding button. A reader who is
   * about to see their wallet's approval window should have been told that
   * by the button they pressed, and a reader who is about to be sent to the
   * panel should not be promised a wallet that will not appear.
   */
  walletOnPage?: boolean
}): SheetView {
  const { ticker, marketUsd, reader, state, walletOnPage } = args
  const selling = state.side === "sell"
  const limit = state.kind === "limit"

  const held = reader?.uiAmount ?? null
  /**
   * BOTH SIDES ARE JUDGED AGAINST THE TAPE.
   *
   * A sell used to be judged against `entryUsd` — the same
   * netInvestedUsd / uiAmount that the balance line printed and that this
   * file now explains at length. So the one number a reader actually used
   * to place a take-profit was anchored on a figure that drifts on every
   * partial sell and goes negative after a profitable round trip.
   *
   * "How far is my trigger from the price right now" is provable, is the
   * same question the buy side already asks, and is what a limit order is
   * actually placed against. The profit reading comes back when the ledger
   * can answer it honestly, not before.
   */
  const anchor = marketUsd

  // ── what the reader can do ──────────────────────────────────────────────
  // A trigger order escrows its funds when it is CREATED, so a buy above the
  // cash balance is a round trip to a refusal. A sell needs something to sell.
  // Both stay silent while the reader is unknown.
  //
  /**
   * ONE POCKET. USDC is the product's money, full stop — the owner's call
   * ("temel ürün USDC olsa... daha smooth olmaz mı"), and the gasless
   * architecture had already made it: the whole gas tank exists so a
   * USDC-only wallet can trade.
   *
   * There USED to be a second pocket here: a market buy could draw on the
   * reader's SOL when USDC fell short. Every complication this session
   * kept paying for traced back to that one branch — the wrap service,
   * the wSOL fee account, a balance line quoting two currencies, and a
   * funding story that had to explain both. Deposit USDC is the one
   * sentence now, said everywhere money is short.
   */
  const cannotPay = selling
    ? held !== null && held <= 0
    : reader !== null && reader.cashUsd < state.usd

  // ── the typed price, and what it means ────────────────────────────────
  const typed = state.priceText.trim()
  const price = typed === "" ? null : Number(typed)
  const priceOk = price !== null && Number.isFinite(price) && price > 0

  /**
   * How far the typed price is from the thing it should be judged against:
   * the entry for a sell, the tape for a buy. This is the number the reader
   * came for, and it is not the same question as whether the order is valid.
   */
  const readingPct =
    !priceOk || anchor === null || anchor <= 0
      ? null
      : ((price - anchor) / anchor) * 100

  /**
   * A sell's percentage is DERIVED from a typed dollar amount, so it lands on
   * 49.98 rather than 50 and an exact comparison would never mark anything.
   * The tolerance is what makes "half" still read as half.
   */
  const sizes: SizeOption[] = selling
    ? SELL_PCTS.map((v) => ({
        label: v === 100 ? "Max" : `${v}%`,
        value: v,
        selected: Math.abs(state.pct - v) < 0.5,
      }))
    : PRESET_USD.map((v) => ({ label: `$${v}`, value: v, selected: v === state.usd }))

  // ── is it a valid order ─────────────────────────────────────────────────
  const plan = !limit
    ? null
    : selling
      ? planSellOrder(held ?? 1, priceOk ? price : 0, marketUsd)
      : planBuyOrder(state.usd, priceOk ? price : 0, marketUsd)

  /**
   * TWO QUESTIONS, TWO ANSWERS, AND THEY MUST NOT SHARE ONE SIGNAL.
   *
   * "How far from the tape is this?" and "is this a valid order?" are
   * independent, and a sell is where they come apart: a target just under
   * the tape reads as a small distance and is not an order at all, because
   * a trigger sell fills at the price or better and anything under the tape
   * is just selling now. Painting the distance by the plan's verdict would
   * colour a near miss red and teach nobody why the button is dark.
   */
  const reading: SheetView["reading"] = !limit
    ? null
    : readingPct === null
      ? {
          // Nothing typed yet. This used to read "pick a drop" — an
          // instruction pointing at percentage buttons that no longer
          // exist. What an empty field should say is what the number WILL
          // be measured against, so the reader knows before they type.
          // Both sides measure against the tape now, so there is one
          // answer here instead of a branch that used to name two
          // different anchors.
          text: typed === "" ? (anchor === null ? "" : "vs now") : "no live price",
          word: typed === "" ? "vs now" : "no live price",
          tone: "muted",
        }
      : {
          // THE READING IS A SENTENCE, not a bare signed number. "−10.3%"
          // alone is a terminal's answer; "10.3% below now" is what the
          // reader was asking. The figure keeps the data voice, the words
          // are prose (the chip wraps `word` in its own span).
          text: `${signed(readingPct)} vs now`,
          word: "vs now",
          // A buy wants a trigger BELOW the tape; a sell wants one ABOVE
          // it. Opposite signs, one meaning: is this the direction the
          // reader is hoping for.
          tone: (selling ? readingPct > 0 : readingPct < 0) ? "good" : "bad",
        }

  // ── the line about the reader ───────────────────────────────────────────
  let balance: SheetView["balance"] = null
  if (reader) {
    if (selling) {
      const worth = marketUsd === null ? "" : ` · $${cash(reader.uiAmount * marketUsd)}`
      /**
       * "entry $X" AND ITS PERCENT ARE GONE, and they were not a rounding
       * problem — they were the wrong quantity.
       *
       * entryUsd was netInvestedUsd / uiAmount: net CASH OUT (buys minus
       * sells, in dollars) divided by the units still held. That is a cost
       * basis only for a position that has never been sold. Sell some at a
       * profit and the numerator falls faster than the denominator, so the
       * "entry" drifts down; sell enough and it goes NEGATIVE, at which
       * point the percent was suppressed and the screen still printed
       * "entry $-3.20". Units acquired anywhere but the extension inflate
       * the divisor too, because uiAmount is an RPC wallet scan while
       * netInvested comes only from our own ledger.
       *
       * The tests did not catch it because they were written to agree with
       * it: every one hand-writes a plausible average cost, and the single
       * test that goes through the real derivation picks a never-sold buy —
       * the one case where the formula happens to be right.
       *
       * What replaces it is the market cap at the moment of the trade, once
       * the ledger carries it: "in at $2.9M MC" is a fact recorded at trade
       * time, needs no basis and no division, and survives partial sells and
       * outside deposits. Until then the sheet says what it can prove: how
       * much is held, and what it is worth now.
       */
      const inAt =
        reader.entryMcapUsd === null || reader.entryMcapUsd <= 0
          ? ""
          : ` · in at ${mcap(reader.entryMcapUsd)} MC`
      balance = {
        text: `You hold ${units(reader.uiAmount)}${worth}${inAt}`,
        low: cannotPay,
      }
    } else {
      // One currency, named, so the number and the deposit door speak the
      // same word. "Balance $9.46 + $0.99 SOL" was two pockets and a
      // footnote; USDC is the money now.
      //
      // AND WHAT IS PARKED. A standing buy escrows its USDC the moment it
      // is placed, so this number correctly drops by that much — and a
      // reader who placed a $300 order read the drop as money gone
      // missing. Saying where it went costs six words and closes the
      // whole question.
      const parked =
        state.committedUsd && state.committedUsd > 0
          ? ` · $${cash(state.committedUsd)} in orders`
          : ""
      balance = {
        text: `USDC balance $${cash(reader.cashUsd)}${parked}`,
        low: cannotPay,
      }
    }
  }

  // ── the button, and what it will actually send ──────────────────────────
  const amountRaw = fractionRaw(reader?.raw ?? null, state.pct)
  let action: SheetView["action"]
  let intent: TradeIntent | null = null
  let note: string | null = null
  let noteTone: "err" | "info" = "err"

  if (cannotPay) {
    action = selling
      ? { label: "Nothing to sell", tone: "wait", armed: false }
      : {
          // "Deposit USDC", not "Add funds": the owner's ask is that the
          // one thing a short balance needs is UNMISSABLE, and a label
          // that names the currency is also the instruction.
          label: walletOnPage ? "Top up from wallet" : "Deposit USDC",
          tone: "fund",
          armed: true,
        }
  } else if (!limit && selling && marketUsd === null && (reader?.uiAmount ?? 0) > 0) {
    /**
     * A HOLDING WITHOUT A TAPE CANNOT BE SIZED. pct is derived from typed
     * dollars over the position's worth, and with no live price the worth
     * is unknowable - the old path armed "Sell $25", sent a 0% sell, and
     * answered the reader who demonstrably holds the token with "Nothing
     * to sell". The never-refuse rule is about unknown BALANCES; an
     * unknown PRICE disarms with the sentence the size buttons already use.
     */
    action = { label: "Waiting for a price…", tone: "wait", armed: false }
  } else if (!limit) {
    // ONE UNIT ON BOTH SIDES. The amount field speaks dollars, so the button
    // does too — "Sell 0.407%" is what a derived fraction looks like when it
    // leaks into a label, and it is not a sentence anybody meant to write.
    /**
     * THE CLAMP IS NOT ALLOWED TO BE SILENT. A sell for more than the
     * holding is worth still executes as a 100% sell — that part is right,
     * the reader plainly means "all of it" — but the button used to keep
     * saying the typed figure: "Sell $25" over a $3 position, the trade
     * moves $3, and the receipt reports 100% of a number the reader never
     * chose. On the exit side, where trust decides whether the return
     * loop survives, the label now says what will actually happen.
     */
    const worthUsd =
      selling && reader && marketUsd !== null && marketUsd > 0
        ? reader.uiAmount * marketUsd
        : null
    const wholePosition =
      worthUsd !== null && worthUsd > 0 && state.usd > worthUsd
    action = {
      label: wholePosition
        ? `Sell all ($${Number((worthUsd as number).toFixed(2))})`
        : `${selling ? "Sell" : "Buy"} $${Number(state.usd.toFixed(2))}`,
      tone: state.side,
      armed: true,
    }
    if (wholePosition) {
      note = "That's your whole position"
      noteTone = "info"
    }
    intent = selling
      ? { kind: "market-sell", pct: state.pct, amountRaw }
      : { kind: "market-buy", usd: state.usd }
  } else if (!priceOk || !plan?.ok) {
    // bad_price is the empty field, which is a starting state and not a fault
    if (plan && !plan.ok && plan.problem !== "bad_price") note = plan.note
    /**
     * SAY THE GAP, NOT THE VERB. A disarmed key repeating "Place order"
     * tells a reader nothing about why it will not go; the one thing
     * missing at this point is the price, so the button asks for it.
     */
    action = { label: "Type a price", tone: "wait", armed: false }
  } else {
    /**
     * THE MONEY AND THE CONDITION, not the taxonomy. "Place order" is an
     * exchange's word for the mechanism; what the reader is doing is
     * buying $25 if it gets to a price. Mirrors the market key, which has
     * named its own money since the day it shipped.
     */
    action = {
      label: `${selling ? "Sell" : "Buy"} ${
        selling ? `${state.pct}%` : `$${Number(state.usd.toFixed(2))}`
      } at ${priceText(price)}`,
      tone: state.side,
      armed: true,
    }
    intent = selling
      ? { kind: "limit-sell", pct: state.pct, amountRaw, triggerPriceUsd: price }
      : { kind: "limit-buy", usd: state.usd, triggerPriceUsd: price }
  }

  return {
    priceLabel: !limit
      ? null
      : selling
        ? `Sell $${ticker} at`
        : `Buy $${ticker} when it drops to`,
    sizeLabel: selling ? "How much of your position" : "Amount",
    sizes,
    reading,
    balance,
    action,
    note,
    noteTone,
    intent,
  }
}

export { MIN_ORDER_USD, PRESET_USD }

/* marketBuyPayWith LIVED HERE and is gone with the SOL pocket: USDC is
 * the only money a buy spends, so there is no pocket to pick. */
