import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * COLOUR BELONGS TO FACTS, NOT TO CONTROLS — enforced, because the rule was
 * broken twice within an hour of being made, both times the same way.
 *
 * The keys moved from green/red to brand and neutral. Their :hover and
 * :active rules did not: they sat LATER in the stylesheet, won the
 * cascade, and repainted the key its old colour the moment a pointer
 * touched it. Neither was visible in a screenshot, because a screenshot
 * has no pointer. That is the whole lesson — a colour change is not
 * finished when the resting state looks right.
 *
 * Scoped deliberately to the RESTING ROW's controls. The sheet's confirm
 * (.place) is a commitment, not a door, and stays green for buy and red
 * for sell; juice.spec.ts enforces that separately and this must not
 * contradict it.
 */
const CSS = readFileSync(join(__dirname, "xStrip.ts"), "utf8")

/**
 * Every rule whose selector list mentions one of these classes.
 *
 * The body scan SKIPS `${...}` interpolations. A plain search for the next
 * "}" reads correct code and returns a truncated body — the first brace
 * after `.place {` belongs to `${JUICE.buyGlow}` — so the assertion runs
 * against half a rule and passes for the wrong reason. juice.spec.ts wrote
 * this lesson down and I still had to learn it twice, which is the case
 * for the comment rather than against it.
 */
function rulesFor(classes: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const matches = classes.map((c) => new RegExp(`(?:^|[,\\s])\\${c}(?:[:.\\s,{]|$)`))
  for (let at = CSS.indexOf("{"); at > -1; at = CSS.indexOf("{", at + 1)) {
    const lineStart = CSS.lastIndexOf("\n", at) + 1
    const sel = CSS.slice(lineStart, at).trim()
    if (!sel.startsWith(".")) continue
    if (!matches.some((re) => re.test(sel + " "))) continue
    let i = at + 1
    for (; i < CSS.length; i++) {
      if (CSS[i] === "$" && CSS[i + 1] === "{") {
        i = CSS.indexOf("}", i)
        continue
      }
      if (CSS[i] === "}" || CSS[i] === "{") break
    }
    if (CSS[i] !== "}") continue
    out.push([sel, CSS.slice(at + 1, i)])
  }
  return out
}

/** The two direction hues, in every form this stylesheet writes them. */
const DIRECTION = [
  /48\s*,\s*209\s*,\s*88/,      // green rgb
  /255\s*,\s*69\s*,\s*58/,      // red rgb
  /buyInk|buyFill|buyGround|buyEdge|buyGlow|JUICE_BUY_FILL/,
  /sellInk|sellFill|sellGround|sellEdge|sellGlow|JUICE_SELL_FILL/,
  /#4ADE80|#5BE58F|#22C55E|#148A45|#6FF09B/i,
  /#FF7A70|#F5453A|#FF9A92|#A52019/i,
]

describe("the resting row's keys carry no direction hue", () => {
  const rules = rulesFor([".buy", ".sell", ".go"])

  it("finds the rules at all, so a rename cannot make this pass vacuously", () => {
    expect(rules.length).toBeGreaterThanOrEqual(4)
    expect(rules.some(([sel]) => sel.includes(":hover"))).toBe(true)
    expect(rules.some(([sel]) => sel.includes(":active"))).toBe(true)
  })

  it("is clean in every state, not just at rest", () => {
    for (const [sel, body] of rules) {
      for (const hue of DIRECTION) {
        expect(
          hue.test(body),
          `${sel} still carries a direction colour — the cascade bug again`,
        ).toBe(false)
      }
    }
  })
})

describe("the sheet's confirm keeps its direction", () => {
  it("is untouched by the rule above", () => {
    // .place is a commitment. If this ever goes quiet, the rule was
    // applied too widely and the trade's own moment lost its colour.
    const place = rulesFor([".place"])
    expect(place.some(([, body]) => /JUICE_BUY_FILL|buyGlow/.test(body))).toBe(true)
  })
})

describe("rule 4 reaches the celebration", () => {
  it("colours the sparks by the direction that landed", () => {
    // The burst was green whatever happened, so a SELL confirmed in the
    // colour that means buy — on a surface whose own comments call green
    // "structurally forbidden" from dressing anything but a landed buy.
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(code).toMatch(/\.burst-sell i:nth-child\(odd\)/)
    expect(code).toMatch(/side === "sell" \? "burst burst-sell"/)
  })

  it("gives a placed order neither direction", () => {
    // Placing an order is not a trade landing. It gets the brand.
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(code).toMatch(/"burst burst-neutral"/)
    expect(code).toMatch(/\.burst-neutral i:nth-child\(odd\)/)
  })
})
