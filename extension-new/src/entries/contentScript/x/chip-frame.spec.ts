import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * THE CHIP'S GEOMETRY, AS RELATIONSHIPS RATHER THAN AS NUMBERS.
 *
 * Two things the owner looked at and rejected, both of them shape rather
 * than colour, and both of them provable from the stylesheet alone:
 *
 *   1. The ticker and the price were STACKED (a column named `.stack`).
 *      Side by side was asked for; the column is reversed here.
 *   2. Expanded, the Buy and Sell keys touched the chip's outer frame.
 *      Nothing between the frame and the keys declared any horizontal
 *      padding, so the last key's border box sat exactly on the frame's
 *      padding box, and the frame's radius could not be concentric with
 *      the keys' at any inset because it was the wrong radius.
 *
 * The numbers are DERIVED, so this file asserts the derivations and not the
 * digits. A future pass is allowed to change the row height, the key
 * padding or the frame radius; it is not allowed to change one of them and
 * leave the other two behind, which is exactly how the flush corner
 * happened in the first place. Source text rather than a mounted root on
 * purpose: jsdom has no layout, so the only honest place to check a
 * geometric invariant is the rule that decides it.
 */
/**
 * Comments come OUT before anything is parsed, and that is not tidying.
 * This file's house style is long explanatory comments, and several of
 * them quote CSS at the reader ("button { font: inherit }"). A brace
 * inside a comment ends a rule body early for any naive scanner, which
 * makes the assertion below silently prove nothing rather than fail — the
 * exact failure mode no-dead-rules.spec.ts guards its own parser against.
 */
