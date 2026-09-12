import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8")

/**
 * The audit's onboarding copy tour, pinned. Each of these is a sentence a
 * regression could quietly bring back.
 */
describe("onboarding speaks the product's language", () => {
  it("the install screen's trust line is positive form, not a denial", () => {
    const q = src("entries/welcome/components/steps/QuickStartStep.tsx")
    expect(q).not.toMatch(/note="We never/)
    expect(q).toMatch(/matched to markets in the moment/)
  })

  it("the payoff screen still promises something concrete", () => {
    /**
     * The hero card's explainer ("Live price chips under tweets, and your
     * own position under every tweet about a coin you hold") was removed on
     * the owner's call — a door does not need a paragraph, and the card is
     * a door. The promise did not go with it: the line under the card is
     * now the concrete one, because it names a place the reader can go and
     * see the thing work within a second.
     */
    const y = src("entries/welcome/components/steps/YoureInStep.tsx")
    expect(y).toMatch(/carry a live chip/)
    expect(y).toMatch(/x\.com\/search\?q=%24SOL/)
    // The explainer stays gone; the card is title + arrow.
    expect(y).not.toMatch(/your own position under every/)
  })

  it("the deposit screen names the exchange route in plain words", () => {
    const r = src("views/receive.tsx")
    expect(r).toMatch(/Coinbase, Binance or any exchange/)
    expect(r).toMatch(/Choose the Solana network/)
  })

  it("the panel's sign-in gates open the one full-page flow", () => {
    const l = src("components/Layout.tsx")
    expect(l).not.toMatch(/<SignInModal/)
    expect(l).toMatch(/<SignInRedirect/)
    const rdir = src("components/SignInRedirect.tsx")
    expect(rdir).toMatch(/flow=signin/)
  })

  it("empty positions point at the chip, where the thesis lives", () => {
    expect(src("views/SpotPositions.tsx")).toMatch(/Scroll X: tweets about coins/)
    expect(src("components/profile/ProfilePortfolio.tsx")).toMatch(
      /chip under any tweet/,
    )
  })

  it("the token room lists the mint's own orders and alerts", () => {
    const t = src("views/TokenView.tsx")
    expect(t).toMatch(/<OpenOrders mint=\{asset\.mint\}/)
    expect(t).toMatch(/<PriceAlerts mint=\{asset\.mint\}/)
  })
})
