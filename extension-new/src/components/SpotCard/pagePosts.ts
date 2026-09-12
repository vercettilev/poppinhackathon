import { sendApiRequest } from "~/lib/fetchService"
import { fetchPagePresence } from "~/helpers/presence"
// pageUrl, not urlHelper: urlHelper's module-level firebase import would
// drag the whole SDK into every page's content bundle for one string fn.
import { stripQueryParams } from "~/helpers/pageUrl"
import { CommentService } from "~/services/CommentService"
import { UserService } from "~/services/UserService"
import {
  assetByMint as assetByMintRaw,
  balanceAsset as balanceAssetRaw,
  positionsAsset as positionsAssetRaw,
} from "~/services/SpotAssetService"
import { sanitisePostText } from "./sanitisePostText"
import {
  AUTHORLESS_NOTIFICATION_TEXT,
  isAuthorlessNotification,
  notificationKind,
  notificationVerb,
  type NotificationKind,
} from "~/helpers/notificationText"
import { WebsitePostService } from "~/services/WebsitePostService"
import { receiptText } from "~/helpers/receiptText"

/**
 * The page's conversation, for the card.
 *
 * A THIN adapter over the post system that already exists — no new endpoints,
 * no second source of truth. `WebsitePostService.get({ website_url })` is the
 * same call the side panel makes, so the card and the panel are looking at one
 * conversation and cannot disagree about it.
 *
 * ── WHY THIS IS SEPARATE FROM THE TRADE PATH ────────────────────────────────
 * Posts are about the PAGE; a trade is about the ASSET. They live on different
 * axes and the card renders them on different rows for that reason. Keeping
 * the data paths apart too means a backend wobble in one cannot take the other
 * down — a page whose posts fail to load still buys, and a page with no
 * tradeable asset still talks.
 */

/** What the card renders. Deliberately less than a WebsitePost: the card shows
 *  a name, a line of text, and nothing that can be clicked into. */
export interface CardPost {
  id: string
  /** PLAIN TEXT. See sanitisePostText — this never contains markup. */
  text: string
  author: string
  /** Author's id, which the vote endpoint requires. */
  authorId: string
  createdAt: string
  upvotes: number
  /** Whether THIS reader has already upvoted — the endpoint needs to be told. */
  upvoted: boolean
  replyCount: number
  /** The author's face. null renders the initial disc instead. */
  avatarUrl?: string | null
  /** A trade receipt rather than a sentence — `on_chain` on the API row. */
  isTrade?: boolean
  /**
   * The trade's OWN market cap, from the ledger. Absent for receipts whose
   * signature has no spot_trades row, which is most of the back catalogue;
   * the sentence then stops early instead of pricing an old trade at
   * today's size.
   */
  mcapUsd?: number | null
  /**
   * Which way, for the tag's colour.
   *
   * Prefers the STRUCTURED trade (post_transaction.trade_type) and falls
   * back to reading our own generated sentence. The fallback is not
   * decoration: rows written before the server started storing the
   * receipt (2026-08-19) have no transaction at all and never will, so a
   * feed shows both kinds side by side for as long as those rows live.
   */
  side?: "buy" | "sell" | null
  /**
   * The traded asset, when the row carries a real receipt. This is what
   * makes a post a DOOR: with a mint the reader can take the same trade in
   * one tap, and without one the row stays a sentence. Every field here
   * comes from post_transaction — never from parsing the text, which can
   * only ever recover a ticker somebody else typed.
   */
  trade?: {
    mint: string
    symbol: string
    /** Tokens, not dollars — the receipt records what was received. */
    amount: number
  } | null
}

/** A reply, which is a comment on a post. Same flattening rules as a post. */
export interface CardReply {
  id: string
  text: string
  author: string
  createdAt: string
  /** The replier's face. Same field the post rows use, same fallback. */
  avatarUrl?: string | null
}

export { sanitisePostText }

/**
 * How many posts the card fetches.
 *
 * Was 3, which made the conversation look tiny on a page that had dozens:
 * the card derived its COUNT from the list it fetched, so a busy page still
 * reported "3 posts". 20 is what the feed view can scroll through without
 * the request growing into something worth thinking about, and it makes the
 * count exact for almost every real page rather than almost none.
 */