const CSS = readFileSync(join(__dirname, "xStrip.ts"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
)

/**
 * Every declaration of a rule whose selector line is EXACTLY `sel`, merged.
 *
 * The body scan skips `${...}`, the lesson row-colour.spec.ts and
 * juice.spec.ts both wrote down: the first brace after `.chip {` can belong
 * to an interpolation, and a naive search for the next "}" ends the rule in
 * the wrong place and then passes against half of it.
 */
function props(sel: string): Map<string, string> {
  const out = new Map<string, string>()
  let found = 0
  for (let at = CSS.indexOf("{"); at > -1; at = CSS.indexOf("{", at + 1)) {
    const lineStart = CSS.lastIndexOf("\n", at) + 1
    if (CSS.slice(lineStart, at).trim() !== `${sel} `.trim()) continue
    let i = at + 1
    for (; i < CSS.length; i++) {
      if (CSS[i] === "$" && CSS[i + 1] === "{") {
        i = CSS.indexOf("}", i)
        continue
      }
      if (CSS[i] === "}" || CSS[i] === "{") break
    }
    if (CSS[i] !== "}") continue
    found += 1
    for (const m of CSS.slice(at + 1, i).matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) {
      out.set(m[1], m[2].trim())
    }
  }
  expect(found, `no rule found for "${sel}" — this assertion proves nothing`).toBeGreaterThan(0)
  return out
}

const px = (v: string | undefined) => {
  const m = /(-?[\d.]+)px/.exec(v ?? "")
  expect(m, `expected a px length, got "${v}"`).not.toBeNull()
  return Number(m![1])
}

/** CSS shorthand order, expanded the way the box model reads it. */
function pad(v: string | undefined): { top: number; right: number; bottom: number; left: number } {
  const parts = (v ?? "").trim().split(/\s+/)
  const n = parts.map((p) => (p === "0" ? 0 : px(p)))
  if (n.length === 1) return { top: n[0], right: n[0], bottom: n[0], left: n[0] }
  if (n.length === 2) return { top: n[0], right: n[1], bottom: n[0], left: n[1] }
  if (n.length === 3) return { top: n[0], right: n[1], bottom: n[2], left: n[1] }
  return { top: n[0], right: n[1], bottom: n[2], left: n[3] }
}

describe("the ticker and the price share one line", () => {
  it("is a row, centred, and no longer calls itself a stack", () => {
    const pair = props(".pair")
    expect(pair.get("flex-direction")).toBe("row")
    /**
     * CENTRE, NOT BASELINE, and the reason is a browser fact rather than a
     * preference — which is why it is pinned rather than left to taste.
     * `.sym` carries `overflow: hidden` (see below), which makes it a
     * scroll container, and a scroll container does not hand its text's
     * baseline to a flex parent: the engine synthesizes one from the
     * border box, which would hang the 10px ticker about 2px high off the
     * 15px price. Anyone reaching for `baseline` here has to remove that
     * overflow first, and they must not.
     */
    expect(pair.get("align-items")).toBe("center")
    // A gap tighter than the 7px .face puts between its own children: on
    // one line, proximity is the only grouping the pair has left.
    expect(px(pair.get("gap"))).toBeLessThan(px(props(".face").get("gap")))

    // The rename is part of the fix. A rule named "stack" that lays out a
    // row is the kind of lie the comments in this file are forbidden.
    expect(CSS).not.toMatch(/^\s*\.stack\s*\{/m)
    expect(CSS).not.toContain('class="stack"')
    expect(CSS).toContain('class="pair"')
  })

  it("degrades by ellipsis, and nothing inside the face can reach the keys", () => {
    /**
     * THE ASSERTION THAT USED TO BE HERE WAS THE WRONG ONE, and swapping it
     * quietly would be worse than leaving it. It read
     * `expect(sym.get("flex-shrink")).toBe("0")` under the title "refuses
     * to let the identity pay for the width".
     *
     * That declaration is a MITIGATION, not an invariant, and pinning it
     * pinned the row's ability to overlap itself. Freezing the ticker never
     * made room; it moved the failure — with every child of `.face` frozen
     * and no ancestor clipping (`.pair`, `.face`, `.lead` and `.chip` all
     * overflow: visible), a squeeze has to leave the box, and what leaves
     * is a 15px 800-weight price painting across `.end` and showing through
     * `.sell`'s translucent ground. It was affordable while the same pass
     * that froze the ticker also took MC off the face and left 50-60px of
     * slack. Putting the ticker back beside the price spends 26-60px of
     * that slack, on a row `.end`'s own comment records as having WANTED
     * 511px inside a ~500px column, so the overlap is not hypothetical.
     *
     * What is pinned instead is the FAILURE MODE, which is the thing that
     * actually has to hold at any width: the ticker loses letters to an
     * ellipsis, the price loses nothing, and nothing in the pair can paint
     * outside it. The ticker giving way is not the old bug returning — in
     * the old bug it gave way FIRST, while MC was still on the row; here
     * it is the last pixel available before the row would have to overlap.
     *
     * AND THE PAIR IS ONLY THE FIRST STAGE. The version of this test that
     * shipped with the pair's clip was titled "can never paint over the
     * keys" and asserted nothing of the sort: every assertion below the
     * title described what happens INSIDE `.pair`, and `.face` — which
     * also carries `min-width: 0`, and so also loses its automatic minimum
     * size — declared no overflow at all. Once the pair hits zero the
     * algorithm keeps shrinking `.face` past `.badge + .chg + .mine +
     * .who`, all four of which are frozen (assertion 4), and frozen
     * children in a box too small for them lay out from main-start and
     * overflow RIGHT: over `.more` and into `.end`. Assertion 5 is what
     * makes the second half of the title true, and `.face` is the last
     * ancestor that can make it true without a cost — `.lead` above it is
     * the parent of two buttons, and clipping there would clip their focus
     * outlines too.
     *
     * What this test does NOT claim: that the left capsule as a WHOLE can
     * never reach `.end`. `.more` is `.face`'s SIBLING at a fixed 30px, so
     * if `.lead` were ever squeezed below 30px the chevron itself would
     * overflow it. Assertion 6 says how narrow the row has to get for that,
     * from the declarations rather than from a claim. Say so, rather than
     * let a title imply the whole capsule was measured.
     */
    const pair = props(".pair")
    // 1. The pair is the valve: it may shrink, and it CLIPS what it clips.
    expect(pair.get("flex-shrink")).not.toBe("0")
    expect(pair.get("min-width")).toBe("0")
    // hidden, not auto: a clip that ellipsises is honest about running out
    // of room; a scroll container hides a fact behind an unadvertised
    // gesture, which this product has ruled on elsewhere (ProfileFeed).
    expect(pair.get("overflow")).toBe("hidden")

    // 2. Inside it, the ticker is what gives way — with an ellipsis to show
    //    for it. overflow:hidden is doing double duty: it is what makes the
    //    ellipsis possible AND what lets a flex item shrink below its text.
    const sym = props(".sym")
    expect(sym.get("flex-shrink")).not.toBe("0")
    expect(sym.get("overflow")).toBe("hidden")
    expect(sym.get("text-overflow")).toBe("ellipsis")
    expect(sym.get("white-space")).toBe("nowrap")
    expect(sym.get("max-width")).toBe("9ch")

    // 3. And the price never gives way. A shrunk price is a price with a
    //    digit missing, which is not a smaller truth but a different one.
    expect(props(".px").get("flex-shrink")).toBe("0")

    // 4. The pair is the only valve INSIDE the face, which is a smaller
    //    statement than it sounds and is why assertion 5 exists. Every
    //    other child holds its width. So once the pair is at zero there is
    //    nothing left to give, and the face — which has min-width: 0, and
    //    so no automatic minimum size — goes on shrinking underneath four
    //    children that will not.
    for (const sel of [".badge", ".chg", ".mine", ".who"]) {
      expect(props(sel).get("flex-shrink"), `${sel} must not absorb the squeeze`).toBe("0")
    }

    // 5. WHICH IS WHY THE FACE CLIPS TOO. This is the assertion that makes
    //    the second half of the title true: frozen children in a box too
    //    small for them lay out from main-start and overflow RIGHT, and
    //    without this they land on .more and on .end, showing through
    //    .sell's translucent ground. hidden for the same reason .pair uses
    //    it — a cut is honest, a scroll container is a hidden gesture.
    expect(props(".face").get("overflow")).toBe("hidden")

    // 6. AND THE ONE THING THAT CLIP CANNOT COVER, as arithmetic rather
    //    than as a claim. `.more` is outside `.face`, so it leaves `.lead`
    //    if `.lead` is ever squeezed under its 30px — which needs the whole
    //    row narrower than `.more` plus `.end`'s own frozen floor, since
    //    `.end` never shrinks. That floor, for the row's usual tail
    //    (bell · wallet · Buy · Sell), is the seam, three gaps, the two
    //    30px discs and the two keys' horizontal padding — before a single
    //    letter of "Buy" or "Sell" is counted, which only pushes it up.
    //    Every input is read from the sheet; only the total is written
    //    down, so changing any of them fails here instead of quietly
    //    invalidating the paragraph above.
    const end = props(".end")
    const sides = (sel: string) => {
      const p = pad(props(sel).get("padding"))
      return p.left + p.right
    }
    const floor =
      px(end.get("padding-left")) +
      3 * px(end.get("gap")) +
      px(props(".ring").get("width")) +
      px(props(".wal").get("width")) +
      sides(".buy, .go") +
      sides(".sell")
    expect(px(props(".more").get("width")) + floor).toBe(181)
  })

  it("clips sideways only, so the tick pulse keeps its lift", () => {
    /**
     * A clip installed for WIDTH must not eat a MOVEMENT. `.px` lifts on a
     * live tick (tickPulse), and a box that clipped at the exact top of its
     * line box would shave the digits mid-pulse. The pair buys vertical
     * room with padding and gives it straight back as negative margin, so
     * it occupies exactly what it did before and clips on one axis only.
     */
    const at = CSS.indexOf("@keyframes tickPulse")
    expect(at, "tickPulse must still exist").toBeGreaterThan(-1)
    const lift = /translateY\((-?[\d.]+)px\)/.exec(CSS.slice(at, at + 240))
    expect(lift, "tickPulse must still be a vertical lift").not.toBeNull()

    const pair = props(".pair")
    const room = pad(pair.get("padding"))
    expect(room.top).toBeGreaterThanOrEqual(Math.abs(Number(lift![1])))
    expect(room.bottom).toBe(room.top)
    // Sideways there is none, or the ellipsis would bite late.
    expect(room.left + room.right).toBe(0)
    // And the height is given back, exactly — a clip must cost the row no
    // height, or every chip in the timeline moves for a rule about width.
    const back = pad(pair.get("margin"))
    expect(back.top).toBe(-room.top)
    expect(back.bottom).toBe(-room.bottom)

    /**
     * AND THE SECOND CLIP HAS THE SAME DUTY. `.face` clips now too
     * (assertion 5 above), and a clip cuts at the PADDING box — so the
     * face's own vertical padding is the distance between its cut and the
     * tallest thing on the row. The pulse is already contained by `.pair`,
     * whose border box sits inside the face's CONTENT box, so the face's
     * cut is that padding further out again; requiring at least the lift
     * is the floor, not the measurement. Take the padding to zero and this
     * clip starts shaving what the pair's was written to protect.
     */
    const faceRoom = pad(props(".face").get("padding"))
    expect(faceRoom.top).toBeGreaterThanOrEqual(Math.abs(Number(lift![1])))
    expect(faceRoom.bottom).toBeGreaterThanOrEqual(Math.abs(Number(lift![1])))
  })
})

describe("the opened frame holds its keys off the edge", () => {
  const ROW = px(props(".row").get("height"))
  const BORDER = px(props(".chip").get("border"))
  const INSET = pad(props(".chip.open .row").get("padding")).right

  it("the frame's inner corner is exactly half the header row", () => {
    /**
     * THE DERIVATION, which is the whole assertion. The frame is painted on
     * the BORDER box; the keys live in the PADDING box, one border-width
     * in. A key of height H centred in the row is inset (ROW-H)/2 from the
     * top and carries a corner of H/2 — and (ROW-H)/2 + H/2 = ROW/2 for
     * EVERY H. So ROW/2 is the only padding-box radius at which a tail key
     * can be concentric with the frame, whatever height the key ends up.
     * At the old value it was off by one and no inset could have fixed it.
     */
    const frame = px(props(".chip.open").get("border-radius"))
    expect(frame - BORDER).toBe(ROW / 2)
  })

  it("the keys are a measured height, not whatever X's page inherits", () => {
    /**
     * `button { font: inherit }` takes the LINE-HEIGHT with the font, and
     * nothing in this sheet declares one above the keys — so the same key
     * measured differently depending on which X container the chip landed
     * in, and never matched the 30px round buttons beside it. The inset
     * below is only a real number once this one is.
     */
    for (const sel of [".buy, .go", ".sell"]) {
      const p = props(sel)
      const box = px(p.get("line-height")) + pad(p.get("padding")).top + pad(p.get("padding")).bottom
      expect(box, `${sel} must be the same box as .ring/.wal`).toBe(px(props(".ring").get("height")))
    }
  })

  it("the inset is the same on every edge the frame exposes", () => {
    /**
     * Top and bottom come free from the row's own centring; left and right
     * had to be asked for, and were not. Symmetry is the fix the owner
     * reported the absence of: "corners touching the outer border".
     */
    const key = px(props(".sell").get("line-height")) + pad(props(".sell").get("padding")).top * 2
    expect((ROW - key) / 2).toBe(INSET)
    expect(pad(props(".chip.open .row").get("padding")).left).toBe(INSET)
    // ...and the inner corner is the outer one minus that inset, which is
    // what "concentric" means when both shapes are pills.
    const frame = px(props(".chip.open").get("border-radius")) - BORDER
    expect(frame - INSET).toBe(key / 2)
  })

  it("charges the row nothing for the inset", () => {
    /**
     * .end carries a comment saying in so many words that its numbers were
     * MEASURED against a ~500px tweet column after a field report clipped
     * a ticker to "BU…", and that changing them means re-measuring. So the
     * inset is PAID FOR rather than spent: the padding the row takes comes
     * back out of the 6px .face uses to seat the badge inside a capsule
     * the open state no longer paints, plus the seam .end puts in front of
     * the tail. Net width cost of opening: zero.
     */
    const spent = INSET * 2
    const fromFace =
      pad(props(".face").get("padding")).left - px(props(".chip.open .face").get("padding-left"))
    const fromSeam =
      px(props(".end").get("padding-left")) - px(props(".chip.open .end").get("padding-left"))
    expect(fromFace + fromSeam).toBe(spent)
  })

  it("does not move the left cluster when the chip opens", () => {
    // The badge's distance from the chip's own edge must be identical
    // resting and open, or the ticker snaps sideways the frame it opens —
    // on the one element whose left edge is welded to the tweet's text
    // column by a measured placement pass.
    const resting = pad(props(".face").get("padding")).left
    const open = INSET + px(props(".chip.open .face").get("padding-left"))
    expect(open).toBe(resting)
  })
})
