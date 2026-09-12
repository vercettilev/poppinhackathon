import { RouteError } from '../errors';
import type { Signer, SerializedTransaction } from '../signer/index';
import { DecimalsCache } from '../balance/decimals';
import type { MintPolicy } from './policy';
import {
  type JupiterClient,
  type JupQuote,
  USDC_MINT,
  SOL_MINT,
} from './jupiter';
import { FEES_OFF, type FeeConfig, splitFee, usdToRaw, rawToUsd } from './fee';
import {
  verifySwapTransaction,
  type TransactionSimulator,
} from './verify';

/** A quote older than this is refused at build time rather than executed stale. */
export const QUOTE_MAX_AGE_MS = 20_000;

const DEFAULT_SLIPPAGE_BPS = 100;

export interface AssetQuoteResult {
  mint: string;
  amountUsd: number;
  /** UI-scaled asset units out */
  outAmount: number;
  pricePerUnit: number;
  /** percent, e.g. 0.0435 → 0.0435% */
  priceImpactPct: number;
  route: string[];
  /** raw base units, kept for the build leg */
  outAmountRaw: string;
}

export interface UnsignedSwap {
  /** base64 transaction, UNSIGNED. §8: the client signs and broadcasts. */
  transaction: SerializedTransaction;
  mint: string;
  amountUsd: number;
  /** Raw USDC actually routed, after any fee reservation. */
  netInRaw: string;
  /** Raw fee reserved. 0n whenever fees are off, which is the shipped state. */
  feeRaw: string;
  /**
   * What the pre-broadcast SIMULATION says this transaction credits, in raw
   * base units of the asset — null when no amount check ran.
   *
   * Strictly better than `outAmountRaw` and strictly worse than the truth.
   * outAmountRaw is the router's projection at quote time; this is what the
   * transaction would do against pool state at build time. Neither is the
   * executed amount, which only a post-confirmation balance diff can give.
   * On a SELL this is USDC out, not asset units — the asset quantity on a
   * sell is the exact INPUT, which the caller already holds.
   */
  simOutAmountRaw: string | null;
  outAmountRaw: string;
}

export interface RouteEngineDeps {
  jupiter: JupiterClient;
  decimals: DecimalsCache;
  policy: MintPolicy;
  fee?: FeeConfig;
  slippageBps?: number;
  /** Injectable clock so the staleness gate is testable without real time. */
  now?: () => number;
  /**
   * Verifies the swap AMOUNT by simulating balance deltas. Without one the
   * structural checks still run; only the amount goes unconfirmed.
   */
  simulator?: TransactionSimulator;
  /** Refuse to return a transaction whose amount could not be confirmed. */
  requireAmountCheck?: boolean;
  /**
   * Token account credited with the platform fee.
   *
   * Optional and normally unnecessary: it defaults to `fee.tokenAccount`,
   * which is where it belongs. Two independent inputs for one fact is how
   * a build ends up asking Jupiter for a cut with nowhere to put it, or
   * naming an account for a cut nobody asked for. Kept as an override for
   * a caller that genuinely has to differ.
   */
  feeAccount?: string;
  /**
   * Network budget for a single READ. A retry that cannot finish inside it is
   * skipped rather than allowed to overrun — §9: render nothing rather than
   * arrive late.
   */
  budgetMs?: number;
  /**
   * The same, for the two calls that move money.
   *
   * SEPARATE FROM `budgetMs` BECAUSE A READ AND A WRITE WANT OPPOSITE THINGS.
   * A price tick that arrives late is worthless, so quoting is right to give
   * up quickly. A buy that arrives four seconds late is a completed buy, and
   * the person who pressed the button is watching a spinner and would much
   * rather wait than be told to press again.
   *
   * The backend passed ONE number for both. It was named QUOTE_BUDGET_MS and
   * its own comment said it was chosen for panel-open quoting, and the buy
   * path inherited it — so a trade got three seconds to cover a quote, a
   * build, and any retry between them. Reported from the field as a first
   * press that fails and a second that works, which is the shape of a burst
   * limit hit with no room left to wait it out.
   *
   * Bounded above by QUOTE_MAX_AGE_MS in the constructor: retries outlasting
   * the quote they are for would only trade one refusal for another.
   */
  tradeBudgetMs?: number;
}