const MAX_SHOWN = 20

/**
 * Posts for this page, newest first, capped at what the card shows.
 *
 * Returns an empty list on ANY failure. A conversation that cannot be loaded
 * and a page nobody has posted on look the same to a reader, and the card
 * treats both the same way: it says nothing. Same rule the trade path follows.
 */
export async function fetchPagePosts(
  url: string,
): Promise<{ posts: CardPost[]; total: number; hasMore: boolean }> {
  try {
    const res = await WebsitePostService.get({
      website_url: stripQueryParams(url),
      limit: MAX_SHOWN,
    })
    const rows = Array.isArray(res?.data) ? res.data : []
    // TEST BUILDS ONLY. The catch below returns [] on any failure, which is
    // right for a reader — a conversation that would not load and a page
    // nobody has written on should look the same. It is wrong for whoever is
    // trying to work out why a post they just made is not on the card:
    // "failed" and "empty" are the same silence, and the answer is not
    // guessable from outside. This line separates them.
    if (process.env.POPPIN_TEST_BUILD === "true") {
      console.info(
        "[poppin-spot] posts for",
        stripQueryParams(url),
        "→",
        rows.length,
        "row(s)",
      )
    }
    return {
      posts: rows.slice(0, MAX_SHOWN).map((p) => ({
        id: p.id,
        text: sanitisePostText(p.content),
        author: p.user?.username || p.user?.display_name || "someone",
        authorId: p.user_id,
        createdAt: p.created_at,
        upvotes: p.upvotes ?? 0,
        upvoted: Boolean(p.isUpvoted),
        replyCount: p.comment_count ?? p.reply_count ?? 0,
        // A row below the quality bar can only reach you if it is YOURS —
        // the API hides everyone else's. So its presence here is enough to
        // know the post is visible to nobody but its author, and the card
        // says so instead of letting the writer believe it landed.
        hiddenFromOthers: typeof p.score === "number" && p.score < 1,
        avatarUrl: p.user?.profile_photo_url ?? null,
        isTrade: Boolean(p.on_chain),
        // The trade's OWN market cap, read back out of the ledger by the
        // API. Absent for every receipt whose signature predates the
        // spot_trades row, and the sentence stops early rather than
        // pricing a months-old trade at today's size.
        mcapUsd: p.post_transaction?.mcap_usd ?? null,
        // The receipt outranks the sentence: trade_type is what the server
        // stored, the regex is what we can recover from words when it
        // stored nothing (rows older than 2026-08-19).
        side:
          p.post_transaction?.trade_type ??
          (p.on_chain
            ? /^bought\b/i.test(p.content ?? "")
              ? ("buy" as const)
              : /^sold\b/i.test(p.content ?? "")
                ? ("sell" as const)
                : null
            : null),
        trade: p.post_transaction?.token_mint
          ? {
              mint: p.post_transaction.token_mint,
              symbol: p.post_transaction.token_symbol,
              amount: p.post_transaction.token_amount,
            }
          : null,
      })),
      total: rows.length,
      // The server already answers "is there more" — cursor pagination, so
      // there is no total to be had, but `hasNextPage` is the honest half of
      // one and the client used to throw it away. Without it the card
      // presented its FETCH LIMIT as the size of the conversation.
      hasMore: Boolean(
        (res as { meta?: { hasNextPage?: boolean } })?.meta?.hasNextPage,
      ),
    }
  } catch (e) {
    if (process.env.POPPIN_TEST_BUILD === "true") {
      console.info("[poppin-spot] posts FETCH FAILED for", stripQueryParams(url), e)
    }
    return { posts: [], total: 0, hasMore: false }
  }
}

/**
 * A TRADE post: the flywheel's #3 behaviour. Carries the on-chain signature in
 * transaction_data so the server (and anyone) can verify the trade is real,
 * owned by the poster, and used once — the post is a receipt, not a claim.
 * Returns the created post's id so the X-share step can chain onto it.
 */
