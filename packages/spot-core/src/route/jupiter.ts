import { RouteError } from '../errors';

/**
 * Jupiter transport, behind an interface so the engine can be exercised with
 * fakes. The v1 regression net (`sunrise-swap.dryrun.spec.ts`) supplied its own
 * fakes for exactly this boundary; that file does not exist in any branch of
 * commentin-mono, so the seam is reconstructed here and the tests are written
 * fresh against it.
 */

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Wrapped SOL — the mint Jupiter speaks when the input is native SOL. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Keyless. Permissive in practice, but sends NO rate-limit headers. */
export const JUP_LITE_BASE = 'https://lite-api.jup.ag';
/** Keyed. Reports x-ratelimit-remaining/reset, so throttling is knowable. */
export const JUP_KEYED_BASE = 'https://api.jup.ag';

const JUP_BASE = JUP_LITE_BASE;

/**
 * Which host to use, decided by whether a key exists.
 *
 * Measured 2026-08-12: `api.jup.ag` WITHOUT a key allows **5 requests per 10s
 * window** before returning 429 — unusable for anything, and it would 429 on a
 * single reader browsing a few pages. `lite-api.jup.ag` absorbed ~136
 * back-to-back quotes before throttling, but reports no rate-limit headers, so
 * a retry there is a guess rather than a calculation.
 *
 * So the keyed host is preferred ONLY when a key is actually present. With a
 * key the limit is raised and `x-ratelimit-reset` becomes available; without
 * one, choosing api.jup.ag would be strictly worse on both counts.
 *
 * The keyed limit itself has NOT been measured — no key was available here.
 * Verify it before relying on the ceiling for capacity planning.
 */
export function jupiterEndpoint(apiKey?: string | undefined): {
  base: string;
  apiKey: string | undefined;
} {
  const key = apiKey?.trim() || undefined;
  return key
    ? { base: JUP_KEYED_BASE, apiKey: key }
    : { base: JUP_LITE_BASE, apiKey: undefined };
}

/** Opaque to us: it is handed straight back to /swap and must not be rebuilt. */
export interface JupQuote {
  outAmount?: string;
  priceImpactPct?: string | number;
  routePlan?: { swapInfo?: { label?: string } }[];
  /** Present only when the quote asked for a platform fee. `amount` is raw
   *  base units of the mint the fee is collected in. Reported rather than
   *  recomputed: what Jupiter says it took is the fact. */
  platformFee?: { amount?: string; feeBps?: number } | null;
  [k: string]: unknown;
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** raw base units of inputMint */
  amount: string;
  slippageBps: number;
  /**
   * Platform fee in basis points, taken BY JUPITER out of the swap.
   *
   * It belongs on the quote, not the build: the quote returns a
   * `platformFee` block and an `outAmount` already net of it, so a caller
   * that adds the fee here and shows that outAmount is showing the truth.
   * The matching `feeAccount` goes on the build.
   */
  platformFeeBps?: number | undefined;
}

export interface BuildSwapParams {
  /** The SAME object /quote returned. Re-quoting here executes at a price the
   *  caller never saw. */
  quoteResponse: JupQuote;
  userPublicKey: string;
  /**
   * The TOKEN ACCOUNT that receives the platform fee — an associated token
   * account, never a wallet address, and it must already exist on chain.
   * Jupiter rejects the build otherwise. For an ExactIn swap its mint may
   * be either side of the pair; we always collect in USDC so one account
   * serves buys and sells alike.
   */
  feeAccount?: string | undefined;
}

export interface CallOptions {
  /**
   * Absolute epoch ms. A retry that cannot COMPLETE before this is not
   * attempted at all.
   *
   * §9: "Slower than budget renders nothing rather than arriving late." A
   * retry is only worth having if it can still beat the deadline; otherwise it
   * buys a card nobody sees, at the cost of holding the path open.
   */
  deadlineAt?: number | undefined;
}

export interface JupiterClient {
  quote(params: QuoteParams, opts?: CallOptions): Promise<JupQuote>;
  /** Returns the base64 unsigned transaction. */
  buildSwap(params: BuildSwapParams, opts?: CallOptions): Promise<string>;
}

