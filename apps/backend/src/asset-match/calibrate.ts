/**
 * Where do true and false matches actually separate?
 *
 *   npx ts-node -T apps/backend/src/asset-match/calibrate.ts
 *
 * Fetches a labelled corpus of REAL pages, scores each against the catalog with
 * the live scoring code, and prints every candidate's score next to what the
 * page is actually about. The thresholds in asset-match.util.ts are read off
 * this report; nothing here is a unit test and nothing is mocked, because the
 * failure being tuned against — a related-links rail mentioning SpaceX once —
 * does not exist in text anyone would write by hand as a fixture.
 *
 * Labels:
 *   'SPCX' | 'SPYx' | 'CRCLx' | 'NVDAx' | 'MU'   the page IS about this
 *   null                                          no card belongs here
 *
 * Re-run after any catalog change. A term added to one row moves the scores of
 * every page that mentions it.
 */
import { scorePage } from './asset-match.util';

interface Case {
  url: string;
  expect: string | null;
  why: string;
}

const CORPUS: Case[] = [
  // ── pages that ARE about a catalog asset ─────────────────────────────────
  { url: 'https://en.wikipedia.org/wiki/SpaceX', expect: 'SPCX', why: 'the company itself' },
  { url: 'https://en.wikipedia.org/wiki/Nvidia', expect: 'NVDAx', why: 'the company itself' },
  { url: 'https://en.wikipedia.org/wiki/Micron_Technology', expect: 'MU', why: 'the company itself' },
  { url: 'https://en.wikipedia.org/wiki/S%26P_500', expect: 'SPYx', why: 'the index itself' },
  { url: 'https://en.wikipedia.org/wiki/Circle_(company)', expect: 'CRCLx', why: 'the company itself' },
  { url: 'https://en.wikipedia.org/wiki/Starship_(spacecraft)', expect: 'SPCX', why: 'named product, direct term' },
  { url: 'https://en.wikipedia.org/wiki/Starlink', expect: 'SPCX', why: 'named product, direct term' },

  // ── pages that mention an asset but are NOT about it ─────────────────────
  { url: 'https://en.wikipedia.org/wiki/Elon_Musk', expect: null, why: 'thematic-heavy, about a person not the asset' },
  // Relabelled 2026-08-14: TSLAx entered the catalog and this page IS the
  // company. The old null label described what the catalog could see, not
  // what the page is about.
  { url: 'https://en.wikipedia.org/wiki/Tesla,_Inc.', expect: 'TSLAx', why: 'the company itself (expansion 2026-08-14)' },
  { url: 'https://en.wikipedia.org/wiki/Graphics_processing_unit', expect: null, why: 'mentions NVIDIA throughout but is about the category' },
  { url: 'https://en.wikipedia.org/wiki/Stablecoin', expect: null, why: 'mentions Circle/USDC, about the instrument' },
  { url: 'https://en.wikipedia.org/wiki/Dynamic_random-access_memory', expect: null, why: 'mentions Micron, about the technology' },

  // ── 2026-08-14 expansion: the new rows' own pages ────────────────────────
  { url: 'https://en.wikipedia.org/wiki/Bitcoin', expect: 'WBTC', why: 'the asset itself' },
  { url: 'https://en.wikipedia.org/wiki/Ethereum', expect: 'ETH', why: 'the asset itself' },
  { url: 'https://en.wikipedia.org/wiki/Solana_(blockchain_platform)', expect: 'SOL', why: 'the chain itself' },
  { url: 'https://en.wikipedia.org/wiki/Apple_Inc.', expect: 'AAPLx', why: 'the company itself — reachable via "Apple Inc"/AAPL/iPhone, never bare Apple' },
  { url: 'https://en.wikipedia.org/wiki/Nasdaq-100', expect: 'QQQx', why: 'the index itself' },
  { url: 'https://en.wikipedia.org/wiki/GameStop', expect: 'GMEx', why: 'the company itself' },

  // ── 2026-08-14 expansion: the traps the terms were written to dodge ──────
  { url: 'https://en.wikipedia.org/wiki/Amazon_rainforest', expect: null, why: 'bare "Amazon" is deliberately not a term' },
  { url: 'https://en.wikipedia.org/wiki/Apple', expect: null, why: 'the fruit — bare "Apple" is deliberately not a term' },
  { url: 'https://en.wikipedia.org/wiki/Jupiter', expect: null, why: 'the planet — bare "Jupiter" is deliberately not a term' },
  { url: 'https://en.wikipedia.org/wiki/Gold', expect: null, why: 'the metal as chemistry/history — GLDx needs price-context terms' },
  { url: 'https://en.wikipedia.org/wiki/Donald_Trump', expect: null, why: 'politics — TRUMP coin is reachable only by coin-specific phrases' },
  { url: 'https://en.wikipedia.org/wiki/Helium', expect: null, why: 'the element — HNT needs "Helium Network"' },
  { url: 'https://en.wikipedia.org/wiki/Meta-analysis', expect: null, why: 'bare "Meta" is deliberately not a term' },

  // ── 2026-08-14 expansion 2: PreStocks positives + the new traps ──────────
  { url: 'https://en.wikipedia.org/wiki/Anthropic', expect: 'ANTHROPIC', why: 'the company itself (PreStocks)' },
  { url: 'https://en.wikipedia.org/wiki/OpenAI', expect: 'OPENAI', why: 'the company itself (PreStocks)' },
  { url: 'https://en.wikipedia.org/wiki/Polymarket', expect: 'POLYMARKET', why: 'the company itself (PreStocks)' },
  { url: 'https://en.wikipedia.org/wiki/Orca', expect: null, why: 'the whale — bare "Orca" is deliberately not a term' },
  { url: 'https://en.wikipedia.org/wiki/Silver', expect: null, why: 'the metal as chemistry — SLVon needs price-context terms' },
  { url: 'https://en.wikipedia.org/wiki/Vine_(service)', expect: null, why: 'the dead app — VINE coin needs coin-specific phrases' },
  { url: 'https://en.wikipedia.org/wiki/NEET', expect: null, why: 'the policy acronym — neet coin needs coin-specific phrases' },
  // ── 2026-08-14 expansion 3 traps ─────────────────────────────────────────
  { url: 'https://en.wikipedia.org/wiki/Tron_(franchise)', expect: null, why: 'the film — TRX needs chain-context terms' },
  { url: 'https://en.wikipedia.org/wiki/Meteora', expect: null, why: 'the monasteries — thematic cannot carry MET without a direct hit' },
  { url: 'https://en.wikipedia.org/wiki/Pythia', expect: null, why: 'the oracle of Delphi — PYTHIA coin needs coin-specific phrases' },

  // ── 2026-08-19: the product-vs-company axis, on real prose ───────────────
  // These three are the class that produced a trading card on a gadget
  // review. iPhone/YouTube/ChatGPT used to sit in their companies' DIRECT
  // term lists, so any of those words in a title cleared the floor alone;
  // they are thematic now. Wikipedia's own articles are the honest test of
  // that — long, dense, and genuinely about the product rather than the
  // company that ships it. product-vs-company.spec.ts pins the same shape
  // synthetically for CI; these exist so the CORPUS knows about it too.
  { url: 'https://en.wikipedia.org/wiki/IPhone', expect: null, why: 'the product — an iPhone page is not an Apple Inc page' },
  { url: 'https://en.wikipedia.org/wiki/ChatGPT', expect: null, why: 'the product — a ChatGPT page is not an OpenAI page' },
  { url: 'https://en.wikipedia.org/wiki/YouTube', expect: null, why: 'the platform — a YouTube page is not an Alphabet page' },

  // Exercises the CERTAIN tier rather than the scorer: a venue's dedicated
  // quote page names the asset in its URL, so this must resolve without the
  // prose mattering at all. See venue-match.ts.
  { url: 'https://finance.yahoo.com/quote/NVDA/', expect: 'NVDAx', why: 'venue URL — identity read, not inferred' },

  // ── SHAPE GAP, worth naming ──────────────────────────────────────────────
  // This corpus is still overwhelmingly Wikipedia, and Wikipedia is not what
  // anybody browses: uniform structure, dense prose, encyclopedic register.
  // The pages the scorer now actually owns are news, blogs, forums and video
  // pages — short, chrome-heavy, written to be skimmed. Dedicated venue pages
  // no longer reach the scorer at all (venue-match handles them), so adding
  // more of those tunes nothing.
  //
  // The obstacle is fetching, not labelling: coingecko.com answers 403 and
  // coindesk.com 429 to a plain curl, so a corpus built from them would fail
  // for reasons unrelated to matching. Closing this gap properly needs saved
  // page snapshots rather than live URLs.

  // ── real news articles, which are far shorter than Wikipedia ─────────────
  { url: 'https://www.cnbc.com/2026/08/11/nvidia-ai-funding-jensen-huang-china-risk.html', expect: 'NVDAx', why: 'news article about NVIDIA — the page that produced a SPACEX card' },
  { url: 'https://www.reuters.com/technology/', expect: null, why: 'a section index, mentions many companies' },
  { url: 'https://arstechnica.com/space/', expect: null, why: 'section index, SpaceX-heavy but about nothing in particular' },
  { url: 'https://finance.yahoo.com/quote/NVDA/', expect: 'NVDAx', why: 'a quote page — short, and unambiguously about the company' },
  // Relabelled to null, on the catalog's own rule rather than to make a number
  // work. `Blackwell` is a THEMATIC term for NVDAx, not a direct one, and
  // deliberately so: an article containing only the word "Blackwell" may be
  // about Elizabeth Blackwell. The catalog's test for a direct term is "would
  // this word alone mean the asset", and it does not.
  //
  // So a page titled "Blackwell (microarchitecture)" never names NVIDIA in its
  // headline, and gets no card. Same call as USD Coin above: an article about a
  // product is not an article about its maker. Starship and Starlink DO match
  // SPCX, and the difference is not inconsistency — the curator put those
  // names in SPCX's `terms`, deciding they are the company. Nobody made that
  // call for Blackwell, and this file is not the place to make it quietly.
  { url: 'https://en.wikipedia.org/wiki/Blackwell_(microarchitecture)', expect: null, why: 'a product line; NVIDIA is only thematic here, never in the headline' },
  { url: 'https://spacenews.com/', expect: null, why: 'industry front page, SpaceX-heavy, about no single asset' },
  { url: 'https://www.theverge.com/tech', expect: null, why: 'section index across many companies' },
  { url: 'https://en.wikipedia.org/wiki/Falcon_9', expect: 'SPCX', why: 'named vehicle, short-ish page' },
  // Relabelled after the first run, and the relabelling is the finding: this
  // page is about the COIN, not about Circle Internet Group. It names the
  // issuer a few times in passing, scores 9, and is correctly refused. Calling
  // it a true match would have been me asking the matcher to infer that an
  // article about a product is an article about its maker.
  { url: 'https://en.wikipedia.org/wiki/USD_Coin', expect: null, why: 'about the coin, not its issuer — names Circle in passing' },
  { url: 'https://en.wikipedia.org/wiki/Semiconductor_industry', expect: null, why: 'names several catalog companies, about none of them' },

  // ── pages with no asset at all ───────────────────────────────────────────
  { url: 'https://en.wikipedia.org/wiki/Sourdough', expect: null, why: 'control' },
  { url: 'https://en.wikipedia.org/wiki/Association_football', expect: null, why: 'control' },
];

