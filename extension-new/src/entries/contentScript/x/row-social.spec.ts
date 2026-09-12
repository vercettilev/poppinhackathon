import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const code = readFileSync(join(__dirname, "xStrip.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
const host = readFileSync(join(__dirname, "../primary/main.tsx"), "utf8")

/**
 * WHAT THE ROW SAYS ABOUT PEOPLE.
 *
 * Two additions, both read off Fomo's own home screen: faces for who you
 * follow that is in an asset, and a line for what the tweet's author has
 * driven. Both are cheap to get wrong in ways no screenshot would show.
 */
describe("the crowd on a row", () => {
  it("costs one request per window, not one per chip", () => {
    // A timeline mounts dozens of chips in one tick. What is cached is the
    // PROMISE, not the settled value — caching the value would let all
    // twelve fire their own request before the first returned.
    expect(host).toMatch(/value:\s*followingTradesAsset\(\)/)
    expect(host).toMatch(/callersOnce = \{ at: Date\.now\(\), value \}/)
  })

  it("caches a failure SHORT rather than for the whole window", () => {
    // Two rules pulling opposite ways, and both are real. A signed-out
    // reader takes this path on every page, so retrying per chip turns one
    // 401 into a dozen. But a network blip must not silence the faces for
    // the full window either — failure is not absence, it is a shorter
    // answer. One minute against ten.
    expect(host).toMatch(/CROWD_FAIL_TTL_MS/)
    expect(host).toMatch(/crowdOnce\.ttl = CROWD_FAIL_TTL_MS/)
  })

  it("expires, because X is a single-page app", () => {
    // This module outlives every navigation inside x.com, so a memo with
    // no expiry answered from the first read for as long as the tab stayed
    // open — on a feature whose whole claim is "who is in this NOW".
    expect(host).toMatch(/CROWD_TTL_MS = 10 \* 60_000/)
    expect(host).toMatch(/Date\.now\(\) - crowdOnce\.at < crowdOnce\.ttl/)
    expect(host).toMatch(/Date\.now\(\) - callersOnce\.at < CROWD_TTL_MS/)
  })

  it("counts people, not trades", () => {
    // Somebody who bought the same mint three times this week is ONE face.
    // Without the dedupe a single active follow fills the whole stack.
    expect(code).toMatch(/seen\.has\(t\.name\)/)
  })

  it("shows at most three faces and then a count", () => {
    expect(code).toMatch(/mine\.slice\(0, 3\)/)
    expect(code).toMatch(/mine\.length - 3/)
  })

  it("keeps a person whose avatar will not load", () => {
    // An empty disc keeps the count honest; dropping them would understate
    // the crowd because of an image failure.
    expect(code).toMatch(/person\.avatarUrl\s*\?/)
    expect(code).toMatch(/createElement\("i"\)/)
  })
})

describe("the author line", () => {
  it("reports what the author DROVE, never what they hold", () => {
    // Publishing a named person's P&L needs a consent that does not exist
    // anywhere in this product. This is the aggregate the callers board
    // already computes and already publishes.
    expect(code).toMatch(/buyers/)
    expect(code).not.toMatch(/authorPnl|authorPosition|authorHolds/)
  })

  it("keeps the N>=3 floor even though the server applies it", () => {
    // Belt and braces on purpose: an aggregate of one names a person's
    // trade, and this is the surface where that would be published widest.
    expect(code).toMatch(/c\.buyers < 3/)
  })

  it("takes the handle from the permalink, the same capture the server groups by", () => {
    // If the two ends disagreed about what "the author" is, the line would
    // silently attach one account's record to another account's tweet.
    expect(code).toMatch(/x\|twitter\)\\\.com\\\/\(\[\^\/\?#\]\+\)\\\/status/i)
    expect(code).toMatch(/authorHandle\.toLowerCase\(\)/)
  })
})