export async function createTradePost(
  url: string,
  content: string,
  tx: {
    tokenSymbol: string
    tokenMint: string
    tokenAmount: number
    signature: string
    /** The DB defaults absence to 'buy'; a sell must say so. */
    tradeType: "buy" | "sell"
  },
): Promise<string | null> {
  try {
    const post = await WebsitePostService.create({
      content: content.trim(),
      website_url: stripQueryParams(url),
      only_followers: false,
      on_chain: true,
      transaction_data: tx,
    })
    const id = (post as { id?: string })?.id ?? null
    if (process.env.POPPIN_TEST_BUILD === "true") {
      console.info("[poppin-spot] trade post created →", id ?? "NO ID IN RESPONSE", post)
    }
    return id
  } catch (e) {
    if (process.env.POPPIN_TEST_BUILD === "true") {
      console.info("[poppin-spot] trade post FAILED", e)
    }
    return null
  }
}

/**
 * Flywheel #5: mint an attributed link for a post and open X's composer with
 * it. The tweet text is OURS (product name + link); the reward rides the
 * clicks that come back through the link, not this button press — though the
 * press itself records a small, capped share event server-side.
 */
export async function shareOnX(postId: string, text: string): Promise<boolean> {
  try {
    const r = await sendApiRequest<{ url: string }>({
      url: "/flywheel/share",
      method: "POST",
      data: { post_id: postId },
    })
    if (!r?.url) return false
    const intent =
      "https://twitter.com/intent/tweet?text=" +
      encodeURIComponent(`${text}\n${r.url}`)
    window.open(intent, "_blank", "noopener")
    return true
  } catch {
    return false
  }
}

/** Post to this page's conversation. Authenticated upstream; a signed-out
 *  reader's request fails and the composer reports it without ceremony. */
/**
 * Post to the page's conversation.
 *
 * Returns WHY it failed, not just that it did. The card used to print
 * "Could not post — sign in and try again" for every failure, which asserts a
 * cause nobody checked: a 500, a dropped connection and a genuinely expired
 * session all told the reader to sign in, and a signed-in reader who follows
 * that advice finds nothing wrong and no way forward.
 */
export type PostOutcome =
  | { kind: "ok" }
  | { kind: "signed_out" }
  /**
   * Something the SERVER said. The backend already sends a human sentence
   * ("Post content must be at least 3 characters long") and the background
   * already forwards it — the card was the only place that threw it away, and
   * then guessed a cause instead. A reader who can read the real reason can
   * act on it; "try again" on a validation error is advice that cannot work.
   */
  | { kind: "failed"; message?: string }

export async function createPagePost(
  url: string,
  content: string,
): Promise<PostOutcome> {
  try {
    await WebsitePostService.create({
      content: content.trim(),
      website_url: stripQueryParams(url),
      only_followers: false,
      on_chain: false,
    })
    if (process.env.POPPIN_TEST_BUILD === "true") {
      console.info("[poppin-spot] page post OK →", stripQueryParams(url))
    }
    return { kind: "ok" }
  } catch (e) {
    if (process.env.POPPIN_TEST_BUILD === "true") {
      console.info("[poppin-spot] page post FAILED", e)
    }
    return outcomeFromError(e)
  }
}

/** One reading of a failed write, shared by posts and replies. */
function outcomeFromError(e: unknown): PostOutcome {
  const err = e as { status?: number; message?: string }
  if (err?.status === 401 || err?.status === 403) return { kind: "signed_out" }
  // Only surface a server sentence, never a transport one: "Network Error"
  // and "Unknown error" say nothing a reader can use.
  const msg =
    err?.message && !/network error|unknown error|timeout/i.test(err.message)
      ? err.message
      : undefined
  return { kind: "failed", ...(msg ? { message: msg } : {}) }
}

/**
 * Replies to one post — the existing comment system, not a new one.
 * CommentService.get is the same call the side panel's thread view makes.
 */