/**
 * The v1 swap engine with Nest DI stripped and the custody model inverted.
 *
 * Preserved deliberately (§4): the BigInt fee split, the net-vs-gross quote
 * asymmetry, decimals caching, the quote staleness gate, and the
 * build-but-do-not-send boundary.
 *
 * Removed deliberately (§8/§13): wallet lookup, key decryption, signing,
 * broadcast, confirmation polling, post-fill fee transfer, publisher accrual.
 * The engine's output is a transaction the caller has not yet committed to.
 */
export class RouteEngine {
  private readonly jupiter: JupiterClient;
  private readonly decimals: DecimalsCache;
  private readonly policy: MintPolicy;
  private readonly fee: FeeConfig;
  private readonly slippageBps: number;
  private readonly now: () => number;
  private readonly simulator: TransactionSimulator | undefined;
  private readonly requireAmountCheck: boolean;
  private readonly feeAccount: string | undefined;
  private readonly budgetMs: number;
  private readonly tradeBudgetMs: number;

  constructor(deps: RouteEngineDeps) {
    this.jupiter = deps.jupiter;
    this.decimals = deps.decimals;
    this.policy = deps.policy;
    this.fee = deps.fee ?? FEES_OFF;
    this.slippageBps = deps.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    this.now = deps.now ?? (() => Date.now());
    this.simulator = deps.simulator;
    this.requireAmountCheck = deps.requireAmountCheck ?? false;
    // ONE SOURCE. The bps and the account it lands in are the same
    // decision, so a config that sets one and forgets the other is a
    // misconfiguration, not a mode.
    this.feeAccount = deps.feeAccount ?? this.fee.tokenAccount;
    this.budgetMs = deps.budgetMs ?? 3_000;
    // Clamped rather than trusted: a budget past the staleness ceiling buys
    // retries whose results are then refused as stale, which is a slower way
    // to fail than not retrying at all.
    this.tradeBudgetMs = Math.min(deps.tradeBudgetMs ?? 10_000, QUOTE_MAX_AGE_MS);
  }

  /** Absolute deadline for the network calls of one engine call. */
  private deadline(): { deadlineAt: number } {
    return { deadlineAt: this.now() + this.budgetMs };
  }

  /**
   * PUBLIC read — no auth, no wallet, no money movement. Safe to call on card
   * mount and on every keystroke, which is why §9 can afford to quote on panel
   * open rather than inline in the match response.
   */
  async quote(outputMint: string, amountUsd: number): Promise<AssetQuoteResult> {
    await this.policy.assert(outputMint);
    if (!(amountUsd > 0)) {
      throw new RouteError('bad_input', 'amountUsd must be > 0');
    }

    // Quote the GROSS and let Jupiter deduct. Its quote returns an
    // outAmount already net of the platform fee, so the number a reader
    // sees here is the number they receive. Cutting the input ourselves
    // first — which this used to do — would charge the fee twice once
    // platformFeeBps is also set.
    const netRaw = usdToRaw(amountUsd);
    if (netRaw <= 0n) {
      throw new RouteError('bad_input', 'amountUsd too small to route');
    }

    const [q, dec] = await Promise.all([
      this.jupiter.quote(
        {
          inputMint: USDC_MINT,
          outputMint,
          amount: String(netRaw),
          slippageBps: this.slippageBps,
          // The probe has to price what the BUY will do, fee included, or
          // the number a reader sees before tapping is not the number they
          // get after.
          platformFeeBps: this.fee.bps > 0 ? this.fee.bps : undefined,
        },
        this.deadline(),
      ),
      this.decimals.decimalsOf(outputMint),
    ]);

    return this.shapeQuote(outputMint, amountUsd, q, dec);
  }

  private shapeQuote(
    mint: string,
    amountUsd: number,
    q: JupQuote,
    dec: number,
  ): AssetQuoteResult {
    const outRaw = q.outAmount as string;
    const outAmount = Number(outRaw) / 10 ** dec;
    const impact = Number(q.priceImpactPct ?? 0) * 100;

    return {
      mint,
      amountUsd,
      outAmount,
      pricePerUnit: outAmount > 0 ? amountUsd / outAmount : 0,
      // NOTE: for some RWA pools Jupiter computes priceImpactPct against a
      // reference price rather than realised execution cost, so a large value
      // does NOT necessarily mean a large spread. Round-trip both legs to
      // measure. (Carried over from v1 — still true, still bites.)
      priceImpactPct: Number.isFinite(impact) ? impact : 0,
      route: (q.routePlan ?? [])
        .map((r) => r.swapInfo?.label)
        .filter((l): l is string => !!l),
      outAmountRaw: outRaw,
    };
  }

