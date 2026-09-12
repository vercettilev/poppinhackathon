import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  Response,
  UnprocessableEntityException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { RouteError } from '@repo/spot-core';
import { IconService } from './icon.service';
import { popCardUrl } from '../pop-card/pop-card.link';
import { FirebaseAuthGuard } from '../guards/firebase-auth.guard';

import { findAssetForPage, scorePage } from './asset-match.util';
import {
  openMintFromText,
  openMintFromUrl,
  pairFromUrl,
} from './venue-match';
import { resolveDexPairBaseMint } from './dex-pair.util';

/**
 * The Trades tab's noise floor. Well under the card's MIN_SCORE (20) on
 * purpose — the tab is allowed to show what the card must not — but above
 * the single-passing-mention band (1-4) that the calibration corpus shows is
 * always wrong. A page's shortlist should contain ideas, not every proper
 * noun that happened to appear.
 */
const CANDIDATE_FLOOR = 6;
import { curatedByMint, restrictionsFor } from '@repo/spot-core';
import type { PageSignals } from '../keyword-extraction/keyword-extraction.util';
import { EmbedEnabledGuard } from '../embed/embed-enabled.guard';
import { GeoBlockingService } from '../geo-blocking/geo-blocking.service';
import { isSparkRange, SparkService } from './spark.service';
import { SpotEnabledGuard } from '../spot/spot-enabled.guard';
import { SpotSwapService } from '../spot/spot-swap.service';
import { TriggerOrderService } from '../spot/trigger-order.service';

/**
 * The tweet a trade came from, or null — never a lie.
 *
 * This string funds the caller-credit programme (points, KOL receipts, one
 * day cash), which makes it the one field on the swap body somebody will
 * eventually try to forge. Validation is therefore shape-tight: an X status
 * permalink and nothing else — not a shortener, not a profile, not another
 * site wearing a cashtag. Anything off-shape records as null rather than
 * refusing the TRADE: attribution is bookkeeping, and bookkeeping must
 * never cost a reader their fill.
 */
export function tweetSourceOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (url.length > 300) return null;
  return /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/[0-9]{1,25}$/.test(url)
    ? url
    : null;
}

/**
 * §Sunrise PoC — "is this page about a tradeable asset, and what does it cost
 * right now?"
 *
 * PUBLIC, like the prediction-match /find route it sits beside: it returns
 * only catalog data and a public market quote, never anything user-scoped, so
 * it needs no auth and mints no trade token. A reader viewing a page must not
 * acquire a trading credential just because the page happened to mention
 * SpaceX.
 *
 * Returns `{ asset: null }` rather than 404 when nothing matches. A page with
 * no tradeable asset is the normal case, not an error, and a 404 would make
 * every ordinary pageview look like a failure in the client's logs.
 */
@Controller('embed/asset')
// §Sunrise PoC — default-off kill-switch. Without it, merging the scrape
// wiring to main would start matching assets on live publisher pages the
// moment it deployed, since the embed calls this on every page load.
//
// EmbedEnabledGuard first, matching SunriseController and EmbedTradeController:
// killing the whole embed surface has to kill this too. Without it this route
// would keep answering while every other embed route went dark, which is the
// opposite of what a master kill-switch is for.
@UseGuards(EmbedEnabledGuard, SpotEnabledGuard)
export class AssetMatchController {
  private readonly logger = new Logger(AssetMatchController.name);
  constructor(
    private readonly spot: SpotSwapService,
    private readonly icons: IconService,
    private readonly triggers: TriggerOrderService,
    private readonly geo: GeoBlockingService,
    private readonly spark: SparkService,
  ) {}

