import type { SiteAdapter } from "./siteAdapter"

/**
 * REDDIT.
 *
 * Written against Reddit's current shape and NOT yet confirmed against a
 * live page: reddit.com refuses both the automated browser and a plain
 * fetch from here, so the four strings below are the part a console probe
 * has to check. Everything around them is the same engine that runs on X.
 *
 * Three things about Reddit differ from X in kind, not in selector:
 *
 *  · THE TITLE IS THE POST. On X the text is the whole of it; on Reddit
 *    most posts are a headline with no body at all, and the headline is an
 *    attribute rather than a node. "NVDA earnings tomorrow" is a title far
 *    more often than it is a sentence.
 *
 *  · THE PERMALINK DOES NOT NAME THE AUTHOR. /r/stocks/comments/<id>/<slug>
 *    names the subreddit and the post and nobody else, so the author comes
 *    off the element, where Reddit already puts it.
 *
 *  · NOTHING IS LINKIFIED. Reddit does not turn $NVDA into an anchor the
 *    way X does, so every cashtag here arrives through the scan of the
 *    words that extractTweet gained for exactly this reason.
 */
export const REDDIT_SITE: SiteAdapter = {
  id: "reddit",

  matches: (hostname) => /(^|\.)reddit\.com$/.test(hostname),

  /**
   * THE POST IS ITS OWN CELL.
   *
   * The first version of this used <article> as the wrapper, on the
   * reasoning that a feed recycles a wrapper the way X's does. Measured on
   * a live post page: zero articles, one shreddit-post. Reddit appends
   * rather than virtualizing, so there is nothing to recycle and nothing
   * to wrap — the element IS the unit, on the feed and on a post page
   * alike, which is also why one selector covers both.
   */
  cell: "shreddit-post",
  post: "shreddit-post",

  /**
   * The body of a self post. Link posts have none, and that is not a
   * failure: the title still carries the claim.
   */
  textNodes: (post) => [...post.querySelectorAll('[slot="text-body"]')],

  title: (post) => post.getAttribute("post-title") ?? "",

  permalink(post) {
    const path = post.getAttribute("permalink")
    const raw = post.getAttribute("id") ?? ""
    if (!path) return null
    // t3_abc123 is Reddit's own name for the post; the bare id is enough.
    const id = raw.replace(/^t3_/, "") || path
    return { id, url: path.startsWith("http") ? path : `https://www.reddit.com${path}` }
  },

  authorOf: (_url, post) => post.getAttribute("author"),

  /**
   * The vote, comment and share cluster. Reddit keeps it in a named slot,
   * so the chip lands under the post's own controls the way it does on X.
   */
  actionRow: (post) =>
    post.querySelector('[slot="credit-bar"]') ??
    post.querySelector("shreddit-post-overflow-menu")?.parentElement ??
    null,
}
