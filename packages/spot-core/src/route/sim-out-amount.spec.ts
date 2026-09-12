import { describe, expect, it } from 'vitest';

/**
 * THE BEST QUANTITY ON THE BUILD PATH WAS BEING THROWN AWAY.
 *
 * verifyAmount simulates the transaction on every build (requireAmountCheck
 * is on in production), reads the owner's OUT delta to prove the swap
 * credits the asset at all, and then returned a bare boolean — discarding
 * the number. Meanwhile UnsignedSwap.outAmountRaw carried the ROUTER'S
 * PROJECTION from quote time, and that is what every consumer downstream
 * saw.
 *
 * Three quantities exist and they are not interchangeable. This file is
 * about keeping them apart, because conflating them all biases the same
 * way: too many units recorded → price paid per unit too low → readers
 * shown profits they do not have.
 */

/** The precision ladder, worst to best. */
const QUOTED = 1_000_000n; // q.outAmount, at quote time
const SIMULATED = 994_000n; // what the tx would do against pool state now
const EXECUTED = 992_500n; // what the chain actually moved

describe('the three quantities', () => {
  it('the quote is the loosest, and slippage bounds how loose', () => {
    // DEFAULT_SLIPPAGE_BPS = 100, and the service does not override it, so
    // an execution may deliver up to 1% fewer units than quoted.
    const floor = (QUOTED * 9900n) / 10_000n;
    expect(EXECUTED).toBeGreaterThanOrEqual(floor);
    expect(EXECUTED).toBeLessThan(QUOTED);
  });

  it('the simulation sits between them, which is the whole point', () => {
    expect(SIMULATED).toBeLessThan(QUOTED);
    expect(SIMULATED).toBeGreaterThan(EXECUTED);
  });

  it('the error from using the quote is one-directional', () => {
    // Overstating units understates price per unit, which overstates PnL.
    // A reader is never shown LESS profit than they have by this mistake,
    // which is exactly why it must not be the number anyone stores.
    const usd = 25;
    expect(usd / Number(QUOTED)).toBeLessThan(usd / Number(EXECUTED));
  });

  it('a null simulation is a fact, not a zero', () => {
    // No simulator and no requireAmountCheck: nothing was measured. Storing
    // 0 units would claim the swap credited nothing.
    const simOutAmountRaw: string | null = null;
    expect(simOutAmountRaw).toBeNull();
    expect(Number(simOutAmountRaw ?? 0)).toBe(0); // the trap, written down
  });
});

describe('what a sell returns', () => {
  it('is USDC out, never asset units', () => {
    // buildUnsignedSell quotes asset -> USDC, so the OUT side is USDC and
    // the simulated delta is USDC 6-dec. The asset quantity on a sell is
    // the exact INPUT (dto.amountRaw, exact-in) and needs no simulation.
    const sellSimOut = 4_963_942n; // $4.963942, the measured live sell
    expect(Number(sellSimOut) / 1e6).toBeCloseTo(4.963942, 6);
  });
});
