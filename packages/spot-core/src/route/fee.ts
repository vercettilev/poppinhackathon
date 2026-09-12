import { readEnvInt } from '../config/env';

/**
 * §8: "Fees ship OFF. Every threshold in §11 is measurable without a cut. Fee
 * logic may exist behind a flag, unreachable in shipped builds."
 *
 * The BigInt split from v1 is kept verbatim in shape — float math here loses
 * lamports on every trade — but the DEFAULT IS INVERTED. v1 defaulted to
 * `DEFAULT_FEE_BPS = 100` (1%) and only skipped the fee when misconfigured, so
 * a straight copy would have shipped a live 1% cut against §8. Here the
 * default is 0 and a non-zero fee requires both an explicit bps value and a
 * destination wallet.
 */

export const USDC_DECIMALS = 6;

export interface FeeSplit {
  feeRaw: bigint;
  netRaw: bigint;
}

export interface FeeConfig {
  /** Basis points Jupiter takes out of the swap. 0 disables it entirely. */
  bps: number;
  /**
   * The TOKEN ACCOUNT that receives the fee — an associated token account,
   * never a wallet address, and it must already exist on chain.
   *
   * This is the field that used to say `wallet`, and the rename is the
   * whole point: Jupiter rejects a build whose feeAccount is a wallet, so
   * a name that invites pasting one is a trap with a plausible-looking
   * config on the other side of it. We collect in USDC, so one account
   * serves buys (USDC in) and sells (USDC out) alike.
   *
   * Absent means no fee, regardless of bps.
   */
  tokenAccount?: string | undefined;
}

/** §8 posture: off, and off is not reachable-by-accident. */
export const FEES_OFF: FeeConfig = { bps: 0 };

/**
 * Read fee config from env. Returns {bps: 0} unless BOTH a valid bps and a
 * wallet are present — the same "skip the fee, never block the trade" posture
 * as v1, but starting from off.
 */
export function feeConfigFromEnv(
  env: Record<string, string | undefined> = {},
): FeeConfig {
  const bps = readEnvInt(env['POPPIN_FEE_BPS'], 0, { min: 0, max: 10_000 });
  const tokenAccount = env['POPPIN_FEE_TOKEN_ACCOUNT']?.trim() || undefined;
  if (bps <= 0 || !tokenAccount) return FEES_OFF;
  return { bps, tokenAccount };
}

/**
 * Split a gross USDC input into {fee, net}, both raw 6-dec.
 *
 * BigInt division truncates, so the fee rounds DOWN and the user keeps the
 * remainder — the correct direction for a rounding error on someone else's
 * money.
 *
 * NOT used to shrink a swap's input any more, and that correction matters:
 * Jupiter takes the platform fee itself when the quote asks for it, so a
 * caller that ALSO cut the input first would charge twice. This is now the
 * estimator — what a fee will be, before a quote exists to report it.
 */
export function splitFee(grossRaw: bigint, fee: FeeConfig = FEES_OFF): FeeSplit {
  if (grossRaw < 0n) throw new RangeError('grossRaw must be >= 0');
  if (fee.bps <= 0 || !fee.tokenAccount) return { feeRaw: 0n, netRaw: grossRaw };
  const feeRaw = (grossRaw * BigInt(fee.bps)) / 10_000n;
  return { feeRaw, netRaw: grossRaw - feeRaw };
}

/** USD-scaled view of a raw 6-dec USDC amount. */
export const rawToUsd = (raw: bigint): number =>
  Number(raw) / 10 ** USDC_DECIMALS;

/** Raw 6-dec USDC from a USD float. Rounds to the nearest base unit. */
export const usdToRaw = (usd: number): bigint =>
  BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