  /**
   * Everything on this page worth trading, most relevant first.
   *
   * The CARD's contract is unchanged and deliberately different: it shows one
   * asset or nothing, because it appears uninvited on somebody's reading and
   * silence is the correct default there. This route answers a question the
   * reader ASKED by opening the Trades tab, so the honest answer is the whole
   * ranked shortlist — including the runners-up the dominance rule suppresses.
   * An article comparing NVIDIA and Micron gets no card, and that stays right;
   * listing both when asked is not the same claim.
   *
   * Public and read-only, like /match: a reader looking at a page must not
   * acquire a trading credential just by looking.
   */
  @Post('candidates')
  async candidates(@Body() signals: PageSignals) {
    const outcome = scorePage(signals ?? {});
    // The floor keeps noise out: a single passing mention scores in the low
    // single digits and is not a trading idea. Capped because a shortlist
    // longer than a screen is a search result, not a shortlist.
    const ranked = outcome.candidates
      .filter((c) => c.score >= CANDIDATE_FLOOR)
      .slice(0, 8);
    if (ranked.length === 0) return { candidates: [] };

    // Prices AND decimals: the panel hands a tapped row straight to the card,
    // and a card without decimals cannot render an amount — the same reason
    // /match refuses to answer without them. Parallel, and a failure is a
    // null rather than a thrown request: a row that cannot be traded from
    // here still deserves to be listed.
    const [prices, decimalsList] = await Promise.all([
      this.spot.priceManyPublic(ranked.map((c) => c.mint)),
      Promise.all(
        ranked.map((c) =>
          this.spot.decimalsOf(c.mint).catch(() => null as number | null),
        ),
      ),
    ]);

    return {
      candidates: ranked.map((c, i) => {
        const curated = curatedByMint(c.mint);
        const p = prices.get(c.mint);
        return {
          mint: c.mint,
          symbol: curated?.ticker ?? c.symbol,
          displayName: curated?.displayName ?? c.name,
          category: curated?.category ?? 'token',
          issuer: curated?.issuer ?? null,
          score: c.score,
          confidence: c.confidence,
          // Which words on the page put it here — the reader can check our
          // work, which is the difference between a shortlist and a hunch.
          matchedDirect: c.matchedDirect,
          priceUsd: p?.usdPrice ?? null,
          change24hPct: p?.priceChange24h ?? null,
          decimals: decimalsList[i] ?? null,
          name: curated?.name ?? c.name,
          restrictions: [] as string[],
          // Whether this one is ALSO the card's pick. The tab and the page
          // must not disagree about what the page is mainly about.
          isPagePick: outcome.match?.mint === c.mint,
        };
      }),
    };
  }

  @Post('match')
  async match(@Request() req: unknown, @Body() signals: PageSignals) {
    const match = findAssetForPage(signals ?? {});
    if (match) {
      return {
        asset: await this.describeMint(
          match.mint,
          match.symbol,
          match.name,
          req,
          {
            confidence: match.confidence,
            certainty: match.certainty,
            score: match.score,
            matchedDirect: match.matchedDirect,
            matchedThematic: match.matchedThematic,
          },
        ),
      };
    }

    /**
     * THE PAGE-DISCOVERED OPEN MINT. The catalog scorer found nothing, but
     * the page may be a memecoin's own venue page or a post printing its
     * contract address — and by-mint already proves an open mint can be
     * admitted and described. This routes a page-found address through the
     * SAME gate.
     *
     * TWO CERTAINTIES, by where the address lived. A mint in a dedicated
     * token URL (pump.fun/coin/…, solscan/token/…) is the reader looking
     * AT that token, so it opens itself ('exact'); a lone address in prose
     * is the reader NEAR it, so the card is offered but does not pop
     * ('inferred'). This mirrors the URL-vs-text split the catalog tiers
     * already use, and it bounds the gate call to at most one per page.
     *
     * COST DISCIPLINE, because this route is PUBLIC and the extension hits
     * it on every page load AND every SPA navigation. Without a guard, an
     * address that fails the gate (a non-Solana base58 run in prose, a
     * pair that is not a token) would re-fire admit → Jupiter on every one
     * of those, against the same quota the whole product's quotes share.
     * tryOpenMint remembers the LAST verdict per address for a few minutes,
     * so a given string costs at most one upstream round trip per window —
     * failures included.
     */
    const urlMint = openMintFromUrl(signals?.url);
    let asset = urlMint ? await this.tryOpenMint(urlMint, 'exact', req) : null;

    // A dexscreener segment that did not admit as a mint is a PAIR: resolve
    // it to its base token and try that. geckoterminal is always a pool.
    if (!asset) {
      const pair = pairFromUrl(signals?.url);
      if (pair) {
        const base = await resolveDexPairBaseMint(pair);
        if (base) asset = await this.tryOpenMint(base, 'exact', req);
      }
    }
    // A lone contract address in prose: offered, not auto-opened.
    if (!asset) {
      const textMint = openMintFromText(signals?.bodyExcerpt);
      if (textMint) asset = await this.tryOpenMint(textMint, 'inferred', req);
    }
    return { asset };
  }