function textFrom(html: string): { title: string; h1: string; body: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '';
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
  const strip = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/gi, '&')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  // 20_000 is what the content script actually sends — calibrating on more text
  // than production sees would tune against a page nobody scores.
  return { title: strip(title), h1: strip(h1), body: body.slice(0, 20_000) };
}

async function main(): Promise<void> {
  const trueScores: number[] = [];
  const falseScores: number[] = [];
  let correct = 0;
  const wrong: string[] = [];

  console.log('');
  for (const c of CORPUS) {
    let page;
    try {
      const res = await fetch(c.url, { headers: { 'User-Agent': 'poppin-calibration/1.0' } });
      if (!res.ok) {
        // A bot wall is still 680 KB of HTML mentioning the company. Scoring it
        // would put a page nobody can read into the corpus and quietly move the
        // thresholds read off it.
        console.log(`SKIP  ${c.url} — HTTP ${res.status}, not a page`);
        continue;
      }
      page = textFrom(await res.text());
    } catch (e) {
      console.log(`SKIP  ${c.url} — ${(e as Error).message}`);
      continue;
    }

    const out = scorePage({
      url: c.url,
      title: page.title,
      h1: page.h1,
      bodyExcerpt: page.body,
    });

    const got = out.match?.symbol ?? null;
    const ok = got === c.expect;
    if (ok) correct++;
    else wrong.push(`${c.url}: expected ${c.expect ?? 'nothing'}, got ${got ?? 'nothing'}`);

    const name = c.url.replace('https://en.wikipedia.org/wiki/', '');
    console.log(
      `${ok ? '  ok' : 'MISS'}  ${name.padEnd(34)} expect=${String(c.expect).padEnd(6)} got=${String(got).padEnd(6)} ${out.reason ? `(${out.reason})` : ''}`,
    );
    for (const cand of out.candidates.slice(0, 3)) {
      // Every candidate's score is recorded against whether it was the right
      // answer — that pairing is the whole calibration.
      const isTruth = cand.symbol === c.expect;
      (isTruth ? trueScores : falseScores).push(cand.score);
      console.log(
        `         ${isTruth ? 'TRUE ' : 'false'}  ${cand.symbol.padEnd(6)} score=${String(cand.score).padStart(4)}  ${cand.confidence}  ${cand.matchedDirect.join(',')} ${cand.matchedThematic.join(',')}`,
      );
    }
    console.log(`         — ${c.why}`);
  }

  const sortNum = (a: number, b: number) => a - b;
  trueScores.sort(sortNum);
  falseScores.sort(sortNum);

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`accuracy: ${correct}/${CORPUS.length}`);
  for (const w of wrong) console.log(`   MISS ${w}`);
  console.log(`\nTRUE-match scores : ${trueScores.join(', ') || '(none)'}`);
  console.log(`FALSE-match scores: ${falseScores.join(', ') || '(none)'}`);
  if (trueScores.length && falseScores.length) {
    console.log(`\nlowest TRUE  : ${trueScores[0]}`);
    console.log(`highest FALSE: ${falseScores[falseScores.length - 1]}`);
    console.log(
      trueScores[0]! > falseScores[falseScores.length - 1]!
        ? 'SEPARABLE — a single threshold divides them cleanly.'
        : 'OVERLAPPING — no threshold separates these two populations, so the ' +
            'floor alone cannot be the whole rule; the dominance and ' +
            'headline rules are doing the rest of the work.',
    );
  }
  console.log('─'.repeat(72));
}

void main();
