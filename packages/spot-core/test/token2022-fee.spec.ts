import { describe, expect, it } from 'vitest';
import { RouteEngine } from '../src/route/engine';
import {
  DecimalsCache,
  MintProgramCache,
  TOKEN_2022_PROGRAM_ID,
  type MintInfoReader,
} from '../src/balance/decimals';
import { AllowlistPolicy } from '../src/route/policy';
import { FakeJupiter, SpySigner, fakeClock } from './fakes';

/**
 * A FEE ACCOUNT THAT CANNOT BE PAID MUST NOT BE ASKED FOR.
 *
 * Reported from production: buying NVIDIA's xStock failed with
 * `{"InstructionError":[2,{"Custom":6014}]}` — Jupiter's
 * IncorrectTokenProgramID. The log line that had been left behind for
 * exactly this named the mint, and three simulations of the same swap with
 * one variable isolated it (2026-09-14, mainnet, nothing signed):
 *
 *     USDC -> NVDAx  no fee account     simulation succeeded
 *     USDC -> NVDAx  our fee account    InstructionError [2, Custom 6014]
 *     USDC -> WIF    our fee account    simulation succeeded
 *
 * Our fee account is a classic SPL account holding USDC. Jupiter cannot
 * reconcile that with a Token-2022 output mint, and NVDAx, TSLAx and AAPLx
 * were all confirmed Token-2022 on chain — so with fees on, EVERY tokenized
 * stock purchase was failing while every classic SPL purchase went through.
 * That asymmetry is why it sat open: the catalog was memecoins when the
 * error was first seen, and this is the hackathon's whole category.
 *
 * The rule this file pins is not "skip the fee on Token-2022". It is that
 * the quote and the build never disagree about whether a fee is being
 * taken, because a reader shown a net-of-fee price and charged without one
 * (or the reverse) has been told a number that is not true.
 */

const STOCK = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'; // NVDAx, Token-2022
const COIN = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'; // WIF, classic SPL
const FEE_ATA = '7SrjZNT6UCmBUEyFcUrGSafaDLWJc3xaPKdv8ghmt13A';
const CLASSIC = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

class ProgramReader implements MintInfoReader {
  programCalls = 0;
  constructor(private readonly programs: Record<string, string>) {}
  async decimalsOf(): Promise<number> {
    return 9;
  }
  async tokenProgramOf(mint: string): Promise<string | undefined> {
    this.programCalls += 1;
    return this.programs[mint];
  }
}

function makeEngine(reader: MintInfoReader) {
  const jupiter = new FakeJupiter();
  const engine = new RouteEngine({
    jupiter,
    decimals: new DecimalsCache(reader),
    mintPrograms: new MintProgramCache(reader),
    policy: new AllowlistPolicy([STOCK, COIN]),
    fee: { bps: 100, tokenAccount: FEE_ATA },
    now: fakeClock().now,
  });
  return { engine, jupiter };
}

const reader = () =>
  new ProgramReader({ [STOCK]: TOKEN_2022_PROGRAM_ID, [COIN]: CLASSIC });

describe('a buy Jupiter cannot take a fee on', () => {
  it('asks for no fee, on the quote and on the build alike', async () => {
    const { engine, jupiter } = makeEngine(reader());
    await engine.buildUnsignedSwap(STOCK, 100, new SpySigner());

    expect(jupiter.quoteCalls.at(-1)?.platformFeeBps).toBeUndefined();
    expect(jupiter.buildCalls.at(-1)?.feeAccount).toBeUndefined();
  });

  it('reports a fee of zero, so the ledger cannot record a cut never taken', async () => {
    const { engine } = makeEngine(reader());
    const r = await engine.buildUnsignedSwap(STOCK, 100, new SpySigner());
    expect(r.feeRaw).toBe('0');
  });

  it('quotes it the same way it will be built', async () => {
    // The half that actually bites: a probe priced net of a fee the build
    // then does not take shows a reader a number they will not get.
    const { engine, jupiter } = makeEngine(reader());
    await engine.quote(STOCK, 100);
    expect(jupiter.quoteCalls.at(-1)?.platformFeeBps).toBeUndefined();
  });
});

describe('a buy it can', () => {
  it('still pays, so this did not quietly turn fees off everywhere', async () => {
    const { engine, jupiter } = makeEngine(reader());
    const r = await engine.buildUnsignedSwap(COIN, 100, new SpySigner());

    expect(jupiter.quoteCalls.at(-1)?.platformFeeBps).toBe(100);
    expect(jupiter.buildCalls.at(-1)?.feeAccount).toBe(FEE_ATA);
    expect(r.feeRaw).toBe('1000000'); // 1% of $100, 6-dec USDC
  });

  it('keeps paying when nothing can say what the program is', async () => {
    // Unknown is not Token-2022. An engine with no program reader at all
    // behaves exactly as it did before this existed, which is what keeps
    // every other caller and every test double honest.
    const blind = new (class implements MintInfoReader {
      async decimalsOf() {
        return 9;
      }
    })();
    const { engine, jupiter } = makeEngine(blind);
    await engine.buildUnsignedSwap(STOCK, 100, new SpySigner());
    expect(jupiter.buildCalls.at(-1)?.feeAccount).toBe(FEE_ATA);
  });
});

describe('the program lookup is cached', () => {
  it('reads a mint once however many times it is quoted', async () => {
    const r = reader();
    const { engine } = makeEngine(r);
    await engine.quote(STOCK, 100);
    await engine.quote(STOCK, 250);
    await engine.quote(STOCK, 500);
    expect(r.programCalls).toBe(1);
  });
});