  /**
   * Build an UNSIGNED buy of `outputMint` with USDC.
   *
   * v1 signed here with a decrypted custodial keypair. v2 stops one step
   * earlier and hands the transaction back: `signer.publicKey()` is needed at
   * build time because Jupiter bakes the owner into the transaction, but no
   * signing capability is exercised.
   */
  async buildUnsignedSwap(
    outputMint: string,
    amountUsd: number,
    signer: Pick<Signer, 'publicKey'>,
  ): Promise<UnsignedSwap> {
    await this.policy.assert(outputMint);
    if (!(amountUsd > 0)) {
      throw new RouteError('bad_input', 'amountUsd must be > 0');
    }

    /**
     * THE FEE IS JUPITER'S TO TAKE, not ours to pre-cut.
     *
     * This used to reduce the input by the fee and then swap the
     * remainder, which collected nothing: the reduced amount simply stayed
     * in the reader's account, and `verifySwapTransaction` refused the
     * build anyway because the fee account it was told to expect appeared
     * nowhere in the transaction. Fees were off, so nobody met it.
     *
     * Jupiter's own platform fee is the mechanism the verification was
     * written for: `platformFeeBps` on the quote, `feeAccount` on the
     * build, and the quote's outAmount already net of it. Since Jan 2025
     * that needs no Referral Program, only an existing token account.
     */
    const grossRaw = usdToRaw(amountUsd);
    if (grossRaw <= 0n) {
      throw new RouteError('bad_input', 'amountUsd too small to route');
    }

    const userPublicKey = await signer.publicKey();

    const quotedAt = this.now();
    const deadline = { deadlineAt: quotedAt + this.tradeBudgetMs };
    const q = await this.jupiter.quote(
      {
        inputMint: USDC_MINT,
        outputMint,
        amount: String(grossRaw),
        slippageBps: this.slippageBps,
        platformFeeBps: this.fee.bps > 0 ? this.fee.bps : undefined,
      },
      deadline,
    );

    // Build against the SAME quote object Jupiter just returned.
    const transaction = await this.jupiter.buildSwap(
      { quoteResponse: q, userPublicKey, feeAccount: this.feeAccount },
      deadline,
    );

    // Staleness is measured across quote + build, and checked before the
    // transaction is ever returned to a caller who might sign it.
    if (this.now() - quotedAt > QUOTE_MAX_AGE_MS) {
      throw new RouteError('quote_stale', 'Quote went stale — retry');
    }

    // Nothing leaves this method unexamined. v1 could skip this because the
    // backend held the key and deserialized the transaction itself; v2 hands a
    // blob to a wallet, so a tampered or substituted /swap response would
    // otherwise reach the signer with only our word behind it.
    const verified = await verifySwapTransaction(
      transaction,
      {
        userPublicKey,
        inputMint: USDC_MINT,
        outputMint,
        amountInRaw: String(grossRaw),
        feeAccount: this.feeAccount,
        // The floor, from the quote this transaction was built for. Without
        // it "did anything arrive" was the whole output test, and one base
        // unit is something.
        outAmountRaw: q.outAmount as string,
        slippageBps: this.slippageBps,
      },
      {
        simulator: this.simulator,
        requireAmountCheck: this.requireAmountCheck,
      },
    );

    /**
     * THE FEE, IN THE UNIT THE CALLER THINKS IN — measured, not assumed.
     *
     * The quote's `platformFee.amount` looked like the honest source and
     * is not: it is denominated in the OUTPUT mint, because a quote is
     * made before Jupiter knows which side's account will receive the fee.
     * Measured live on a $25 USDC→WIF buy at 100 bps: platformFee.amount
     * came back 1237158, which is 1.237 WIF. Read as USDC that is $1.24 —
     * five times the $0.25 actually taken, and the referral ledger accrues
     * 20% of whatever this says.
     *
     * The fee account is a USDC account, so Jupiter takes the cut from the
     * USDC side, and on a USDC-in buy that is exactly bps of the input.
     * Computed from the input it is both correct and exact, with no
     * dependence on which mint a quote chose to report in.
     */
    const feeRaw =
      this.fee.bps > 0 ? (grossRaw * BigInt(this.fee.bps)) / 10_000n : 0n;

    return {
      transaction,
      mint: outputMint,
      amountUsd,
      netInRaw: String(grossRaw),
      feeRaw: String(feeRaw),
      outAmountRaw: q.outAmount as string,
      simOutAmountRaw: verified.simOutAmountRaw,
    };
  }

