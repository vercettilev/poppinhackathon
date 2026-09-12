import { Box, Typography } from "@mui/material"
import { useEffect, useRef, useState } from "react"
import { sendApiRequest } from "~/lib/fetchService"
import { ACCENT, DIM } from "~/helpers/panelSurface"

/**
 * FUND WITH ANY CRYPTO, WITHOUT LEAVING THE SHEET.
 *
 * Blink's hosted flow, mounted INLINE (presentation: "embedded") into a
 * container inside the panel, so somebody who pressed Buy with an empty
 * balance can bring ETH or SOL from wherever they hold it and come back to
 * the same sheet. No navigation, no second window.
 *
 * ── IT TRIES IN PLACE AND FALLS BACK, RATHER THAN GUESSING ──────────────────
 * Blink's docs are explicit that the wallet layer behind their flow (Privy)
 * "gates authentication by the top-level page origin", and their domain
 * allowlist accepts a hostname or localhost — a `chrome-extension://` origin
 * is not a documented input. Nesting our own iframe does not help: the
 * top-level document is still this panel.
 *
 * So this does not bet on the answer. It mounts embedded; if the flow
 * refuses the origin (or fails for any other reason) it opens
 * app.poppin.so/fund, which is a registered domain and where the same rail
 * works today. If Blink confirms the extension origin, the fallback simply
 * stops being reached — no flag, no deploy, nothing to remember to remove.
 *
 * ── WHY THE PANEL AND NOT THE CHIP ──────────────────────────────────────────
 * Measured, not assumed: x.com's response carries
 *   frame-src 'self' accounts.google.com … *.stripe.com *.plaid.com …
 * and pay.blink.cash is not on it. An iframe injected by a content script is
 * still subject to the PAGE's policy, so on X this is blocked by X, not by
 * us — no configuration on our side changes it. The panel is an extension
 * page whose CSP is ours, so it works here.
 *
 * The chip's answer to the same problem is the wallet already on the page
 * (helpers/pageWalletBridge), which needs no iframe at all.
 *
 * ── THE SIGNER IS OURS ──────────────────────────────────────────────────────
 * Their flow moves the money; the one thing we contribute is a signature
 * proving the destination is THIS caller's own custodial wallet. The
 * function form of `signer` is required rather than the URL form, because
 * our endpoint sits behind the session and the URL form posts without
 * headers. Everything that aims money is derived server-side from the uid.
 */

const BLINK_SOLANA_CHAIN_ID = 792703809
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

type Phase = "idle" | "opening" | "open" | "done" | "unavailable"

export function BlinkFund({ onFunded }: { onFunded?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let alive = true
    // The row exists only where the rail does. Same gate the funding page
    // uses, so a deploy without keys shows this to nobody.
    sendApiRequest<{ blink?: boolean }>({ url: "/fund/options", method: "GET" })
      .then((o) => {
        if (alive) setEnabled(!!o?.blink)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const open = async () => {
    if (!host.current) return
    const startedAt = Date.now()
    setPhase("opening")
    try {
      const wallet = await sendApiRequest<{ wallet?: { public_key?: string } }>({
        url: "/wallets/me",
        method: "GET",
      })
      const dest = wallet?.wallet?.public_key
      if (!dest) {
        setPhase("unavailable")
        return
      }
      // Loaded at the moment somebody funds, never at panel start.
      const { Deposit } = await import("@swype-org/deposit")
      const deposit = new Deposit({
        presentation: "embedded",
        containerElement: host.current,
        embedMaxHeightPx: 520,
        signer: async (req: { amount?: number | null }) =>
          sendApiRequest({
            url: "/fund/blink-sign",
            method: "POST",
            data: { amount: req?.amount ?? null, callbackScheme: null },
          }),
      })
      setPhase("open")
      await deposit.requestDeposit({
        // The reader chooses inside the flow, where they can see what their
        // ETH is worth in USDC.
        amount: null,
        chainId: BLINK_SOLANA_CHAIN_ID,
        address: dest,
        token: SOLANA_USDC_MINT,
      })
      setPhase("done")
      onFunded?.()
    } catch (e) {
      /**
       * A closed flow and a refused origin look almost the same from here,
       * and neither is worth an error message on a sheet somebody is
       * mid-trade in. The difference that matters is TIME: a reader who
       * dismissed the flow did so after it drew, and a refusal happens
       * before anything appears. Under a second means it never opened, and
       * the honest response to that is the window that does work.
       */
      const neverOpened = Date.now() - startedAt < 1200
      setPhase("idle")
      if (neverOpened) {
        window.open("https://app.poppin.so/fund", "_blank", "noopener")
      }
      void e
    }
  }

  if (!enabled) return null

  return (
    <Box sx={{ mt: 1 }}>
      {phase !== "open" && (
        <Typography
          onClick={() => void open()}
          sx={{
            fontSize: 11,
            fontWeight: 700,
            color: phase === "unavailable" ? DIM : ACCENT,
            cursor: phase === "opening" ? "default" : "pointer",
            textAlign: "center",
          }}
        >
          {phase === "opening"
            ? "Opening…"
            : phase === "done"
              ? "USDC added. Press Buy again."
              : phase === "unavailable"
                ? "Could not read your wallet"
                : // ANY CRYPTO IN, USDC OUT. The old label named only the
                  // input, on the one screen where the reader most needs to
                  // learn what the wallet actually holds. The destination
                  // mint below has always been USDC.
                  "Add USDC with any crypto →"}
        </Typography>
      )}
      <Box ref={host} sx={{ mt: phase === "open" ? 1 : 0 }} />
    </Box>
  )
}
