import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A splice once landed the funding-hub door INSIDE the Copy button's JSX -
 * buttons nested in a button, the exchange sentence rendered mid-control,
 * and pressing the hub area also fired the copy. Shipped live before it
 * was seen. This pins the order structurally: the address card closes
 * before the hub door opens.
 */
describe("receive's rooms stay separate", () => {
  it("the hub door lives OUTSIDE the address card", () => {
    const src = readFileSync(join(__dirname, "receive.tsx"), "utf8")
    const copy = src.indexOf('"Copy address"')
    const cardClose = src.indexOf("      )}", copy)
    const hub = src.indexOf("THE HUB DOOR")
    expect(copy).toBeGreaterThan(0)
    expect(cardClose).toBeGreaterThan(copy)
    // The hub comment must come AFTER the card's ternary closes.
    expect(hub).toBeGreaterThan(cardClose)
    // And no button opens inside another button anywhere in the file.
    const buttons = [...src.matchAll(/component="button"/g)].map((m) => m.index)
    for (let i = 1; i < buttons.length; i++) {
      const between = src.slice(buttons[i - 1], buttons[i])
      expect(between).toMatch(/<\/Box>|<\/Typography>/)
    }
  })
})