  /**
   * The last open-mint verdict per address, remembered so a PUBLIC route
   * the extension calls on every pageview cannot be turned into an
   * uncached Jupiter fan-out. Both the null (gate refused / not a mint)
   * and the resolved asset are cached; the shape a describeMint returns is
   * request-agnostic except for IP restrictions, which the caller re-reads,
   * so caching the description across readers is safe.
   */
  private readonly openMintCache = new Map<
    string,
    { at: number; asset: unknown }
  >();
  private static readonly OPEN_MINT_TTL_MS = 5 * 60 * 1000;

  private async tryOpenMint(
    mint: string,
    certainty: 'exact' | 'inferred',
    req: unknown,
  ): Promise<unknown> {
    const held = this.openMintCache.get(mint);
    if (held && Date.now() - held.at < AssetMatchController.OPEN_MINT_TTL_MS) {
      return held.asset;
    }
    let asset: unknown = null;
    try {
      await this.spot.admit(mint);
      const stats = await this.spot.tokenStats(mint);
      if (stats.symbol) {
        asset = await this.describeMint(
          mint,
          stats.symbol,
          stats.name ?? stats.symbol,
          req,
          {
            confidence: 'confident',
            certainty,
            // An unbounded sum's max is what the catalog exact tier uses; an
            // open mint that cleared the gate is no less certain about WHAT
            // it is, only about whether to auto-open, which certainty says.
            score: Number.MAX_SAFE_INTEGER,
          },
        );
      }
    } catch {
      asset = null;
    }
    this.openMintCache.set(mint, { at: Date.now(), asset });
    if (this.openMintCache.size > 5_000) {
      // Oldest out, not a full flush — a flush would let a burst of junk
      // addresses evict every genuine resolution.
      const oldest = this.openMintCache.keys().next().value;
      if (oldest !== undefined) this.openMintCache.delete(oldest);
    }
    return asset;
  }

  /**
   * Everything the card needs about ONE mint, enriched.
   *
   * Extracted from /match so /by-mint can answer with the same shape rather
   * than a second, subtly different one. Two endpoints describing the same
   * asset differently is how a card ends up showing a logo on one path and
   * not the other, and nobody can say which is right.
   *
   * `base` is what the CALLER knows about why this mint came up. /match fills
   * it from the page it read; /by-mint has no page, so it says so.
   */
  private async describeMint(
    mint: string,
    symbol: string,
    fallbackName: string,
    req: unknown,
    base: {
      confidence: string;
      certainty: string;
      score: number;
      matchedDirect?: readonly string[];
      matchedThematic?: readonly string[];
    },
  ) {
    const curated = curatedByMint(mint);

    // Restrictions apply to THIS reader, so they need a country. Resolved from
    // the request IP, best-effort: a failed lookup yields no restrictions,
    // which matches §8's fail-open posture.
    let restrictions: readonly string[] = [];
    if (curated) {
      try {
        const ip = this.geo.getClientIP(req);
        const loc = ip ? await this.geo.getGeoLocation(ip) : null;
        restrictions = restrictionsFor(curated, loc?.countryCode);
      } catch {
        restrictions = [];
      }
    }

    // Best-effort price, market row and sparkline, in parallel. A failure of
    // any of them must NOT suppress the asset: it is still tradeable, the card
    // just omits what it does not know.
    let indicativeUsd: number | null = null;
    let change24hPct: number | null = null;
    let icon: string | null = null;
    let mcap: number | null = null;
    let holderCount: number | null = null;
    let spark24h: number[] | null = null;
    /**
     * THE GATE'S EVIDENCE, DISCLOSED. The trade gate already reads the
     * pool's liquidity, its age and the mint's authorities before any open
     * mint is allowed a sheet — and then told the reader none of it. These
     * ride the SAME Ultra row tokenStats already fetched, so disclosure
     * costs no request. Null per field = Ultra did not say; the client
     * says nothing rather than guessing.
     */
    let safety: {
      liquidityUsd: number | null;
      poolCreatedAtMs: number | null;
      mintAuthorityRetained: boolean | null;
      freezeAuthorityRetained: boolean | null;
    } | null = null;
    const [quoted, stats, spark] = await Promise.allSettled([
      this.spot.quote(mint, 10),
      this.spot.tokenStats(mint),
      this.spark.spark24h(mint),
    ]);
    if (quoted.status === 'fulfilled') indicativeUsd = quoted.value.pricePerUnit;
    if (stats.status === 'fulfilled') {
      change24hPct = stats.value.change24hPct;
      icon = stats.value.icon;
      mcap = stats.value.mcap;
      holderCount = stats.value.holderCount;
      safety = {
        liquidityUsd: stats.value.liquidityUsd,
        poolCreatedAtMs: stats.value.poolCreatedAtMs,
        mintAuthorityRetained: stats.value.mintAuthorityRetained,
        freezeAuthorityRetained: stats.value.freezeAuthorityRetained,
      };
    }
    if (spark.status === 'fulfilled') spark24h = spark.value;

    // Decimals come from Jupiter, never from a constant. The card renders raw
    // base units with them, so a wrong value misprints the bought amount by
    // orders of magnitude.
    let decimals: number | null = null;
    try {
      decimals = await this.spot.decimalsOf(mint);
    } catch {
      decimals = null;
    }

    return {
      mint,
      symbol,
      name: curated?.name ?? fallbackName,
      displayName: curated?.displayName ?? fallbackName,
      change24hPct,
      icon,
      mcap,
      holderCount,
      spark24h,
      safety,
      confidence: base.confidence,
      certainty: base.certainty,
      score: base.score,
      indicativeUsd,
      decimals,
      issuer: curated?.issuer ?? null,
      restrictions,
      matchedDirect: base.matchedDirect ?? [],
      matchedThematic: base.matchedThematic ?? [],
    };
  }