  /**
   * Build an UNSIGNED buy of `outputMint` paid in NATIVE SOL.
   *
   * The reader asked for "$25 of X" and holds SOL, not USDC. The venue
   * itself answers what $25 IS in SOL — a USDC→SOL pricing quote — and the
   * swap leg then routes exactly those lamports into the asset. Two quotes,
   * one transaction, and the same verification gate the USDC buy passes
   * through, with the input mint it actually spends (Jupiter wraps native
   * SOL as wSOL, which is what the verifier watches).
   *
   * THE FEE RIDES THIS LEG TOO, once a wrapped-SOL fee account is
   * configured. The owner's ruling is one rule for every entrance
   * ("girerken 1 çıkarken 1"), and for a while this leg was the exception:
   * a buy paid in SOL took 0% while the identical buy paid in USDC took
   * the configured bps, and referrals accrued nothing on SOL-funded
   * volume. The blocker was mechanical, not principled — the fee account
   * must be a token account of the INPUT mint, and only a USDC one was
   * configured. With feeWsolAccount set, Jupiter cuts the fee from the
   * lamports in, which is the same input-side law the USDC buy follows.
   * Absent, this leg falls back to no fee rather than a fee to nowhere.
   *
   * AND SO THE VERIFIER MUST NOT BE TOLD TO EXPECT ONE. It used to be
   * handed `feeAccount: this.feeAccount` regardless, and verify.ts throws
   * `fee_account_missing` whenever an expected fee account is absent from
   * the transaction. While no fee account was configured that expectation
   * was undefined and the check slept; the day SPOT_FEE_TOKEN_ACCOUNT was
   * set in production it woke up and rejected EVERY SOL-funded buy with a
   * 422. A leg that takes no fee must not assert one — the expectation has
   * to describe this leg, not the engine's configuration.
   */
  /**
   * THE SOL-FUNDED BUY LIVED HERE — solLamportsForUsd and
   * buildUnsignedBuyWithWrappedSol — and retired with the SOL pocket
   * (2026-08-28, owner's call: USDC is the product's money). Buying SOL
   * as an ASSET is just buildUnsignedSwap with SOL_MINT as the output;
   * what that path still depends on from the SOL work is
   * wrapAndUnwrapSol: false in the swap request (jupiter.ts) so the
   * credited account survives for the verifier to measure, and the
   * caller pre-creating the reader's wrapped-SOL account.
   */

