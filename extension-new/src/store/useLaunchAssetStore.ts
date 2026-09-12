import { create } from "zustand"

/**
 * The asset a surface handed the panel when it opened it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The panel's asset strip derives its own answer by asking the active tab
 * what the page is about. That works where a page IS an asset — CoinGecko,
 * Yahoo, TradingView — and fails where the interesting unit is smaller than
 * the page. On X it is the TWEET: measured against production, x.com/home
 * matches nothing at all, while the same request for a tweet's permalink
 * matches correctly.
 *
 * The X chip has already done that work on device before the reader ever
 * taps. Passing the mint through is not a shortcut around the matcher, it is
 * refusing to ask a question whose answer we are holding.
 *
 * ONE-SHOT BY DESIGN. It is consumed on first use and cleared, so a panel
 * left open on some other page does not keep showing the asset it was
 * launched with — the page's own answer takes over the moment there is one.
 *
 * ── THE SIDE RIDES ALONG ────────────────────────────────────────────────────
 * A copy-trade tap is not "show me this asset", it is "I want to buy what
 * they bought". Carrying the intended side lets the strip open the sheet on
 * arrival instead of making somebody who already decided press Buy again.
 * Absent side means the old behaviour: focus the asset, open nothing.
 *
 * ── WHY IT IS SUBSCRIBED, NOT JUST READ AT MOUNT ────────────────────────────
 * Deep links (?mint=) arrive before the strip exists, so reading once at
 * mount was enough. A copy-trade tap happens with the strip ALREADY on
 * screen — the same panel, a row below. `launchSeq` bumps on every hand-off
 * so the strip reacts to the second one as reliably as the first.
 */
export interface LaunchAsset {
  mint: string
  side?: "buy" | "sell"
}

interface LaunchAssetStore {
  launchMint: string | null
  launchSide: "buy" | "sell" | null
  /** Bumped on every hand-off; the strip watches this, not the mint. */
  launchSeq: number
  setLaunchMint: (mint: string | null, side?: "buy" | "sell") => void
  /** Read it once; the next reader gets null. */
  takeLaunchMint: () => LaunchAsset | null
}

export const useLaunchAssetStore = create<LaunchAssetStore>()((set, get) => ({
  launchMint: null,
  launchSide: null,
  launchSeq: 0,
  setLaunchMint: (launchMint, side) =>
    set((s) => ({
      launchMint,
      launchSide: side ?? null,
      launchSeq: s.launchSeq + 1,
    })),
  takeLaunchMint: () => {
    const { launchMint, launchSide } = get()
    if (!launchMint) return null
    set({ launchMint: null, launchSide: null })
    return { mint: launchMint, side: launchSide ?? undefined }
  },
}))
