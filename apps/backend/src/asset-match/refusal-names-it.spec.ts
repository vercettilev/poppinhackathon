import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A REFUSAL THAT KNOWS THE NAME MUST SAY IT.
 *
 * Field report, with a screenshot: a row in the feed named $LAPTOP and
 * showed its price; tapping through landed on a room that said "Unknown
 * token". We DID know it — the row had just said so a second earlier. The
 * gate had declined, and the old shape threw the identity away along with
 * the offer, so a refusal we could explain came out as ignorance we could
 * not.
 *
 * `asset` stays null: the gate said no, and no surface should be able to
 * build an offer out of this answer. Only the naming changes.
 */
const SRC = readFileSync(
  join(__dirname, 'asset-match.controller.ts'),
  'utf8',
);

/**
 * The refusal branch of byMint, located from the route rather than from an
 * indentation guess — describeOpenMint calls admit too, and anchoring on
 * the call alone reads the wrong method.
 */
function refusalBranch(): string {
  const route = SRC.indexOf("@Post('by-mint')");
  expect(route).toBeGreaterThan(-1);
  const admit = SRC.indexOf('await this.spot.admit(mint);', route);
  expect(admit).toBeGreaterThan(route);
  // End at byMint's HAPPY-path stats call, which sits at method
  // indentation. Searching for the bare call finds the one INSIDE the
  // catch block and cuts the branch in half — the assertions then pass or
  // fail on text that was never read.
  const next = SRC.indexOf('\n    const stats = await this.spot.tokenStats(mint);', admit);
  return SRC.slice(admit, next > -1 ? next : admit + 1800);
}

describe('by-mint, when the gate refuses', () => {
  it('still returns a null asset, so nothing can offer a trade', () => {
    const block = refusalBranch();
    expect(block).toContain('asset: null');
    // The refused branch must never hand back a describeMint result.
    expect(block).not.toContain('describeMint');
  });

  it('names the token when it can', () => {
    expect(refusalBranch()).toMatch(/refused:\s*\{\s*symbol/);
  });

  it('leaves the name null rather than guessing at one', () => {
    // An unreadable token is the only honest "unknown". Falling back to a
    // ticker parsed from somewhere else would be inventing an identity for
    // an address the chain would not describe.
    const block = refusalBranch();
    expect(block).toMatch(/if \(stats\.symbol\)/);
    expect(block).toMatch(/\}\s*catch\s*\{[\s\S]*?\}\s*return \{ asset: null \};/);
  });
});
