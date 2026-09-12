import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Swap was extracted verbatim from the terminal era and stayed dressed as
 * one - the only money room speaking a different product. These pin the
 * translation into the panel's grammar; the money plumbing (quote hook,
 * execute, ledger receipt) is untouched and covered elsewhere.
 */
const raw = readFileSync(join(__dirname, "Swap.tsx"), "utf8")
// Comments are allowed to NAME the old sins; the code is not allowed to
// commit them. Strip comments before asserting absence.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("Swap speaks the panel's language", () => {
  it("the amount field obeys the locale rule, not type=number", () => {
    expect(raw).toMatch(/normalizeDecimal\(e\.target\.value\)/)
    expect(src).not.toMatch(/type="number"/)
  })

  it("the quote is a sentence, not a disabled input", () => {
    expect(src).not.toMatch(/disabled\s*\n\s*variant="outlined"/)
    expect(raw).toMatch(/price impact/)
    expect(raw).toMatch(/at least \$\{minOut/)
  })

  it("the confirm wears the direction the ledger draws", () => {
    expect(raw).toMatch(/USDC in is a buy/)
    expect(raw).toMatch(/JUICE_BUY_FILL/)
    expect(raw).toMatch(/Buy \$\{toToken\.symbol\}/)
    expect(raw).toMatch(/Sell \$\{fromAmount\} \$\{fromToken\.symbol\}/)
  })

  it("slippage is disclosed where the press happens", () => {
    expect(raw).toMatch(/Fills within 3% of the quote/)
  })

  it("the room stands on the panel's own ground", () => {
    expect(raw).toMatch(/JUICE\.groundDeep/)
    expect(src).not.toMatch(/"#0e141d"/)
  })
})