  /**
   * Quote a SELL: exact-in `amountRaw` of `mint`, out USDC. Same policy gate as
   * the buy side — an asset that may not be bought here may not be sold here
   * either, because both legs advertise the same surface.
   */
  async quoteSell(
    mint: string,
    amountRaw: string,
  ): Promise<{ outUsdcRaw: string; outUsd: number; priceImpactPct: number; route: string[] }> {
    await this.policy.assert(mint);
    if (!/^[0-9]+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
      throw new RouteError('bad_input', 'amountRaw must be a positive integer string');
    }
    const q = await this.jupiter.quote(
      {
        inputMint: mint,
        outputMint: USDC_MINT,
        amount: amountRaw,
        slippageBps: this.slippageBps,
      },
      { deadlineAt: this.now() + this.budgetMs },
    );
    const outUsdcRaw = q.outAmount as string;
    return {
      outUsdcRaw,
      outUsd: rawToUsd(BigInt(outUsdcRaw)),
      priceImpactPct: Number(q.priceImpactPct ?? 0),
      route: (q.routePlan ?? []).map(
        (r: { swapInfo?: { label?: string } }) => r.swapInfo?.label ?? 'unknown',
      ),
    };
  }
  /**
   * Build an UNSIGNED sell: exact-in `amountRaw` of `mint`, USDC to the seller.
   *
   * Mirrors buildUnsignedSwap with the mints swapped, and goes through the SAME
   * verifySwapTransaction — that function is direction-agnostic over
   * {inputMint, outputMint, amountInRaw}, so a tampered build is caught on the
   * way out exactly as on the buy side.
   *
   * NO FEE, deliberately, for now. splitFee cuts the USDC INPUT before the
   * swap; on a sell the USDC is the OUTPUT.
   *
   * THE FEE RIDES BOTH LEGS NOW (2026-08-26, owner's decision after checking
   * the field: Photon charges 1% on every trade, buy and sell, and Axiom,
   * BullX and GMGN all charge both sides too — a one-sided fee is not what
   * this market does). No bolted-on transfer was needed in the end: Jupiter
   * takes the platform fee in the mint of whichever account you hand it, and
   * ours is USDC, which is the OUTPUT here. The same two parameters the buy
   * leg passes do the whole job.
   *
   * The one asymmetry that survives is in the ARITHMETIC, not the policy:
   * on a buy the fee is bps of the USDC input, exact by construction; on a
   * sell the quote's own `platformFee.amount` IS raw USDC and can be read
   * directly. Both are recorded in feeRaw, and neither is guessed.
   */
  async buildUnsignedSell(
    mint: string,
    amountRaw: string,
    signer: Pick<Signer, 'publicKey'>,
  ): Promise<UnsignedSwap> {
    await this.policy.assert(mint);
    if (!/^[0-9]+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
      throw new RouteError('bad_input', 'amountRaw must be a positive integer string');
    }

    const userPublicKey = await signer.publicKey();
    const quotedAt = this.now();
    const deadline = { deadlineAt: quotedAt + this.tradeBudgetMs };
    const q = await this.jupiter.quote(
      {
        inputMint: mint,
        outputMint: USDC_MINT,
        amount: amountRaw,
        slippageBps: this.slippageBps,
        platformFeeBps: this.fee.bps > 0 ? this.fee.bps : undefined,
      },
      deadline,
    );

    const transaction = await this.jupiter.buildSwap(
      { quoteResponse: q, userPublicKey, feeAccount: this.feeAccount },
      deadline,
    );

    if (this.now() - quotedAt > QUOTE_MAX_AGE_MS) {
      throw new RouteError('quote_stale', 'Quote went stale — retry');
    }

    // Computed before the verification rather than after it, because the
    // floor below has to know it. Same expression as the return value's.
    const feeFloorRaw =
      this.fee.bps > 0
        ? String((q as { platformFee?: { amount?: string } }).platformFee?.amount ?? '0')
        : '0';

    const verified = await verifySwapTransaction(
      transaction,
      {
        userPublicKey,
        inputMint: mint,
        outputMint: USDC_MINT,
        amountInRaw: amountRaw,
        feeAccount: this.feeAccount,
        /**
         * The floor, DELIBERATELY LENIENT BY THE FEE.
         *
         * On this leg alone the platform's cut comes out of the USDC
         * output, so what the wallet actually receives is the quote's
         * outAmount less that cut — and whether Jupiter's outAmount is
         * already net of it is not something this file can prove from
         * here. Subtracting the fee makes the floor lower than it strictly
         * needs to be if the quote was already net, and exactly right if
         * it was not.
         *
         * That is the correct direction to be wrong in. A floor set too
         * high refuses honest sells; a floor set one fee too low still
         * blocks the attack it exists for by three or four orders of
         * magnitude, because the attack returns ONE base unit.
         */
        outAmountRaw: String(
          BigInt(q.outAmount as string) > BigInt(feeFloorRaw)
            ? BigInt(q.outAmount as string) - BigInt(feeFloorRaw)
            : 0n,
        ),
        slippageBps: this.slippageBps,
      },
      {
        simulator: this.simulator,
        requireAmountCheck: this.requireAmountCheck,
      },
    );

    /**
     * ON A SELL THE REPORT CAN BE TRUSTED, and this is the one leg where
     * that is true. Jupiter denominates `platformFee.amount` in the OUTPUT
     * mint; here the output IS USDC, so the number is already dollars in
     * raw base units. On a BUY the same field is in the token's units and
     * reading it as dollars overstated a $0.25 fee as $1.24 — measured
     * live, which is why that leg computes from the input instead.
     */
    const feeRaw = feeFloorRaw;

    return {
      transaction,
      mint,
      // USD value of the sell, from the quote's USDC out.
      amountUsd: rawToUsd(BigInt(q.outAmount as string)),
      netInRaw: amountRaw,
      feeRaw,
      outAmountRaw: q.outAmount as string,
      simOutAmountRaw: verified.simOutAmountRaw,
    };
  }
}
