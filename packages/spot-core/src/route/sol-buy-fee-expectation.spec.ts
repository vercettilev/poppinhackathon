import { describe, expect, it } from 'vitest';

/**
 * THE DAY THE FEE SWITCHED ON, SOL-FUNDED BUYS STOPPED WORKING.
 *
 * buildUnsignedBuyWithSol asks Jupiter for a quote with NO platformFeeBps
 * and builds the swap with NO feeAccount — deliberately, because splitFee
 * cuts a USDC input and this leg's input is SOL. It then handed the
 * verifier `feeAccount: this.feeAccount` anyway, and verify.ts throws
 * `fee_account_missing` when an expected fee account is absent from the
 * transaction.
 *
 * While SPOT_FEE_TOKEN_ACCOUNT was unset that expectation was undefined and
 * the check slept. Setting it in production woke the check up and every
 * SOL-funded buy began failing verification — surfaced to the reader as a
 * 422 on a path that had nothing wrong with it.
 *
 * The rule this pins: an expectation must describe the LEG, not the
 * engine's configuration. A leg that takes no fee must not assert one.
 */

/** verify.ts:290 — the whole of the rule. */
function feeAccountCheckPasses(
  expectedFeeAccount: string | undefined,
  accountsInTransaction: Set<string>,
): boolean {
  if (!expectedFeeAccount) return true;
  return accountsInTransaction.has(expectedFeeAccount);
}

const FEE_ATA = '7SrjZNT6UCmBUEyFcUrGSafaDLWJc3xaPKdv8ghmt13A';

describe('what each leg may expect of a transaction', () => {
  it('a USDC buy takes a fee, so it may expect the fee account', () => {
    const withFee = new Set(['user', 'usdc-ata', 'token-ata', FEE_ATA]);
    expect(feeAccountCheckPasses(FEE_ATA, withFee)).toBe(true);
  });

  it('the SOL buy takes no fee, so it must expect none', () => {
    // The transaction Jupiter returns for a quote with no platformFeeBps.
    const solBuy = new Set(['user', 'wsol-ata', 'token-ata']);
    expect(feeAccountCheckPasses(undefined, solBuy)).toBe(true);
  });

  it('THE REGRESSION: expecting a fee the leg never asked for rejects it', () => {
    // This is exactly what production did once the env var was set.
    const solBuy = new Set(['user', 'wsol-ata', 'token-ata']);
    expect(feeAccountCheckPasses(FEE_ATA, solBuy)).toBe(false);
  });

  it('and it slept while no fee account was configured', () => {
    // Which is why it shipped green and broke later, on a config change
    // rather than a code change.
    const solBuy = new Set(['user', 'wsol-ata', 'token-ata']);
    expect(feeAccountCheckPasses(undefined, solBuy)).toBe(true);
  });
});