/** The first backoff. Each further attempt doubles it: 300, 600, 1200. */
const RETRY_BACKOFF_MS = 300;
/**
 * Attempts per call, the first one included.
 *
 * A BACKSTOP, NOT THE POLICY. The caller's deadline is what actually decides
 * when to stop; this exists only so that a server answering 429 with a reset
 * one millisecond out cannot spin forever.
 */
const MAX_ATTEMPTS = 4;
/**
 * The retry ceiling for a caller that set NO deadline.
 *
 * With a deadline this number is never consulted, which is the whole point:
 * it used to be applied to every caller, and see `retryWaitMs` for what that
 * cost.
 */
const MAX_RETRY_WAIT_MS = 1_000;

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class HttpJupiterClient implements JupiterClient {
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  private readonly apiKey: string | undefined;
  private readonly now: () => number;
  /**
   * Injected alongside `now` and for the same reason.
   *
   * A test that stubs the clock but not the sleep is describing a world that
   * cannot happen: the deadline never arrives however long the client waits.
   * The first version of rate-limit.spec worked around it by re-deriving the
   * backoff schedule in the test, which would have kept passing through any
   * change to the real one.
   */
  private readonly sleep: (ms: number) => Promise<void>;

  /**
   * `fetch` is WRAPPED here, never stored bare.
   *
   * It is a host function with a brand check on its receiver. Stored as an
   * instance property and called as `this.fetchFn(url)`, it is invoked with
   * `this` set to this object, and the browser rejects it:
   *
   *   TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope':
   *   Illegal invocation
   *
   * The arrow re-invokes it with `this` undefined, which is exactly what a bare
   * `fetch(url)` call does, and works for a real fetch and for a test double
   * alike.
   *
   * This shipped broken and the unit suite stayed green, because every test
   * injects a fake client and Node's fetch does not brand-check the way the
   * browser's does. `live.spec.ts` exists so that cannot happen twice.
   */
  constructor(
    fetchFn: typeof fetch = fetch,
    base: string = JUP_BASE,
    opts: {
      apiKey?: string | undefined;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.fetchFn = (...args) => fetchFn(...args);
    this.base = base;
    this.apiKey = opts.apiKey;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? delay;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // Header values stay plain ASCII: a non-Latin-1 character in a value makes
    // fetch throw before the request is made.
    return this.apiKey ? { ...extra, 'x-api-key': this.apiKey } : extra;
  }

  /**
   * How long before this request is worth repeating, or null for "stop".
   *
   * THE CALLER'S DEADLINE IS THE AUTHORITY, and the first version had that
   * backwards in a way production made obvious. It measured
   * `x-ratelimit-reset` against a fixed 1000ms ceiling and gave up whenever
   * the window opened later than that — then threw an error reading "Rate
   * limited, and no budget to wait" at a caller who might have had seconds
   * of budget left. A ceiling and a budget are different things, and only
   * one of them belongs to the caller. The ceiling now applies solely to a
   * caller that named no deadline, where there is nothing else to go on.
   *
   * `x-ratelimit-reset` (epoch seconds) is honoured when `api.jup.ag` sends
   * it, because a header saying when the window opens is knowable rather
   * than guessed. `lite-api.jup.ag` sends no rate-limit headers at all, and
   * there the doubling backoff is the honest best available.
   */
  private retryWaitMs(
    res: Response,
    attempt: number,
    deadlineAt: number | undefined,
  ): number | null {
    if (attempt + 1 >= MAX_ATTEMPTS) return null;

    const backoff = RETRY_BACKOFF_MS * 2 ** attempt;
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const wait =
      Number.isFinite(reset) && reset > 0
        ? Math.max(backoff, reset * 1000 - this.now())
        : backoff;

    if (deadlineAt === undefined) return wait > MAX_RETRY_WAIT_MS ? null : wait;
    return this.now() + wait >= deadlineAt ? null : wait;
  }

  /**
   * Keep retrying a 429 for as long as the caller's budget allows.
   *
   * A 429 is NOT `quote_unavailable`: it says nothing about the asset. Merging
   * them would make "we were throttled" and "this thing cannot be traded"
   * indistinguishable in the one field §11 reads conversion from.
   *
   * REPEATING IS SAFE ON BOTH ENDPOINTS THIS CLIENT CALLS. `/quote` is a
   * read, and `/swap` returns an UNSIGNED transaction and broadcasts
   * nothing, so a second attempt cannot spend twice. That is why the limit
   * here is time rather than caution — which is not true one layer up, where
   * a retry around signing has to be argued for case by case (see
   * spot-swap.service).
   */
  private async request(
    url: string,
    init: RequestInit | undefined,
    opts: CallOptions | undefined,
    onFailure: 'quote_unavailable' | 'build_failed',
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, init);
      } catch {
        throw new RouteError(onFailure, 'Request failed');
      }
      if (res.status !== 429) return res;

      const wait = this.retryWaitMs(res, attempt, opts?.deadlineAt);
      if (wait !== null) {
        await this.sleep(wait);
        continue;
      }

      /* THIS SENTENCE IS SHOWN TO A PERSON, which the old one was written
         as though it were not. `RouteError.message` is placed directly into
         the 422 body and rendered in the trade sheet, so somebody who had
         just pressed Buy was told "Rate limited, and no budget to wait".
         popLanguage's rule is literal when money moves, and never a code;
         the one fact that matters to them here is that nothing was
         charged. */
      throw new RouteError(
        'rate_limited',
        'Too much traffic on the router right now. Nothing was charged, press again.',
      );
    }
  }

  async quote(p: QuoteParams, opts?: CallOptions): Promise<JupQuote> {
    const url =
      `${this.base}/swap/v1/quote?inputMint=${p.inputMint}` +
      `&outputMint=${p.outputMint}&amount=${p.amount}` +
      `&slippageBps=${p.slippageBps}` +
      (p.platformFeeBps && p.platformFeeBps > 0
        ? `&platformFeeBps=${p.platformFeeBps}`
        : '');

    const res = await this.request(
      url,
      { headers: this.headers() },
      opts,
      'quote_unavailable',
    );
    if (!res.ok) {
      throw new RouteError('quote_unavailable', 'Quote unavailable');
    }

    const q = (await res.json()) as JupQuote & { error?: string };
    if (q.error || !q.outAmount) {
      throw new RouteError('no_route', 'No route for this asset right now');
    }
    return q;
  }

  async buildSwap(p: BuildSwapParams, opts?: CallOptions): Promise<string> {
    const res = await this.request(
      `${this.base}/swap/v1/swap`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          quoteResponse: p.quoteResponse,
          userPublicKey: p.userPublicKey,
          /**
           * OFF, so that native SOL is an ordinary SPL mint to the router.
           *
           * With this true, Jupiter wraps and then CLOSES the temporary wSOL
           * account inside the swap. The verifier measures quantities by
           * diffing token accounts, so on any SOL leg it diffed an account
           * the transaction had destroyed: 0 before, 0 after, and a real
           * buy of SOL was refused as "does not credit the output mint".
           *
           * With it false the wSOL account is debited and credited like any
           * other token account and survives, so the exact-equality input
           * check and the positive-output check both hold with a tolerance
           * of exactly zero lamports. Wrapping moves into a transaction WE
           * build from three known instructions, where the fee and the rent
           * are ours to reason about rather than noise inside bytes we are
           * trying to verify.
           *
           * Inert for a swap between two ordinary SPL mints, which is every
           * swap that was already working.
           */
          wrapAndUnwrapSol: false,
          ...(p.feeAccount ? { feeAccount: p.feeAccount } : {}),
        }),
      },
      opts,
      'build_failed',
    );
    if (!res.ok) throw new RouteError('build_failed', 'Swap build failed');

    const { swapTransaction } = (await res.json()) as {
      swapTransaction?: string;
    };
    if (!swapTransaction) {
      throw new RouteError('build_failed', 'Swap build failed');
    }
    return swapTransaction;
  }
}
