import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * THE TALLY MUST NOT WATCH ITSELF DRAIN.
 *
 * This room fires markAllNotificationsAsRead on mount. A "how many are
 * new" figure derived live would therefore count down to zero in front of
 * the reader as the mutation settles — the one number they came for,
 * erasing itself. It is latched from the first page that carries rows and
 * never recomputed.
 *
 * That is invisible in the rendered output (both versions look right on
 * the first frame), so it is pinned here at the source. Comments are
 * stripped before asserting: a guard its own documentation can trip
 * teaches people to stop documenting.
 */
const src = readFileSync(
  join(__dirname, "notifications.tsx"),
  "utf8",
)
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")

describe("the arrival tally", () => {
  it("is held in a ref, not derived on every render", () => {
    expect(code).toMatch(/arrivalTally\s*=\s*useRef/)
    expect(code).toMatch(/unreadOnArrival\s*=\s*arrivalTally\.current/)
  })

  it("writes once — the guard is the whole mechanism", () => {
    // Without `=== null` this latches nothing and the bug returns silently.
    expect(code).toMatch(/arrivalTally\.current === null/)
  })

  it("never recounts from the full page set", () => {
    // A flatMap over every page would both recount and grow as the reader
    // scrolls, turning "3 new" into a running total of everything loaded.
    const tallyLines = code
      .split("\n")
      .filter((l) => l.includes("read_at") && l.includes("filter"))
    expect(tallyLines.length).toBe(1)
    expect(tallyLines[0]).not.toContain("flatMap")
  })
})

describe("motion is opt-out", () => {
  it("guards every animation it introduces", () => {
    // Three animations were added here: the row stagger, the press
    // depress, and the empty state's bob.
    const guards = code.match(/prefers-reduced-motion/g) ?? []
    expect(guards.length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * THE CARD IS THE SEPARATOR.
 *
 * A <Divider> once sat between rows, from the era when a row was a flat
 * strip in a shared column. The row is now a card — border, 16px radius,
 * and it owns the 9px gap below it as its own marginBottom — so the border
 * already does the separating. The divider was also mis-placed: MUI's
 * Divider carries margin:0, and with the gap belonging to the row above,
 * the hairline landed 9px below one card and 0px above the next, pressed
 * flat against a rounded corner. It read as a rendering glitch.
 *
 * Pinned here because the divider is the kind of thing a reader re-adds on
 * instinct ("rows in a list have dividers"), and nothing in the toolchain
 * would object. DateDivider — the per-day header — is deliberately NOT
 * covered by these assertions: a day change is worth marking.
 */
describe("no hairline between rows", () => {
  it("renders no MUI Divider in the list", () => {
    // `<DateDivider` does not match `<Divider`, so the day header survives.
    expect(code).not.toMatch(/<Divider/)
  })

  it("does not even import one", () => {
    // The usage and the import went together; leaving the import behind
    // is dead weight nothing in the build flags (no noUnusedLocals, no
    // unused-vars rule), and it is the breadcrumb that invites the re-add.
    const muiImport = code.match(/import\s*\{[\s\S]*?\}\s*from\s*"@mui\/material"/)
    expect(muiImport).not.toBeNull()
    expect(muiImport![0]).not.toMatch(/\bDivider\b/)
  })
})
