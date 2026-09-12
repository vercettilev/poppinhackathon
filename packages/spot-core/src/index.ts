/**
 * @repo/spot-core — the Solana spot-swap engine, ported from poppin-v2.
 *
 * FRAMEWORK-FREE ON PURPOSE. No NestJS, no drizzle, no chrome, no key
 * material. Everything here takes its dependencies as constructor arguments
 * (a Jupiter client, a decimals reader, a policy, a signer), which is what
 * lets the same code run behind a custodial backend today and a browser
 * extension tomorrow.
 *
 * The one rule worth defending: nothing in this package may import from
 * apps/backend. The moment routing depends on the server, the Phase 1.5 move
 * to self-custody stops being a substitution and becomes a rewrite.
 */

export { RouteError, badInput, noRoute } from './errors';
export type { DecisionReason, RouteFailure } from './errors';

// ── routing ─────────────────────────────────────────────────────────────────
export { RouteEngine } from './route/engine';
export { QUOTE_MAX_AGE_MS } from './route/engine';
export type { AssetQuoteResult, RouteEngineDeps, UnsignedSwap } from './route/engine';

export {
  HttpJupiterClient,
  JUP_KEYED_BASE,
  JUP_LITE_BASE,
  USDC_MINT,
  SOL_MINT,
  jupiterEndpoint,
} from './route/jupiter';
export type { JupiterClient, JupQuote, QuoteParams, CallOptions } from './route/jupiter';

export { splitFee } from './route/fee';
// Raw USDC → dollars. The backend needs it to turn the fee Jupiter reports
// into the number the referral ledger and the trade response both speak.
export { rawToUsd, usdToRaw, USDC_DECIMALS } from './route/fee';
export { AllowlistPolicy } from './route/policy';
export type { MintPolicy } from './route/policy';

export {
  RpcTransactionSimulator,
  SimulationFailedError,
  BroadcastRejectedError,
  confirmSignature,
  decodeTokenAmount,
  executedTokenDelta,
  sendRawTransaction,
} from './route/simulator';
export { refreshBlockhash } from './route/blockhash';
export type { ConfirmationOutcome, RpcSimulatorOptions } from './route/simulator';

export { TransactionVerificationError, verifySwapTransaction } from './route/verify';
export type {
  BalanceDelta,
  ExpectedSwap,
  TransactionSimulator,
  VerificationFailure,
} from './route/verify';

// ── safety ──────────────────────────────────────────────────────────────────
export {
  DEFAULT_THRESHOLDS,
  ESTABLISHED_BAR,
  isEstablished,
  OpenMintGate,
  thresholdsFromEnv,
} from './safety/open-mint-gate';
export type {
  EstablishedBar,
  GateCheck,
  GateFailure,
  GateVerdict,
  OpenMintThresholds,
  SellRouteChecker,
} from './safety/open-mint-gate';

export {
  CatalogPolicy,
  RegimePolicy,
  attributeBuildFailure,
  regimeOf,
} from './safety/regime';
export type { Regime, RegimeVerdict } from './safety/regime';

// ── curated catalog ─────────────────────────────────────────────────────────
export {
  CURATED_CATALOG,
  curatedByMint,
  curatedByTicker,
  matchCatalogTerms,
  matchCatalogThematic,
  restrictionsFor,
} from './catalog/index';
export type {
  CuratedAsset,
  CuratedIssuer,
  EntityCandidate,
  IssuerRestriction,
} from './catalog/index';

// ── balances ────────────────────────────────────────────────────────────────
export { DecimalsCache } from './balance/decimals';
export type { MintInfoReader } from './balance/decimals';
export { TokenBalanceReader, toUiAmount } from './balance/token-balance';
export type {
  TokenAccountBalance,
  TokenAccountReader,
  TokenBalance,
} from './balance/token-balance';

// ── §6 resolution: page signals → one asset ─────────────────────────────────
export { DEFAULT_TEXT_CAP, extractCandidates } from './context/extract';
export type { Candidates, ExtractInput, TickerCandidate } from './context/extract';

export { MIN_TICKER_MENTIONS, assessIntent } from './intent/index';
export type { IntentVerdict } from './intent/index';

export {
  ADDRESS_PATH_BUDGET_MS,
  BUDGET_FOR,
  ENTITY_PATH_BUDGET_MS,
  TICKER_PATH_BUDGET_MS,
  resolveEntity,
} from './resolve/paths';
export type {
  NoResolution,
  Resolution,
  ResolutionOutcome,
  ResolutionPath,
} from './resolve/paths';

// ── asset resolution ────────────────────────────────────────────────────────
export { HttpUltraSearchClient, resolveTickerFrom } from './resolve/ultra';
export type {
  JupiterUltraTokenInfo,
  UltraOutcome,
  UltraSearchClient,
} from './resolve/ultra';

// ── custody seam ────────────────────────────────────────────────────────────
export { UnsignedOnlySigner } from './signer/index';
export type { Signer, SerializedTransaction } from './signer/index';

// ── classification vocabulary ───────────────────────────────────────────────
export type { AssetCategory, Chain, Journey } from './telemetry/events';

// ── env parsing ─────────────────────────────────────────────────────────────
export {
  readEnv,
  readEnvInt,
  readEnvList,
  readFeatureFlag,
  readSafetyFlag,
} from './config/env';
