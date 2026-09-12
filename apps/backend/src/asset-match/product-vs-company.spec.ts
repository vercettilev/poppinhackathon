import { scorePage } from './asset-match.util';

/**
 * A page about a PRODUCT is not a page about the company that makes it.
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 * Five catalog rows had product names sitting in `terms`, the DIRECT list —
 * iPhone/MacBook/iPad under Apple, YouTube under Google, Facebook and
 * Instagram under Meta, AWS under Amazon, ChatGPT under OpenAI. A direct term
 * is worth a headline hit, so any of those words in a title was enough to
 * carry the row over the floor on its own.
 *
 * Measured before the fix: "iPhone 17 review: the best one yet" matched AAPLx
 * at score 28 with `confident`, and "20 ChatGPT prompts for writers" matched
 * OPENAI at 28. A trading card on a gadget review and on a writing-tips post.
 *
 * TSLAx already drew the line correctly — Model 3 and Autopilot live in
 * `thematic` — so this was an inconsistency between rows rather than a
 * decision anyone had made.
 *
 * ── WHY THEMATIC IS THE RIGHT HOME, NOT DELETION ────────────────────────────
 * Thematic terms cannot create a match on their own (scorePage returns
 * `no_terms` before they are ever consulted) but they DO raise a page that
 * already names the company. So the Apple earnings story that says "iPhone"
 * eight times scores higher than it used to, while the phone review scores
 * nothing at all. Precision bought without spending recall — which is the
 * only version of this trade worth making.
 *
 * These pages are synthetic on purpose. calibrate.ts fetches real URLs and is
 * the right tool for tuning weights against live prose; this file pins a
 * known, reproducible failure shape so it cannot come back quietly when
 * somebody adds the next big brand to the catalog.
 */

const repeat = (s: string, n: number) => s.repeat(n);

describe('a product page is not a company page', () => {
  it('does not offer Apple stock on an iPhone review', () => {
    const out = scorePage({
      url: 'https://techsite.com/reviews/iphone-17-review',
      title: 'iPhone 17 review: the best one yet',
      h1: 'iPhone 17 review',
      bodyExcerpt: repeat(
        'The iPhone 17 is here. The iPhone camera is better. Compared to last ' +
          'year the iPhone feels faster. iPhone battery life is improved. ',
        8,
      ),
    });
    expect(out.match).toBeNull();
  });

  it('does not offer OpenAI on a ChatGPT how-to', () => {
    const out = scorePage({
      url: 'https://blog.com/chatgpt-prompts',
      title: '20 ChatGPT prompts for writers',
      h1: '20 ChatGPT prompts for writers',
      bodyExcerpt: repeat(
        'ChatGPT can help you write. Ask ChatGPT to summarise. ChatGPT is good ' +
          'at outlines. Try ChatGPT for headlines. ',
        8,
      ),
    });
    expect(out.match).toBeNull();
  });

  it('does not offer Meta stock on a page whose only Facebook is a share button', () => {
    const out = scorePage({
      url: 'https://someblog.com/2026/gardening-tips',
      title: 'Ten gardening tips for spring',
      h1: 'Ten gardening tips for spring',
      bodyExcerpt: repeat(
        'Spring is here. Share on Facebook. Follow us on Facebook for more. ' +
          'Facebook comments are enabled below. ',
        6,
      ),
    });
    expect(out.match).toBeNull();
  });

  it('does not offer Google stock on every page of YouTube', () => {
    const out = scorePage({
      url: 'https://www.youtube.com/watch?v=abc123',
      title: 'How to cook perfect rice - YouTube',
      h1: 'How to cook perfect rice',
      bodyExcerpt: repeat(
        'YouTube Home Shorts Subscriptions YouTube Music YouTube Kids Share ' +
          'Save Report Comments Subscribe About Press Copyright Terms Privacy ' +
          'How YouTube works Test new features ',
        3,
      ),
    });
    expect(out.match).toBeNull();
  });
});

describe('...and the company page still matches, harder than before', () => {
  it('matches Apple on an earnings story, with the product corroborating', () => {
    const out = scorePage({
      url: 'https://news.com/apple-q4-earnings',
      title: 'Apple Inc beats on iPhone revenue',
      h1: 'Apple Inc beats on iPhone revenue',
      bodyExcerpt: repeat(
        'Apple Inc reported results. Tim Cook said iPhone demand was strong. ' +
          'Apple Inc shares rose. AAPL closed up. iPhone and iPad both grew. ',
        6,
      ),
    });
    expect(out.match?.symbol).toBe('AAPLx');
    expect(out.match?.confidence).toBe('confident');
    // Weighed, not read — the URL is a news site, not a venue.
    expect(out.match?.certainty).toBe('inferred');
  });

  it('matches OpenAI on a story about the company itself', () => {
    const out = scorePage({
      url: 'https://news.com/openai-funding',
      title: 'OpenAI raises at a new valuation',
      h1: 'OpenAI raises at a new valuation',
      bodyExcerpt: repeat(
        'OpenAI announced a round. OpenAI said ChatGPT usage grew. Sam Altman ' +
          'commented. OpenAI is now valued higher. ',
        6,
      ),
    });
    expect(out.match?.symbol).toBe('OPENAI');
  });
});