export async function fetchReplies(postId: string): Promise<CardReply[]> {
  try {
    const res = await CommentService.get({ post_id: postId, limit: 20 })
    const rows = Array.isArray((res as { data?: unknown })?.data)
      ? ((res as { data: unknown[] }).data as Array<Record<string, unknown>>)
      : []
    return rows.map((c) => ({
      id: String(c.id),
      text: sanitisePostText(String(c.content ?? "")),
      author:
        (c.user as { username?: string; display_name?: string })?.username ||
        (c.user as { display_name?: string })?.display_name ||
        "someone",
      avatarUrl:
        (c.user as { profile_photo_url?: string })?.profile_photo_url ?? null,
      createdAt: String(c.created_at ?? ""),
    }))
  } catch {
    return []
  }
}

/** Reply to a post. Same silent-failure contract as createPagePost. */
export async function createReply(
  postId: string,
  content: string,
): Promise<PostOutcome> {
  try {
    await CommentService.create({ content: content.trim(), post_id: postId })
    return { kind: "ok" }
  } catch (e) {
    return outcomeFromError(e)
  }
}


/**
 * Upvote, or take one back.
 *
 * The endpoint wants to be told what the reader's current state is
 * (`isAlreadyVoted`) rather than deriving it, so the card passes what it is
 * showing. If the two ever disagree the server wins and the next fetch
 * corrects the card — which is why the caller re-reads rather than trusting
 * its own optimistic flip.
 */
