import { findAssetForPage, scorePage } from './asset-match.util';

/**
 * The cases here are the ones that were actually wrong in production, not a
 * sweep of the scoring surface. Each names the page that produced it.
 */
describe('asset match', () => {
  describe('the page must be ABOUT the asset', () => {
    it('does not match a single passing mention — the CNBC failure', () => {
      // Real shape of the bug: an NVIDIA article whose related-links rail said
      // "SpaceX" once, which produced a SPCX card.
      const out = scorePage({
        title: 'Why Jensen Huang’s $500 billion AI financing plan faces a big risk from China',
        h1: 'Why Jensen Huang’s $500 billion AI financing plan faces a big risk from China',
        bodyExcerpt:
          'The chipmaker has committed to enormous capital spending. ' +
          'More in tech: SpaceX raises again at a higher valuation.',
      });
      expect(out.match?.symbol).not.toBe('SPCX');
      // And it is not a near miss being shown anyway.
      const spcx = out.candidates.find((c) => c.symbol === 'SPCX');
      expect(spcx && spcx.score < 8).toBe(true);
    });

    it('matches the asset the headline is about', () => {
      const m = findAssetForPage({
        title: 'Nvidia earnings beat expectations',
        h1: 'Nvidia earnings beat expectations',
        bodyExcerpt:
          'NVIDIA said data center revenue rose. Jensen Huang cited demand for the ' +
          'AI accelerator line. NVIDIA shares climbed after hours. NVIDIA guided ' +
          'higher on Blackwell and its data center chip backlog.',
      });
      expect(m?.symbol).toBe('NVDAx');
      expect(m?.confidence).toBe('confident');
    });

    it('does not match body-only today, even when saturated', () => {
      // Documents a REAL limit rather than an intention. A body-only match must
      // clear 28, and MU's vocabulary caps a body-only score at 24 (12 body +
      // 6 thematic terms x 2), so this page — which is unmistakably about
      // Micron — still gets no card.
      //
      // That is the current trade, not a permanent verdict: every false match
      // in the calibration corpus was body-only, and the honest fix is to give
      // the row more `thematic` vocabulary, not to lower the floor into the
      // band where all the wrong answers live.
      const out = scorePage({
        title: 'Chipmaker raises guidance',
        bodyExcerpt:
          'Micron said memory prices firmed. Micron guided higher on HBM demand. ' +
          'Analysts raised targets on Micron after the DRAM cycle turned. Micron ' +
          'shipped more HBM. Micron capex rose. Micron memory chip output grew. ' +
          'Micron NAND flash margins improved. Micron said DRAM demand held. ' +
          'Micron expects high bandwidth memory to lead. Micron reiterated its ' +
          'semiconductor memory outlook. Micron added capacity.',
      });
      expect(out.match).toBeNull();
      expect(out.reason).toBe('below_floor');
      // …and it was close, which is the part worth watching.
      expect(out.candidates[0]!.score).toBeGreaterThanOrEqual(20);
    });

    it('refuses a body-only match that merely repeats — the Elon Musk page', () => {
      // Real false positive: a biography naming Starlink and Crew Dragon
      // throughout, which produced a live SPCX card at exactly the general
      // floor. It is about a person, not about the asset.
      const out = scorePage({
        title: 'Elon Musk',
        h1: 'Elon Musk',
        bodyExcerpt:
          'Musk founded several companies. Starlink grew quickly. Starlink now ' +
          'serves many countries. Crew Dragon carried astronauts. Starlink ' +
          'revenue rose. Crew Dragon flew again. Starlink terminals shipped.',
      });
      expect(out.match).toBeNull();
      expect(out.reason).toBe('below_floor');
    });

    it('rejects a body-only match that does not repeat', () => {
      const out = scorePage({
        title: 'Weekly market wrap',
        bodyExcerpt: 'Elsewhere, Micron rose two percent.',
      });
      expect(out.match).toBeNull();
      expect(out.reason).toBe('mention_only');
    });
  });

  describe('ambiguity', () => {
    it('shows nothing when two assets are neck and neck', () => {
      // BOTH must clear the floor for this rule to be the one that fires — the
      // floor is checked first on purpose, since two assets that are each too
      // weak are not "ambiguous", they are both simply absent.
      const out = scorePage({
        title: 'NVIDIA and Micron both climb on AI memory demand',
        h1: 'NVIDIA and Micron both climb on AI memory demand',
        bodyExcerpt:
          'NVIDIA rose and Micron rose. NVIDIA cited its AI accelerator backlog ' +
          'while Micron cited HBM. NVIDIA and Micron both pointed at the same ' +
          'demand. Jensen Huang and Micron executives said high bandwidth memory ' +
          'is the constraint. NVIDIA needs it; Micron makes it.',
      });
      expect(out.match).toBeNull();
      expect(out.reason).toBe('low_confidence');
      const top = out.candidates.slice(0, 2).map((c) => c.score);
      expect(top.every((s) => s >= 20)).toBe(true);
    });

    it('still picks a clear winner over a weak rival', () => {
      const m = findAssetForPage({
        title: 'NVIDIA unveils its next accelerator',
        h1: 'NVIDIA unveils its next accelerator',
        bodyExcerpt:
          'NVIDIA said the part ships next year. NVIDIA claims a large gain. ' +
          'NVIDIA showed the Blackwell die and its CUDA stack. Jensen Huang spoke. ' +
          'Micron supplies some memory for it.',
      });
      expect(m?.symbol).toBe('NVDAx');
    });
  });

  describe('the catalog is the one in spot-core', () => {
    it('reaches all five assets, not just SpaceX', () => {
      // Headline AND body, because that is what a page is. A bare headline with
      // no article under it scores 16 and is refused by design — the floor was
      // calibrated against real pages, all of which have both.
      const pages: Array<[string, string, string]> = [
        ['SPCX', 'SpaceX launches another Starship', 'SpaceX said the Starship flight met its objectives. SpaceX will refly the booster. Starlink satellites rode along.'],
        ['SPYx', 'The S&P 500 closed at a record', 'The S&P 500 rose again. Strategists raised year-end S&P 500 targets. The benchmark index is up for a fifth week.'],
        ['CRCLx', 'Circle Internet Group files to go public', 'Circle Internet Group disclosed revenue. Circle Internet Group said USDC reserves grew. Jeremy Allaire commented.'],
        ['NVDAx', 'NVIDIA beats on data center revenue', 'NVIDIA reported record revenue. NVIDIA said demand for its AI accelerator held. Jensen Huang cited Blackwell.'],
        ['MU', 'Micron Technology raises guidance', 'Micron Technology lifted its outlook. Micron cited HBM demand. Micron said DRAM pricing improved.'],
      ];
      for (const [symbol, title, body] of pages) {
        const m = findAssetForPage({ title, h1: title, bodyExcerpt: body });
        expect([symbol, m?.symbol]).toEqual([symbol, symbol]);
      }
    });

    it('is not reachable from a bare common noun', () => {
      // `Circle` alone must never resolve to CRCLx — the catalog carries the
      // full company name for exactly this reason.
      const m = findAssetForPage({
        title: 'Let us circle back to the roadmap next quarter',
        bodyExcerpt: 'We will circle back. Circle the date. A circle has no corners.',
      });
      expect(m).toBeNull();
    });
  });

  it('returns null for an ordinary page', () => {
    const out = scorePage({
      title: 'Local bakery wins award for sourdough',
      bodyExcerpt: 'Flour, water, salt, and a long overnight proof.',
    });
    expect(out.match).toBeNull();
    expect(out.reason).toBe('no_terms');
  });
});
