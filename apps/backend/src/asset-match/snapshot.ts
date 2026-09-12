/**
 * Save a real page as the SIGNALS the card would have sent, so the corpus can
 * contain pages the corpus cannot fetch.
 *
 *   npx ts-node -T apps/backend/src/asset-match/snapshot.ts <url> [<url> …]
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * calibrate.ts fetches live URLs, and that worked while the corpus was 42/47
 * Wikipedia. It stopped working the moment the corpus needed to look like real
 * traffic: coingecko.com answers 403 to a plain client and coindesk.com 429,
 * so the very sites the scorer exists for are the ones a live-fetch corpus can
 * never contain. A corpus that silently omits its hardest cases is worse than
 * a small one, because it reports high precision on the pages nobody visits.
 *
 * ── WHAT IS SAVED, AND WHY THAT EXACT SHAPE ─────────────────────────────────
 * Not the HTML. The card does not send HTML — it sends `PageSignals`: url,
 * pathname, title, h1, metaDescription and a capped bodyExcerpt taken from
 * innerText (see harvest() in the extension's attachSpotCard). Saving the
 * signals rather than the page means the fixture cannot drift from what the
 * matcher is actually given, and it keeps the files small enough to read in a
 * diff when a score moves.
 *
 * ── TWO HONEST LIMITS ───────────────────────────────────────────────────────
 * 1. A BROWSER USER-AGENT IS NOT A BROWSER. Measured on 2026-08-19: with the
 *    Chrome UA below, theverge.com returns 200 while coingecko.com still
 *    returns 403 and coindesk.com 429. Those sites run real bot protection
 *    (JS challenges, TLS fingerprinting), which no header set defeats. So
 *    this closes the OPEN half of the corpus gap and not the hard half —
 *    which, awkwardly, is the half containing the venues the product cares
 *    most about. For those, capture from a real browser session instead:
 *    run captureSignals() in the page's console and save the result here.
 *    That is not a workaround, it is the correct source — it is literally
 *    the code the extension's harvest() runs.
 *
 * 2. THIS IS NOT innerText. The tag-strip below keeps text a browser would
 *    hide (display:none) and loses the line breaks innerText inserts at
 *    block boundaries. For a keyword scorer that is mostly noise, but it is
 *    a difference, and a snapshot that disagrees with the real page is a
 *    fixture that lies. Prefer a browser capture whenever a page's score is
 *    about to decide something.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname, '__snapshots__');

/** Matches the extension's cap. More text past this buys the scorer nothing. */
const BODY_CAP = 20_000;

const pick = (html: string, re: RegExp): string =>
  (re.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();

/** Crude innerText: drop the parts of a document that are never read aloud. */
function textOf(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A filename that says which page it is without needing to be opened. */
const slugFor = (u: URL): string =>
  `${u.hostname}${u.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

export interface Snapshot {
  url: string;
  pathname: string;
  title: string;
  h1: string;
  metaDescription: string;
  bodyExcerpt: string;
  /** When it was taken. A stale snapshot of a page that has since changed is
   *  a fixture asserting history, and the date is how anyone notices. */
  capturedAt: string;
}

export async function snapshot(rawUrl: string): Promise<Snapshot> {
  const u = new URL(rawUrl);
  // A plain client is what gets 403'd. This is the same request a reader's
  // browser makes, which is the request the card's signals come from anyway.
  const res = await fetch(rawUrl, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const html = await res.text();

  return {
    url: rawUrl,
    pathname: u.pathname,
    title: pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    h1: textOf(pick(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)).slice(0, 300),
    metaDescription: pick(
      html,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    ).slice(0, 500),
    bodyExcerpt: textOf(html).slice(0, BODY_CAP),
    capturedAt: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Paste this into the console of a page a bot-protected site will not serve
 * us, then save what it prints into __snapshots__/.
 *
 * It is a copy of the extension's harvest() on purpose: the fixture has to be
 * the signals the matcher will actually receive, not an approximation of
 * them. If harvest() ever changes, this string changes with it — which is
 * why it lives next to the loader that consumes its output rather than in a
 * README nobody edits.
 */
export const BROWSER_CAPTURE_SNIPPET = `
JSON.stringify({
  url: location.href,
  pathname: location.pathname,
  title: document.title,
  h1: document.querySelector('h1')?.innerText?.slice(0, 300) ?? '',
  metaDescription:
    document.querySelector('meta[name="description"]')?.getAttribute('content')?.slice(0, 500) ?? '',
  bodyExcerpt: (document.body?.innerText ?? '').slice(0, 20000),
  capturedAt: new Date().toISOString().slice(0, 10),
}, null, 2)
`.trim();

async function main(): Promise<void> {
  if (process.argv[2] === '--browser-snippet') {
    console.log(BROWSER_CAPTURE_SNIPPET);
    return;
  }
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('usage: snapshot.ts <url> [<url> …]');
    process.exit(1);
  }
  mkdirSync(DIR, { recursive: true });
  for (const url of urls) {
    try {
      const snap = await snapshot(url);
      const file = join(DIR, `${slugFor(new URL(url))}.json`);
      writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
      console.log(
        `saved ${file.split('/').pop()}  (${snap.bodyExcerpt.length} chars)  "${snap.title.slice(0, 60)}"`,
      );
    } catch (e) {
      // Loud, and it keeps going: one blocked page should not cost the rest.
      console.error(`FAILED ${url} — ${(e as Error).message}`);
    }
  }
}

if (require.main === module) void main();
