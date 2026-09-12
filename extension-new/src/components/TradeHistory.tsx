import { Box, Typography } from "@mui/material"
import { qtyText } from "~/helpers/qtyText"
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { handleOfSource } from "~/helpers/popLanguage"
import {
  myHistoryAsset,
  type MyHistoryRow,
} from "~/services/SpotAssetService"
import { ACCENT, DIM, FAINT, GREEN, PANEL_PILL, PANEL_ROW, RED, usd } from "~/helpers/panelSurface"
import { priceText } from "~/helpers/priceText"

/**
 * THE LEDGER, READABLE. Every buy and sell the product signed, newest
 * first — the panel's answer to "what did I actually trade". Orders is
 * money committed and Activity is transfers on chain; this is the trades
 * themselves, from spot_trades via /spot/social/my-history (failed rows
 * excluded server-side: a swap that never landed shown as a trade is a
 * lie with the reader's money in it).
 *
 * Each row is a door when it can be: the trade that came from a tweet
 * opens THAT tweet (source_url — the caller-credit substrate paying its
 * first reader-facing dividend), and every trade can open its transaction
 * on Solscan. Symbol prints the curated ticker or the short mint — the
 * list never asks anybody's network for a name.
 */

/** The house rule, in one place: see helpers/qtyText. */

/** "14:32 · Aug 29" — time first: today's trades are the ones re-read. */
/**
 * The ledger's ONE date grammar, exported: TokenView borrowed the chart's
 * range formatter for the same rows, so the same trade wore two different
 * dates in two rooms. Time first, deliberately - today's trades are the
 * re-read ones.
 */
export function when(at: number): string {
  const d = new Date(at)
  const hm = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return `${hm} · ${md}`
}

export default function TradeHistory() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<MyHistoryRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const asked = useRef(-1)

  useEffect(() => {
    if (asked.current === attempt) return
    asked.current = attempt
    let alive = true
    myHistoryAsset(50)
      .then((r) => {
        if (!alive) return
        setRows(Array.isArray(r?.trades) ? r.trades : [])
        setFailed(false)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [attempt])

  if (failed) {
    return (
      <Typography sx={{ fontSize: 12.5, color: DIM }}>
        Could not read your trades.{" "}
        <Box
          component="span"
          onClick={() => setAttempt((n) => n + 1)}
          sx={{ color: ACCENT, cursor: "pointer", fontWeight: 700 }}
        >
          Try again
        </Box>
      </Typography>
    )
  }
  if (rows === null) {
    return <Typography sx={{ fontSize: 12.5, color: DIM }}>Reading your ledger…</Typography>
  }
  if (rows.length === 0) {
    return (
      <Typography sx={{ fontSize: 12.5, color: DIM }}>
        Nothing yet. Your first trade starts the ledger.
      </Typography>
    )
  }

  return (
    <Box>
      {rows.map((t) => {
        const symbol = (t.symbol ?? `${t.mint.slice(0, 4)}…`).replace(/^\$/, "")
        /**
         * THE ROW LEADS BACK IN, THE CHIP LEADS OUT.
         *
         * Every tap here used to open a new tab - the tweet, or Solscan -
         * so the ledger, which is where a reader arrives asking "what did
         * I do and what now", had no door that stayed inside the product.
         * Reading your own history is the moment you are most likely to
         * trade again, and it was the moment we showed people the exit.
         *
         * The row now opens the asset's own room, where the answer to
         * "what now" lives. The outside link is not lost, it is just no
         * longer the whole row: it is a chip that says where it goes.
         */
        const away = t.sourceUrl ?? `https://solscan.io/tx/${t.signature}`
        return (
          <Box
            key={t.signature}
            onClick={() => navigate(`/token/${t.mint}`)}
            sx={{
              ...PANEL_ROW,
              p: 1.5,
              mb: 1,
              display: "flex",
              alignItems: "center",
              gap: 1.25,
              cursor: "pointer",
              transition: "border-color 150ms ease-out",
              "&:hover": { borderColor: `${ACCENT}66` },
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>
                <Box component="span" sx={{ color: t.side === "buy" ? GREEN : RED }}>
                  {t.side === "buy" ? "Bought" : "Sold"}
                </Box>{" "}
                {usd(t.amountUsd)} of {symbol}
              </Typography>
              <Typography
                sx={{ fontSize: 11.5, color: DIM, fontVariantNumeric: "tabular-nums" }}
              >
                {when(t.at)}
                {/* THE AUTHOR, BY NAME. This said "from a tweet", which is
                    the fact stripped of the only part that means anything:
                    the row already knows whose post it was, because the
                    ledger stores source_url and my-history has always sent
                    it. A reader scrolling their own history recognises
                    "@alldomains_" and remembers the decision; "a tweet"
                    could be anyone's. Falls back to the generic line when
                    the url is not an x.com status, rather than guessing. */}
                {t.sourceUrl
                  ? handleOfSource(t.sourceUrl)
                    ? ` · from @${handleOfSource(t.sourceUrl)}`
                    : " · from a post"
                  : ""}
              </Typography>
              {/* THE EXECUTION ITSELF — quantity, price, fee. These were
                  on the wire and dropped on the floor, the exact pattern
                  this codebase keeps finding. Null says nothing: a
                  pre-quantity row keeps its two lines and no more, and a
                  zero fee is silence, not "fee $0.00". */}
              {(typeof t.qtyUi === "number" && t.qtyUi > 0) ||
              (typeof t.feeUsd === "number" && t.feeUsd >= 0.005) ? (
                <Typography
                  sx={{ fontSize: 11, color: DIM, fontVariantNumeric: "tabular-nums" }}
                >
                  {typeof t.qtyUi === "number" && t.qtyUi > 0
                    ? `${qtyText(t.qtyUi)} ${symbol}` +
                      (typeof t.priceUsd === "number" && t.priceUsd > 0
                        ? ` @ ${priceText(t.priceUsd)}`
                        : "")
                    : ""}
                  {typeof t.feeUsd === "number" && t.feeUsd >= 0.005
                    ? `${typeof t.qtyUi === "number" && t.qtyUi > 0 ? " · " : ""}fee ${usd(t.feeUsd)}`
                    : ""}
                </Typography>
              ) : null}
            </Box>
            <Box
              component="button"
              className="click-animation"
              aria-label={t.sourceUrl ? "Open the tweet" : "Open the transaction"}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation()
                window.open(away, "_blank", "noopener")
              }}
              sx={{
                ...PANEL_PILL,
                flexShrink: 0,
                px: 1,
                py: "3px",
                cursor: "pointer",
                font: "inherit",
                fontSize: 10.5,
                fontWeight: 700,
                color: FAINT,
                "&:hover": { color: ACCENT },
              }}
            >
              {t.sourceUrl ? "tweet ↗" : "tx ↗"}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