export async function togglePostVote(post: CardPost): Promise<boolean> {
  try {
    await WebsitePostService.vote({
      id: post.id,
      vote: post.upvoted ? "unupvote" : "upvote",
      isAlreadyVoted: post.upvoted,
      authorId: post.authorId,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Hand the reader off to the side panel.
 *
 * `initialRoute` is the panel's own deep-link mechanism: Layout reads it from
 * chrome.storage.local on mount AND watches it while open, so this works both
 * for a cold panel and one already sitting on some other screen. Setting it
 * BEFORE the toggle message closes the race.
 */
async function openPanelAt(
  route: string,
  url?: string,
  mint?: string,
): Promise<void> {
  try {
    await chrome.storage.local.set({ initialRoute: route })
    void chrome.runtime.sendMessage({
      action: "TOGGLE_SIDE_PANEL",
      payload: url ? { url, ...(mint ? { mint } : {}) } : {},
    })
  } catch {
    // The panel is a nicety here; failing to open it breaks nothing on the card.
  }
}

/**
 * "OPEN FULL PROFILE" — the card's own words, so the profile is where it
 * lands. It used to call openPanelAt("/", url): correct when "/" WAS the
 * page feed and the url selected which page's feed to show, and quietly
 * wrong ever since the restructure made "/" the positions screen. The url
 * it still carried was vestigial — only a feed reads it — so a button
 * labelled one thing opened another and passed an argument nobody used.
 */
export function openInPanel(): void {
  void openPanelAt("/profile")
}

/**
 * The balance chip's door: the panel on the reader's OWN portfolio — no
 * asset, no tweet. Root is the positions view, which is what a balance is.
 */
export function openMyPanel(): void {
  void openPanelAt("/")
}

/**
 * THE FEED ITSELF, and nothing narrower.
 *
 * The chip's Feed button used to call openAssetInPanel, which carries a
 * tweet url and a mint — so a control labelled "Feed" opened the panel
 * SCOPED to the asset the reader happened to be standing on, and, because
 * a url in the payload rewrites the panel's own path, an already-open
 * panel was torn down and rebuilt to get there. A button that says Feed
 * means the room where everybody's trades are, so it asks for the route
 * and nothing else: no url, no mint, no path rewrite, which also means an
 * open panel simply NAVIGATES (Layout listens for the route) instead of
 * reloading out from under whatever the reader was doing.
 */
export function openFeedInPanel(): void {
  void openPanelAt("/feed")
}

/**
 * A ROOM IN THE PANEL, BY ROUTE — the scoreboard's news rows' door.
 *
 * The chip's Activity and Holdings rows deep-link into the app (a fill
 * opens its token's room, "nic followed you" opens nic). The chip composes
 * routes from server data, but a route is still a string crossing a
 * boundary, so only the rooms these rows can honestly mean are allowed
 * through; anything else is dropped rather than navigated.
 */
export function openPanelRoom(route: string): void {
  if (!/^\/(?:token\/[1-9A-HJ-NP-Za-km-z]{32,44}|profile\/[\w-]+|feed)$/.test(route)) return
  void openPanelAt(route)
}

/**
 * The page's conversation, in the panel's feed room — the card's "Open in
 * Poppin →" door. The url scopes the feed to the page the reader is on, so
 * the same thread continues where it has room.
 */
export function openFeedForPage(url: string): void {
  void openPanelAt("/feed", url)
}

/** A post's author, in the panel's profile view. */
export function openProfile(userId: string): void {
  void openPanelAt(`/profile/${userId}`)
}

/** The reader's inbox, in the panel. */
export function openNotifications(): void {
  void openPanelAt("/notifications")
}

/**
 * The ladder's sign-in door: the WELCOME TAB at ?flow=signin — the full-page
 * consumer flow (email → OTP → profile), not the panel's cramped variant.
 * First V2 shipped this as a panel deep-link; the panel kicks unauthenticated
 * users back to the welcome tab, which showed the install screen — the reader
 * asked to sign in and was told "you're set". Full page, straight to it.
 */
export function openSignIn(): void {
  try {
    window.open(
      chrome.runtime.getURL("src/entries/welcome/index.html?flow=signin"),
      "_blank",
      "noopener",
    )
  } catch {
    // Extension context gone (orphaned content script) — nothing to do.
  }
}
export function openTopUp(): void {
  void openPanelAt("/receive")
}

/**
 * TOP UP FROM THE WALLET ALREADY ON THIS PAGE.
 *
 * The question this answers: somebody is reading a tweet, taps Buy, and has
 * no balance. Today that sends them to the panel, then to a funding page,
 * then back to find the tweet again — and most of them do not come back.
 * When the page has an injected wallet, this moves the money in place: one
 * approval, a plain USDC transfer the wallet can show clearly, and the buy
 * they were already making becomes possible.
 *
 * WHAT IT IS NOT. It never signs a trade. The transaction comes from our
 * backend and can only be a transfer into the reader's own custodial
 * account, so the wallet popup shows a transfer and the trade continues on
 * the one path every surface agrees on — the panel could not sign anything
 * even if we wanted it to, and a product whose Buy button means two
 * different things is two products.
 *
 * Falls back to the panel whenever the page cannot do it, so the door is
 * never worse than it was.
 */
/**
 * WHICH ROAD A TOP-UP ACTUALLY TOOK.
 *
 * The boolean this returns folds four different endings into one `false`:
 * no wallet on the page, a wallet the reader refused, a transaction our
 * own backend would not build, and a signature that never came back. Only
 * the first one says anything about whether the fast path EXISTS for this
 * reader, and that is the number the funding roadmap turns on: the panel's
 * address screen is a dead end for exactly the people who report
 * `no-wallet`, and nobody else.
 *
 * Reported, not returned, so every existing caller keeps its contract.
 */
export type TopUpRoute =
  | "no-wallet"
  | "declined"
  | "unbuildable"
  | "signed"
  | "unsigned"

export async function topUpFromPage(
  needUsd?: number,
  report?: (route: TopUpRoute) => void,
): Promise<boolean> {
  const say = (r: TopUpRoute) => {
    try {
      report?.(r)
    } catch {
      // Telemetry must never be the reason a top-up fails.
    }
  }
  const { hasPageWallet, connectPageWallet, signWithPageWallet } = await import(
    "~/helpers/pageWalletBridge"
  )
  if (!(await hasPageWallet())) {
    say("no-wallet")
    openTopUp()
    return false
  }
  const sender = await connectPageWallet()
  if (!sender) {
    say("declined")
    return false
  }

  // Round UP to a whole dollar, with a floor: asking a wallet to move
  // $4.37 to cover a $4.37 buy leaves the reader short the moment a price
  // ticks, and a top-up that does not cover the thing it was for is worse
  // than none.
  const amountUsd = Math.max(5, Math.ceil((needUsd ?? 10) + 1))
  try {
    const built = await sendApiRequest<{ tx?: string }>({
      url: "/fund/wallet-deposit-tx",
      method: "POST",
      data: { senderAddress: sender, amountUsd },
    })
    if (!built?.tx) {
      say("unbuildable")
      openTopUp()
      return false
    }
    const sig = await signWithPageWallet(built.tx)
    say(sig ? "signed" : "unsigned")
    /**
     * A FAILED SIGN MUST STILL OPEN A DOOR.
     *
     * signWithPageWallet answers null when the page wallet cannot sign —
     * and the commonest reason is exactly the wallet this whole USDC pass
     * is about: a Phantom holding SOL and no USDC, which cannot build the
     * USDC transfer. Every other failure route here (unbuildable, and the
     * catch below) falls through to openTopUp(); this one returned false
     * and did nothing at all, so the caller's `if (!funded) return` left
     * the reader pressing a money button that produced no screen, no
     * error, and no next step.
     *
     * A user who DECLINED the popup made a decision, and we do not argue
     * with it — but signWithPageWallet cannot tell decline from failure,
     * so the funding screen is the honest fallback for both: it is where
     * they were going anyway.
     */
    if (!sig) openTopUp()
    return Boolean(sig)
  } catch {
    // A refusal from our own backend is not something to explain inside a
    // 32px chip; the panel's funding screen says everything it can.
    say("unbuildable")
    openTopUp()
    return false
  }
}

/**
 * The X chip's door to the app: the panel, on this asset, at this tweet.
 *
 * The mint rides along because the panel cannot derive it here. Its asset
 * strip asks the active page what it is about, and x.com/home is about
 * nothing in particular — measured, it matches no asset at all. The chip
 * already resolved this on device before the reader tapped, so it hands the
 * answer over instead of asking a question it holds the answer to.
 *
 * The tweet's own permalink is the URL, not the feed's: a tweet is a page in
 * the only sense Poppin cares about, which is that a conversation can hang
 * off it.
 *
 * THE TOKEN'S OWN ROOM, not the feed.
 *
 * This routed to "/feed" for a real reason: an earlier restructure had made
 * "/" the positions screen, and a field report ("sidebar'ı açtığımda
 * positions'a atıyor") was answered by sending the door somewhere with the
 * asset strip on it. That fixed the wrong screen, not the right one.
 *
 * The complaint now is the one underneath: pressing this arrow costs a
 * reader their place in the timeline, and what they got back was a feed —
 * a second social surface, when the thing they pressed was a price. A door
 * has to pay for the trip. /token/:mint is the room that can: the position
 * they hold, what they paid, every fill they have made on this asset,
 * their standing orders and alerts on it, a chart that scrubs, and the
 * trade sheet. All of it about the one token they tapped.
 *
 * The tweet URL still rides along, so the conversation the price came from
 * is one step away rather than the destination.
 */
export function openAssetInPanel(mint: string, tweetUrl: string): void {
  void openPanelAt(`/token/${mint}`, tweetUrl, mint)
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

/**
 * The reader's SPENDING power and, implicitly, their auth state — the two
 * facts the card's onboarding ladder stands on.
 *
 *   { signedIn: false }              the balance endpoint answered 401
 *   { signedIn: true, usd: 0 }      wallet exists (created at signup,
 *                                    server-side) but holds nothing
 *   { signedIn: true, usd: n }      ready to trade
 *   null                             could not tell (network, 5xx) — the
 *                                    ladder stands aside and the card
 *                                    behaves exactly as before
 */
/**
 * The reader's own name and face, for the card's identity row. Signed-out
 * (401) and every failure are the same null — the card renders nothing and
 * the gate ladder already handles the sign-in invitation.
 */
export async function fetchMe(): Promise<{
  name: string
  photoUrl: string | null
  /** Needed to ask for this reader's OWN posts in the `me` view. Never shown. */
  id: string | null
} | null> {
  try {
    const u = (await UserService.getCurrentUser()) as {
      id?: string
      username?: string
      display_name?: string
      profile_photo_url?: string | null
    }
    const name = u?.username || u?.display_name
    if (!name) return null
    // The id rides along for the `me` view, which needs it to ask for this
    // reader's own posts. It is not rendered anywhere.
    return { name, photoUrl: u?.profile_photo_url ?? null, id: u?.id ?? null }
  } catch {
    return null
  }
}

export async function fetchSpendingPower(): Promise<
  { signedIn: boolean; usd: number } | null
> {
  const ask = async () => {
    const b = await balanceAssetRaw(USDC_MINT)
    return { signedIn: true, usd: b.uiAmount }
  }
  try {
    return await ask()
  } catch (e) {
    const status = (e as { status?: number })?.status
    if (status !== 401 && status !== 403) return null
    // A 401 is the auth answer — but not necessarily the FINAL one. This
    // probe fires 1.5s after page load, which is exactly when a sleeping
    // service worker is still rehydrating its Firebase session; the request
    // that loses that race comes back 401 and used to brand a signed-in
    // reader "signed out" for the life of the page. axios now waits for auth
    // to settle, and this second ask is the belt to that braces: if the
    // session was merely late, the retry finds it. Two 401s a second apart
    // really are signed out.
    await new Promise((r) => setTimeout(r, 1200))
    try {
      return await ask()
    } catch (e2) {
      const s2 = (e2 as { status?: number })?.status
      if (s2 === 401 || s2 === 403) return { signedIn: false, usd: 0 }
      return null
    }
  }
}

/**
 * The reader's whole book, for the card's `me` view.
 *
 * Deliberately WITHOUT fetchSpendingPower's retry-after-401 dance. That one
 * fires unprompted 1.5s into every page load, so it races a service worker
 * still rehydrating its session and has to be forgiving. This one is called
 * by a press: by then auth has long since settled, and a second wallet scan
 * on a 401 would just be a slow way to reach the same answer. Any failure is
 * null, and the view says "could not read" rather than drawing an empty book.
 */
/** One asset by mint, for opening a card from a holding. null on any failure. */
export async function fetchAssetByMint(mint: string) {
  try {
    return (await assetByMintRaw(mint)).asset
  } catch {
    return null
  }
}

export async function fetchBook() {
  try {
    return await positionsAssetRaw()
  } catch {
    return null
  }
}

/**
 * Unread notifications for the signed-in reader. The endpoint answers an
 * array of {count} rows; summed defensively rather than trusting one shape.
 * Signed-out (or any failure) is null, and null renders nothing.
 */
export async function fetchUnreadCount(): Promise<number | null> {
  try {
    const rows = await UserService.getNotificationsCount()
    if (!Array.isArray(rows)) return null
    return rows.reduce((sum, r) => sum + (r?.count ?? 0), 0)
  } catch {
    return null
  }
}

/**
 * How many Poppin users are on this page right now.
 *
 * "N online" for this hostname. The count is /ticks page-room size — browsers
 * with a live card here, signed-in or not — public, like everything on that
 * namespace. It replaced chat's Redis-backed count when chat left the product.
 * null means "could not ask", and null renders as nothing, the card's usual
 * rule for what it does not know.
 */
export async function fetchPresence(hostname: string): Promise<number | null> {
  // Delegates to the shared helper so the card and the side panel's header
  // can never disagree about who is here — see helpers/presence.ts.
  return fetchPagePresence(hostname)
}

/** One line in the reader's own activity, already phrased. */
export interface CardActivityRow {
  id: string
  /** "mine" = something you wrote. "event" = something somebody did to you. */
  kind: "mine" | "event"
  /** The actor, for an event. Absent on your own posts, and on the one
   *  notification nobody did to you (an admin deletion). */
  who?: string | null
  avatarUrl?: string | null
  text: string
  createdAt: string
  unread?: boolean
  /** A trade receipt rather than a sentence — same flag the feed rows use. */
  isTrade?: boolean
  /** Which way, for the tag's colour. Same derivation as fetchPagePosts. */
  side?: "buy" | "sell" | null
  /** The page it happened on, for the site mark. Absent on rows with no page. */
  url?: string | null
  /** The deed's design kind, for the glyph disc an event row leads with —
   *  the same closed vocabulary the strip's Activity band and the side
   *  panel speak. null on your own posts and on authorless rows. */
  noteKind?: NotificationKind | null
}

/**
 * Everything that happened involving this reader: what they said, and what
 * others did about it, in one time-ordered list.
 *
 * ── WHY ONE LIST AND NOT TWO TABS ───────────────────────────────────────────
 * They are the same subject seen from two angles — a notification is an event
 * ON one of these posts — and the card is 370px wide. A third segment would
 * have cost more than it explained. Your own posts stay visible even with no
 * activity on them, which a notifications-only list could not do, and which is
 * the specific thing the owner asked for.
 *
 * ── EITHER HALF FAILING FAILS THE WHOLE READ ────────────────────────────────
 * Deliberate, and the same rule the portfolio total follows. If the posts call
 * fails and the notifications call does not, a list of events renders under a
 * tab the reader opened to find their posts, and the honest conclusion from
 * looking at it is "I have not posted" — which is false. Silence about a
 * failure is only safe when nothing false can be read out of what remains.
 */
export async function fetchActivity(
  userId: string,
): Promise<CardActivityRow[] | null> {
  // allSettled, not all: the rule is still "either half failing fails the
  // whole read", but a rejected Promise.all discards WHICH half broke, and
  // that is the one fact worth knowing when this goes wrong. Same reason the
  // post fetch above logs empty separately from failed.
  const [minePromise, eventsPromise] = await Promise.allSettled([
    WebsitePostService.get({ user_id: userId, limit: MAX_SHOWN }),
    UserService.getNotifications(MAX_SHOWN),
  ])
  if (process.env.POPPIN_TEST_BUILD === "true") {
    console.info(
      "[poppin-spot] activity → my posts:",
      minePromise.status,
      minePromise.status === "rejected" ? minePromise.reason : "",
      "| notifications:",
      eventsPromise.status,
      eventsPromise.status === "rejected" ? eventsPromise.reason : "",
    )
  }
  if (minePromise.status === "rejected" || eventsPromise.status === "rejected") {
    return null
  }
  try {
    const mine = minePromise.value
    const events = eventsPromise.value
    const mineRows: CardActivityRow[] = (Array.isArray(mine?.data) ? mine.data : [])
      .map((p) => ({
        id: `p-${p.id}`,
        kind: "mine" as const,
        /**
         * The Activity band was the one surface still printing the raw
         * stored sentence, so your own trade read "Bought 1,074,603.6105
         * $PANTS ($953.00) on x.com via Poppin" here and "PANTS $953 at
         * $60.9M market cap" everywhere else. Same re-saying, same ledger
         * market cap, so the product speaks with one voice about the same
         * trade.
         */
        text: sanitisePostText(
          receiptText(
            p.content,
            Boolean(p.on_chain),
            p.post_transaction?.mcap_usd,
          ),
        ),
        createdAt: p.created_at,
        avatarUrl: p.user?.profile_photo_url ?? null,
        url: p.website_url ?? null,
        isTrade: Boolean(p.on_chain),
        side: p.on_chain
          ? /^bought\b/i.test(p.content ?? "")
            ? ("buy" as const)
            : /^sold\b/i.test(p.content ?? "")
              ? ("sell" as const)
              : null
          : null,
      }))
    const eventRows: CardActivityRow[] = (
      Array.isArray(events?.data) ? events.data : []
    ).map((n) => ({
      id: `n-${n.id}`,
      kind: "event" as const,
      who: isAuthorlessNotification(n.type)
        ? null
        : n.action_taken_by?.username || n.action_taken_by?.display_name || "someone",
      avatarUrl: n.action_taken_by?.profile_photo_url ?? null,
      text: isAuthorlessNotification(n.type)
        ? AUTHORLESS_NOTIFICATION_TEXT
        : notificationVerb(n.type, n.post_type),
      createdAt: n.created_at,
      unread: n.read_at === null,
      url: n.website_url ?? null,
      noteKind: isAuthorlessNotification(n.type) ? null : notificationKind(n.type),
    }))
    return [...mineRows, ...eventRows]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, MAX_SHOWN)
  } catch {
    return null
  }
}