  /**
   * One asset, named by its mint rather than found on a page.
   *
   * The card's Holdings list needs this: a row there is a mint the reader
   * already owns, and opening its card means having everything /match returns
   * — the logo, the market cap, the sparkline. /positions carries none of
   * that, and mounting a card from what it does carry produces a visibly
   * half-loaded card on the one surface where trust matters most.
   *
   * REFUSES ANYTHING NOT IN THE CATALOG. /match can answer about an open mint
   * because a page argued for it; here the only argument is that a caller
   * asked, and "describe this arbitrary mint" is a different, larger promise
   * than this endpoint is making.
   *
   * certainty is 'exact' and it is earned: the reader HOLDS this. There is no
   * inference in the chain at all.
   */

  /**
   * The X trade strip's kill switch. Matching happens on the reader's
   * device against the bundled catalog; this is the one thing the server
   * still controls — whether the feature runs at all, and which mints it
   * must not offer. Env-driven so a flip is a Railway variable, not a
   * deploy: X_STRIP_ENABLED=false kills it, X_STRIP_DISABLED_MINTS is a
   * comma-separated blocklist for an alias that turns out to be a trap.
   */
  @Get('x-strip-config')
  xStripConfig() {
    return {
      enabled: process.env.X_STRIP_ENABLED !== 'false',
      disabledMints: (process.env.X_STRIP_DISABLED_MINTS ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    };
  }

  /**
   * One mint, described well enough to trade.
   *
   * ── WHY THIS STOPPED BEING CURATED-ONLY ─────────────────────────────────
   * It used to answer `{asset: null}` for anything outside the catalog, which
   * was right while the catalog WAS the product. It is not any more: the
   * routing engine admits open mints through §7's measured gate, and a live
   * probe confirmed the whole path works for them (CATE, Jotchua, BULLSHIT
   * all quote with real routes). With this route refusing to describe them,
   * the client could route an asset it could not name — so the surfaces that
   * need a name, an icon and decimals were stuck at 127 rows.
   *
   * THE GATE IS ASKED FIRST, and that ordering is the point. Describing an
   * asset is an OFFER; if §7 would refuse the trade, the offer must not be
   * made. Finding that out at Confirm is the worst possible moment.
   *
   * Identity for an open mint comes from Ultra, because it is the only
   * identity such an asset has. A mint the gate admits but nobody can name is
   * still refused: a Buy button over an unnamed contract is not a product.
   */
  /**
   * The chip's chart: closes for one mint over one range. Public for the
   * same reason the matcher is — catalog assets and public market history,
   * nothing user-scoped — and behind the same kill-switches, because a dead
   * embed surface must not keep serving charts.
   */
  @Post('series')
  async series(@Body() body: { mint?: string; range?: string }) {
    const mint = typeof body?.mint === 'string' ? body.mint.trim() : '';
    const range = isSparkRange(body?.range) ? body.range : '1d';
    if (!mint) return { points: null, failed: false };
    // `failed` is the difference between "no candles exist" and "we could
    // not reach them" — the chip words those two very differently, and
    // without it every miss reads as a fact about the asset.
    const r = await this.spark.seriesResult(mint, range);
    // `times` so the chart's axis is drawn from the candles' own clock.
    // Without it the chip spread points evenly across the range's name,
    // which on a thin pool drew 36 hours of $ANTHROPIC under a "1H" label.
    // Opens/highs/lows ride along: the same fetch already produced them and
    // a candle view cannot be drawn without them. Same order and length as
    // points, or null exactly when points is.
    return {
      points: r.points,
      times: r.times,
      opens: r.opens,
      highs: r.highs,
      lows: r.lows,
      failed: r.failed,
    };
  }

  /**
   * `$TICKER` → mint, for cashtags the shipped catalog and ticker map have
   * never heard of. PUBLIC and read-only, same posture as /by-mint: the
   * resolution is catalog-first, then Ultra under the ambiguity rule, then
   * the same admission gate — so a mint can only come back if /by-mint
   * would describe it and /swap would trade it. The client follows up with
   * /by-mint for the full shape; this endpoint only answers WHICH mint.
   */
  /**
   * The token's icon, as BYTES from our origin. The extension's background
   * fetches this instead of whatever gateway Jupiter's metadata names,
   * because the reader's ISP is not a dependency we control — measured:
   * every IPFS rung healthy from the server while the same URLs never
   * arrived at one reader's browser. Mint-only input, so this cannot be
   * steered at arbitrary addresses. 404 (not an error body) on a miss, so
   * the client's own gateway ladder still gets its turn as the fallback.
   */
  @Get('icon')
  async icon(@Query('mint') mintRaw: string, @Response() res) {
    const mint = typeof mintRaw === 'string' ? mintRaw.trim() : '';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return res.status(400).json({ message: 'mint required' });
    }
    const icon = await this.icons.iconFor(mint);
    if (!icon) return res.status(404).end();
    res.setHeader('Content-Type', icon.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    return res.status(200).send(icon.bytes);
  }

  @Post('by-ticker')
  async byTicker(@Body() body: { ticker?: string }) {
    const ticker = typeof body?.ticker === 'string' ? body.ticker : '';
    if (!ticker) return { mint: null };
    return { mint: await this.spot.resolveTicker(ticker) };
  }

  /**
   * "N bought from this tweet" — the one social-proof number the chip shows.
   *
   * Public and read-only like /match: it decorates a tweet anybody can see
   * with an aggregate anybody could compute from the chain. The URL passes
   * the SAME validator the swap body does (tweetSourceOrNull), so the only
   * askable keys are exactly the keys recordTrade can write — an off-shape
   * URL answers { buyers: 0 } rather than an error, because this line is
   * decoration and decoration never gets to fail loudly.
   */
  @Post('tweet-proof')
  async tweetProof(@Body() body: { url?: string }) {
    const url = tweetSourceOrNull(body?.url);
    if (!url) return { buyers: 0 };
    return { buyers: await this.spot.buyersFromTweet(url) };
  }

  @Post('by-mint')
  async byMint(@Request() req: unknown, @Body() body: { mint?: string }) {
    const mint = typeof body?.mint === 'string' ? body.mint.trim() : '';
    if (!mint) return { asset: null };

    const curated = curatedByMint(mint);
    if (curated) {
      return {
        asset: await this.describeMint(mint, curated.ticker, curated.name, req, {
          confidence: 'confident',
          certainty: 'exact',
          score: Number.MAX_SAFE_INTEGER,
        }),
      };
    }

    try {
      await this.spot.admit(mint);
    } catch {
      /**
       * REFUSED, BUT WE STILL KNOW WHAT IT IS.
       *
       * `asset: null` stays null, because the gate said no and no surface
       * should be able to build an offer out of this answer. What changes
       * is that the refusal now carries the token's NAME.
       *
       * Reported from the field: a reader tapped a $LAPTOP row that named
       * the token and showed its price, and the room they landed in said
       * "Unknown token". We did know it — the row had just said so. The
       * old shape threw the identity away with the offer, so a refusal we
       * could explain came out as ignorance we could not.
       *
       * One stats call, only on a path a reader deliberately opened, and
       * only after the gate has already declined. A failure to read the
       * name leaves it null and the room falls back to its old wording,
       * which is the correct floor rather than a guess at a ticker.
       */
      try {
        const stats = await this.spot.tokenStats(mint);
        if (stats.symbol) {
          return {
            asset: null,
            refused: { symbol: stats.symbol, name: stats.name ?? stats.symbol },
          };
        }
      } catch {
        // Unreadable as well as inadmissible. Nothing to name.
      }
      return { asset: null };
    }

    const stats = await this.spot.tokenStats(mint);
    if (!stats.symbol) return { asset: null };

    return {
      asset: await this.describeMint(
        mint,
        stats.symbol,
        stats.name ?? stats.symbol,
        req,
        {
          confidence: 'confident',
          certainty: 'exact',
          score: Number.MAX_SAFE_INTEGER,
        },
      ),
    };
  }

  /**
   * Live quote for an amount the reader actually typed. PUBLIC and read-only,
   * same posture as /match: it prices a public market and touches no wallet.
   *
   * Separate from /match's `indicativeUsd`, which is a fixed $10 probe taken
   * once so the card can paint a real number instead of a spinner. This is the
   * number that moves as they type.
   */
  @Post('quote')
  async quote(@Body() body: { mint?: string; amountUsd?: number }) {
    return this.priceIt(body?.mint, body?.amountUsd);
  }

  /**
   * The SAME quote over GET, because the publisher embed asks for it that way.
   *
   * This is not a nicety. `apps/embed/src/trade.ts` has always called
   * `GET /embed/asset/quote?mint=&amountUsd=`, and it was served by the sunrise
   * controller that the spot engine replaced. Dropping the verb would have made
   * the embed's quote silently return null — `if (!res.ok) return null` — so the
   * panel would price nothing and report nothing, on live publisher pages, with
   * no error anywhere. It survived only because SUNRISE_ASSET_ENABLED is unset,
   * which means the break was scheduled for whoever flipped that flag next.
   *
   * The extension posts a body, the embed sends a query string, and neither
   * client is going to be redeployed on the backend's schedule. One
   * implementation, two verbs, and the shape the embed already parses —
   * including `mint` and `amountUsd`, which it echoes back.
   */
  @Get('quote')
  async quoteViaGet(
    @Query('mint') mint?: string,
    @Query('amountUsd') amountUsd?: string,
  ) {
    const priced = await this.priceIt(mint, Number(amountUsd));
    return { mint: (mint ?? '').trim(), amountUsd: Number(amountUsd), ...priced };
  }

  private async priceIt(rawMint?: string, rawAmount?: number) {
    const mint = (rawMint ?? '').trim();
    const amountUsd = Number(rawAmount);
    if (!mint || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new BadRequestException('mint and a positive amountUsd are required');
    }
    /**
     * A REFUSAL IS NOT A CRASH. This call throws RouteError when the gate
     * declines a mint or the route cannot be priced, and nothing caught it —
     * so a perfectly ordinary "we do not offer this" reached the client as
     * HTTP 500 "Internal server error". Measured live: CYBERLEEK, a token the
     * gate declines, 500'd exactly like a genuine bug would.
     *
     * That was survivable while only catalog mints could be asked about. The
     * moment the client can name thousands of mints, this is the difference
     * between "not available" and the product looking broken. The swap path
     * has mapped this error for as long as it has existed; the read path just
     * never did.
     */
    let q: Awaited<ReturnType<typeof this.spot.quote>>;
    try {
      q = await this.spot.quote(mint, amountUsd);
    } catch (err) {
      if (err instanceof RouteError) {
        if (err.failure === 'bad_input') throw new BadRequestException(err.message);
        throw new UnprocessableEntityException(err.message);
      }
      throw err;
    }
    return {
      outAmount: q.outAmount,
      pricePerUnit: q.pricePerUnit,
      priceImpactPct: q.priceImpactPct,
      route: q.route,
    };
  }

  /**
   * Buy. AUTHENTICATED, unlike the two routes above — this one spends the
   * reader's custodial USDC, so it takes the extension's normal Firebase
   * identity rather than the embed's trade-scope token. The embed has its own
   * route at POST /embed/trade/asset-swap with its own guard chain; these are
   * two clients with two auth models hitting one service, and merging them
   * would mean one of them holding a credential shaped for the other.
   *
   * DRY RUN UNLESS `SPOT_SWAP_LIVE` IS EXACTLY 'true'. Shipped off. With it
   * off this route quotes, builds, verifies and simulates a real transaction
   * and then stops before signing — which is the honest way to exercise the
   * whole chain against production without spending anything.
   */
  @Post('swap')
  @UseGuards(FirebaseAuthGuard)
  async swap(
    @Request() req: { user: { uid: string } },
    @Body()
    body: {
      mint?: string;
      amountUsd?: number;
      idempotencyKey?: string;
      payWith?: string;
      sourceUrl?: string;
    },
  ) {
    const mint = (body?.mint ?? '').trim();
    const amountUsd = Number(body?.amountUsd);
    if (!mint || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new BadRequestException('mint and a positive amountUsd are required');
    }
    /**
     * payWith IS ACCEPTED AND IGNORED. The SOL pocket retired 2026-08-28
     * (owner's call: USDC is the product's money), but extensions in the
     * field still send payWith:"SOL" when their local USDC read falls
     * short. Refusing them would brick a buy that USDC may well cover —
     * the server's own pre-flight is the authority on that — so the field
     * is tolerated, the value is dropped, and a SOL request is logged so
     * we can watch the old clients age out.
     */
    if (body?.payWith === 'SOL') {
      this.logger.log('[spot] legacy payWith:SOL ignored; buys spend USDC');
    }
    /**
     * THE KEY IS THE CLIENT'S OR IT IS NOTHING.
     *
     * This read `body.idempotencyKey?.trim() || randomUUID()` under a
     * comment saying "a missing key would let a double-submit buy twice". A
     * freshly random key per REQUEST is exactly what lets a double-submit
     * buy twice: two presses arrive as two different keys and both go
     * through. The fallback did not protect the trade, it protected the
     * type — and it silenced trade-safety's own warning, so the logs said
     * dedup was fine on every buy that had none.
     *
     * The reasoning was inverted too. Idempotency wants a key that does NOT
     * vary between retries of one intent; "the client cannot be relied on
     * to vary it" is an argument FOR a client-minted key, not against one.
     * The extension now mints one inside the press handler (inlineBuy's
     * pressKey), which is the only place that knows where one human
     * decision ends and the next begins.
     *
     * Undefined passes through deliberately: beginTrade logs "dedup
     * disabled for this request" and proceeds, which is the honest state
     * for an old client and one we can finally see.
     */
    const idempotencyKey = body?.idempotencyKey?.trim() || undefined;

    const r = await this.spot.swap(req.user.uid, {
      outputMint: mint,
      amountUsd,
      idempotencyKey,
      sourceUrl: tweetSourceOrNull(body?.sourceUrl),
    });
    return {
      signature: r.signature,
      dryRun: r.dryRun,
      category: r.category,
      outAmountRaw: r.outAmountRaw,
      /* The share card's URL, signed here because the client cannot: the
         secret is ours. Null on a dry run and on a deploy with no secret,
         so a share button can be absent rather than broken. */
      shareUrl: r.dryRun ? null : popCardUrl(r.signature),
    };
  }

  /**
   * The reader's balance of one mint. AUTHENTICATED — a balance is a holding,
   * and holdings are private. Drives exactly two things: whether Sell renders
   * at all, and the sell panel's Max.
   */
  /**
   * The whole book: every catalog holding, priced, with PnL where the trade
   * ledger can honestly compute one. AUTHENTICATED — same privacy posture as
   * /balance, of which this is the plural.
   */
  @Post('positions')
  @UseGuards(FirebaseAuthGuard)
  async positions(@Request() req: { user: { uid: string } }) {
    return this.spot.positions(req.user.uid);
  }

  @Post('balance')
  @UseGuards(FirebaseAuthGuard)
  async balance(
    @Request() req: { user: { uid: string } },
    @Body() body: { mint?: string },
  ) {
    const mint = (body?.mint ?? '').trim();
    if (!mint) throw new BadRequestException('mint is required');
    return this.spot.balanceOf(req.user.uid, mint);
  }

  /**
   * Sell. AUTHENTICATED, same posture as /swap. Exact-in RAW base units,
   * echoed from /balance — the client never does decimal math on them. USDC
   * lands in the seller's wallet; no fee is taken on sells (engine doc says
   * why).
   */
  @Post('sell')
  @UseGuards(FirebaseAuthGuard)
  async sell(
    @Request() req: { user: { uid: string } },
    @Body()
    body: { mint?: string; amountRaw?: string; idempotencyKey?: string; sourceUrl?: string },
  ) {
    const mint = (body?.mint ?? '').trim();
    const amountRaw = (body?.amountRaw ?? '').trim();
    if (!mint || !/^[0-9]+$/.test(amountRaw)) {
      throw new BadRequestException('mint and a raw integer amountRaw are required');
    }
    // Same rule as /swap above: the client's key, or none and a warning.
    const idempotencyKey = body?.idempotencyKey?.trim() || undefined;
    const r = await this.spot.sell(req.user.uid, {
      mint,
      amountRaw,
      idempotencyKey,
      sourceUrl: tweetSourceOrNull(body?.sourceUrl),
    });
    return {
      signature: r.signature,
      dryRun: r.dryRun,
      outUsdcRaw: r.outAmountRaw,
      // Same as the buy: signed here, because the secret is ours.
      shareUrl: r.dryRun ? null : popCardUrl(r.signature),
    };
  }

  /**
   * Standing orders — buy at a lower price, sell at a higher one — parked on
   * chain with Jupiter's trigger program and filled by keepers at the order's
   * price or better. AUTHENTICATED, same posture as /swap: these spend and
   * receive the same custodial USDC.
   *
   * All three shapes were measured against the live trigger API before this
   * controller existed; the service doc records what was measured.
   */
  @Post('order')
  @UseGuards(FirebaseAuthGuard)
  async orderCreate(
    @Request() req: { user: { uid: string } },
    @Body()
    body: {
      mint?: string;
      side?: string;
      amountUsd?: number;
      amountRaw?: string;
      triggerPriceUsd?: number;
      idempotencyKey?: string;
    },
  ) {
    const mint = (body?.mint ?? '').trim();
    const side =
      body?.side === 'buy' ? 'buy' : body?.side === 'sell' ? 'sell' : null;
    const triggerPriceUsd = Number(body?.triggerPriceUsd);
    if (!mint || !side || !Number.isFinite(triggerPriceUsd) || triggerPriceUsd <= 0) {
      throw new BadRequestException(
        'mint, side and a positive triggerPriceUsd are required',
      );
    }
    const amountRaw = (body?.amountRaw ?? '').trim();
    if (side === 'buy' && !(Number(body?.amountUsd) > 0)) {
      throw new BadRequestException('buy orders need a positive amountUsd');
    }
    if (side === 'sell' && !/^[0-9]+$/.test(amountRaw)) {
      throw new BadRequestException(
        'sell orders need a raw integer amountRaw',
      );
    }
    // Same rule as /swap above: the client's key, or none and a warning.
    const idempotencyKey = body?.idempotencyKey?.trim() || undefined;
    return this.triggers.create(req.user.uid, {
      mint,
      side,
      ...(side === 'buy' ? { amountUsd: Number(body?.amountUsd) } : {}),
      ...(side === 'sell' ? { amountRaw } : {}),
      triggerPriceUsd,
      idempotencyKey,
    });
  }

  /**
   * Cancel a standing order. The service never consults the gate here — a
   * mint falling out of §7 closes the entrance, not the exit.
   */
  @Post('order/cancel')
  @UseGuards(FirebaseAuthGuard)
  async orderCancel(
    @Request() req: { user: { uid: string } },
    @Body() body: { orderKey?: string; idempotencyKey?: string },
  ) {
    const orderKey = (body?.orderKey ?? '').trim();
    if (!orderKey) throw new BadRequestException('orderKey is required');
    // Same rule as /swap above: the client's key, or none and a warning.
    const idempotencyKey = body?.idempotencyKey?.trim() || undefined;
    return this.triggers.cancel(req.user.uid, { orderKey, idempotencyKey });
  }

  /** The user's standing orders, active by default, described for display. */
  @Post('orders')
  @UseGuards(FirebaseAuthGuard)
  async orders(
    @Request() req: { user: { uid: string } },
    @Body() body: { status?: string },
  ) {
    const status = body?.status === 'history' ? 'history' : 'active';
    return this.triggers.list(req.user.uid, status);
  }

  /**
   * Signature → settlement. PUBLIC and read-only: it polls the cluster for a
   * signature the caller already holds, and reveals nothing they did not.
   *
   * Three outcomes, never two. `unknown` is not a failure — the transaction may
   * land after we stop watching, and reporting that as failed would tell a
   * reader they bought nothing when they may well have bought something.
   */
  @Post('confirm')
  async confirm(@Body() body: { signature?: string }) {
    const signature = (body?.signature ?? '').trim();
    if (!signature) throw new BadRequestException('signature is required');

    const outcome = await this.spot.confirm(signature);
    if (outcome.status === 'failed') {
      return {
        status: 'failed' as const,
        // The raw program error travels with it: "it failed" and WHY are
        // different facts, and only the second one is actionable.
        chainError: JSON.stringify(outcome.err).slice(0, 200),
      };
    }
    return { status: outcome.status };
  }
}
