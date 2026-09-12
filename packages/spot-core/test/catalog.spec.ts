import { describe, expect, it } from 'vitest';
import {
  CURATED_CATALOG,
  curatedByMint,
  curatedByTicker,
  matchCatalogTerms,
  restrictionsFor,
} from '../src/catalog/index';
import {
  CatalogPolicy,
  RegimePolicy,
  attributeBuildFailure,
  regimeOf,
} from '../src/safety/regime';
import { extractCandidates } from '../src/context/extract';
import { assessIntent } from '../src/intent/index';
import { RouteError } from '../src/errors';
import type { MintPolicy } from '../src/route/policy';

const SPCX = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const CRCLX = 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1';
const MU = 'MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
// A valid-shaped mint that is NOT in the catalog and never will be — the
// open-regime exemplar. (BONK graduated into the catalog on 2026-08-14.)
const OPEN = 'open1111111111111111111111111111111111111111';

describe('the curated catalog — shape', () => {
  it('carries every field a row is required to declare', () => {
    for (const a of CURATED_CATALOG) {
      expect(a.mint, a.ticker).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(a.ticker.length, a.ticker).toBeGreaterThan(0);
      expect(a.name.length, a.ticker).toBeGreaterThan(0);
      expect([
        'backpack-securities',
        'xstocks',
        'prestocks',
        'ondo',
        'tether',
        'native-spl',
        'wormhole',
        'bridged',
      ]).toContain(a.issuer);
      expect(a.chain).toBe('solana');
      expect(a.journey).toBe('A');
      expect(['equity', 'commodity', 'token', 'memecoin']).toContain(
        a.category,
      );
      expect(a.terms.length, a.ticker).toBeGreaterThan(0);
    }
  });

  it('holds the probed rows and nothing unprobed', () => {
    // The original five (2026-08-12) plus the 2026-08-14 expansion. Still an
    // exhaustive literal list on purpose: a row nobody wrote down here is a
    // row nobody probed.
    //
    // POLYMARKET and KALSHI were removed 2026-08-25 before the store
    // submission. Both were legitimate pre-IPO equity rows, restricted to
    // non-US persons like their neighbours, but they were the only entries
    // whose matching keywords put 'betting odds' and 'election odds' into
    // the shipped bundle. A reviewer greps the package, and the product
    // being reviewed does not offer prediction markets. Re-add them with
    // the keywords rewritten if the assets are wanted back.
    expect(CURATED_CATALOG.map((a) => a.ticker)).toEqual([
      'SPCX',
      'SPYx',
      'CRCLx',
      'NVDAx',
      'MU',
      'QQQx',
      'SKHY',
      'TSLAx',
      'SNDK',
      'MSTRx',
      'HOODx',
      'COINx',
      'AAPLx',
      'GOOGLx',
      'MSFTx',
      'AMZNx',
      'NBIS',
      'INTC',
      'TTWO',
      'PLTRx',
      'AVGOx',
      'MCDx',
      'METAx',
      'GMEx',
      'BRK.Bx',
      'GLDx',
      'SOL',
      'WBTC',
      'PUMP',
      'ETH',
      'RAY',
      'HYPE',
      'JUP',
      'JTO',
      'HNT',
      'PYTH',
      'RENDER',
      'WEN',
      'TRUMP',
      'BOME',
      'MEW',
      'Fartcoin',
      '$WIF',
      'POPCAT',
      'Pnut',
      'MELANIA',
      'PENGU',
      'GOAT',
      'MOODENG',
      'Bonk',
      'ANTHROPIC',
      'OPENAI',
      'ANDURIL',
      'NEURALINK',
      'SLVon',
      'DBR',
      'KMNO',
      'MPLX',
      'CLOUD',
      'HUMA',
      'ME',
      'NOS',
      'ORCA',
      'TAO',
      'W',
      'GRASS',
      'DRIFT',
      'IO',
      'ANSEM',
      'jellyjelly',
      'MANEKI',
      'pippin',
      'YZY',
      'ZEREBRO',
      'TROLL',
      'BIRB',
      'neet',
      'USELESS',
      'GRIFFAIN',
      'AVA',
      'GIGA',
      'Jimothy',
      'VINE',
      'TripleT',
      'FWOG',
      'Buttcoin',
      'CHILLGUY',
      'UFD',
      'PONKE',
      'XAUt0',
      'JLP',
      'TRX',
      'arc',
      'ZEC',
      'MET',
      'META',
      'CARDS',
      'CRED',
      'ALCH',
      'AVICI',
      'STONK',
      'UMBRA',
      'SKR',
      'BORG',
      'swarms',
      'TUNA',
      'WET',
      'ORE',
      'wXRP',
      'AUDIO',
      'BP',
      '2Z',
      'OMFG',
      'WOULD',
      'Cupsey',
      'PYTHIA',
      'Bert',
      'ALON',
      'DOOD',
      'KLED',
      'NEST',
      'GOHOME',
      '$michi',
      'nub',
      'fih',
      '$BEER',
    ]);
  });

  it('records the issuers as they actually are, not as the brief assumed', () => {
    // Two Backpack, three xStocks. The brief called the whole set
    // Sunrise/Backpack; the field records what Jupiter and the issuers say.
    expect(curatedByTicker('SPCX')?.issuer).toBe('backpack-securities');
    expect(curatedByTicker('MU')?.issuer).toBe('backpack-securities');
    expect(curatedByTicker('SPYx')?.issuer).toBe('xstocks');
    expect(curatedByTicker('CRCLx')?.issuer).toBe('xstocks');
    expect(curatedByTicker('NVDAx')?.issuer).toBe('xstocks');
  });

  it('declares the US-person restriction on every SECURITY row', () => {
    // Declared, NOT enforced — §8 blocks OFAC only and the US is deliberately
    // not geofenced. Scoped to securities: a plain SPL token has no issuer
    // terms to declare, and inventing one would be a fabrication.
    for (const a of CURATED_CATALOG) {
      if (a.category === 'equity' || a.category === 'commodity') {
        expect(a.issuerRestrictions, a.ticker).toContain('us-persons');
      } else {
        expect(a.issuerRestrictions, a.ticker).toEqual([]);
      }
    }
  });

  it('has no term that differs from another only by case', () => {
    // Matching is case-insensitive, so a cased variant matches nothing new and
    // only competes to be the term reported as the hit.
    const terms = CURATED_CATALOG.flatMap((a) => a.terms);
    const folded = terms.map((t) => t.toLowerCase());
    expect(new Set(folded).size).toBe(terms.length);
  });

  it('has no duplicate mints or tickers', () => {
    const mints = CURATED_CATALOG.map((a) => a.mint);
    const tickers = CURATED_CATALOG.map((a) => a.ticker.toLowerCase());
    expect(new Set(mints).size).toBe(mints.length);
    expect(new Set(tickers).size).toBe(tickers.length);
  });
});

describe('the curated catalog — lookups', () => {
  it('finds a row by mint and by ticker, case-insensitively', () => {
    expect(curatedByMint(SPCX)?.ticker).toBe('SPCX');
    expect(curatedByTicker('spcx')?.mint).toBe(SPCX);
    expect(curatedByTicker('$NVDAx')?.mint).toBe(NVDAX);
  });

  it('knows nothing about anything else', () => {
    expect(curatedByMint(OPEN)).toBeUndefined();
    expect(curatedByTicker('SLERF')).toBeUndefined();
  });
});

describe('§6 path C — catalog terms, and only catalog terms', () => {
  const on = (text: string, headline = '') =>
    matchCatalogTerms({ text, headline });

  it('resolves a company name to its catalog mint', () => {
    expect(on('Nvidia just reported earnings.')[0]?.mint).toBe(NVDAX);
    expect(on('A SpaceX launch is scheduled.')[0]?.mint).toBe(SPCX);
    expect(on('Micron shipped the parts.')[0]?.mint).toBe(MU);
  });

  it('counts occurrences and marks headline prominence', () => {
    const [hit] = on('Nvidia did a thing. Later, Nvidia did another.', 'Nvidia news');
    expect(hit?.count).toBe(3);
    expect(hit?.prominent).toBe(true);
  });

  it('does not double-count a longer term as its own shorter one', () => {
    // "Micron Technology" must not also register a bare "Micron" hit on the
    // same three words.
    const [hit] = on('Micron Technology said so.');
    expect(hit?.count).toBe(1);
  });

  it('is closed over the catalog — a real company absent from it is unreachable', () => {
    // The point of path C. No entity linker, no fuzzy match, no open world.
    // (Apple, Tesla and Microsoft graduated into the catalog on 2026-08-14 —
    // these three are the current absentees.)
    expect(on('Netflix and Boeing and Starbucks had a big day.')).toEqual([]);
  });

  it('does NOT match the bare word "circle"', () => {
    // The trap this catalog is written to avoid: `Circle` is ordinary English.
    // CRCLx is reachable by its ticker and its mint, and by name only when a
    // page names the company in full.
    expect(on('Let us circle back on that later.')).toEqual([]);
    expect(on('He drew a circle around the answer.')).toEqual([]);
    expect(on('Circle Internet Group filed today.')[0]?.mint).toBe(CRCLX);
  });

  it('respects word boundaries rather than matching inside words', () => {
    expect(on('The microntechnology of it all')).toEqual([]);
    expect(on('spacexplorer is a username')).toEqual([]);
  });

  it('handles the punctuation in a term without exploding the regex', () => {
    // "S&P 500" contains a regex metacharacter and ends in a digit, so neither
    // escaping nor the boundary rule can be taken for granted.
    expect(on('The S&P 500 closed higher.')[0]?.mint).toBe(
      curatedByTicker('SPYx')?.mint,
    );
    expect(on('SP500 futures are up.')[0]?.mint).toBe(
      curatedByTicker('SPYx')?.mint,
    );
  });

  it('ranks a prominent term above a merely repeated one', () => {
    const hits = on('Nvidia. Nvidia. Nvidia. SpaceX once.', 'SpaceX launches');
    expect(hits[0]?.mint).toBe(SPCX);
  });
});

describe('§6 path C — through extraction and the intent filter', () => {
  const scan = (text: string, headline = '') =>
    assessIntent(extractCandidates({ text, headline }));

  it('acts on a catalog company the page is visibly about', () => {
    const v = scan('The company had a strong quarter.', 'Nvidia earnings beat');
    expect(v).toMatchObject({
      act: true,
      entity: { kind: 'entity', value: NVDAX, term: 'NVIDIA' },
    });
  });

  it('refuses a single passing mention', () => {
    // §5's rule, applied unchanged to prose: one mention buried in a paragraph
    // is the "passing mention" the spec names as insufficient.
    expect(scan('My cousin works at Nvidia and likes it.')).toEqual({
      act: false,
      reason: 'no_intent',
    });
  });

  it('acts on a company discussed repeatedly', () => {
    expect(
      scan('Nvidia said one thing. Then Nvidia said another.'),
    ).toMatchObject({ entity: { kind: 'entity', value: NVDAX } });
  });

  it('stays silent on a two-company roundup', () => {
    expect(
      scan('Nvidia rose and Micron rose. Nvidia and Micron both gained.'),
    ).toEqual({ act: false, reason: 'low_confidence' });
  });

  it('lets an explicit $TICKER win over prose on the same page', () => {
    // A ticker is somebody writing in the register of trading; a company name
    // is somebody writing in English. They never compete.
    const v = scan('$BONK is ripping, $BONK again. Nvidia also had a day. Nvidia again.');
    expect(v).toMatchObject({ entity: { kind: 'ticker', value: 'BONK' } });
  });

  it('lets an address win over everything', () => {
    const v = scan(`Nvidia. Nvidia. ${BONK}`, 'Nvidia');
    expect(v).toMatchObject({ entity: { kind: 'address', value: BONK } });
  });

  it('does not read a company name out of the URL', () => {
    // /tech/nvidia/ is a publisher's taxonomy, not a statement of intent, and
    // reading it as one would fire on every index page a news site has.
    const c = extractCandidates({
      text: 'Some unrelated article body.',
      headline: 'Weekly roundup',
      url: 'https://example.com/tech/nvidia/2026/08',
    });
    expect(c.entities).toEqual([]);
  });
});

describe('the two regimes stay separate', () => {
  const openMint: MintPolicy & { calls: string[] } = {
    calls: [],
    async assert(mint: string) {
      this.calls.push(mint);
      throw new RouteError('not_allowed', 'gate says no');
    },
  };

  const fresh = () => {
    const calls: string[] = [];
    const gate: MintPolicy = {
      async assert(mint: string) {
        calls.push(mint);
        throw new RouteError('not_allowed', 'gate says no');
      },
    };
    return { calls, policy: new RegimePolicy(gate) };
  };

  it('classifies a catalog mint as curated/equity', () => {
    const v = regimeOf(SPCX);
    expect(v.regime).toBe('curated');
    expect(v.category).toBe('equity');
    expect(v.curated?.ticker).toBe('SPCX');
  });

  it('classifies everything else as open/token', () => {
    const v = regimeOf(OPEN);
    expect(v.regime).toBe('open');
    expect(v.category).toBe('token');
    expect(v.curated).toBeUndefined();
  });

  it('admits a curated mint WITHOUT consulting the open-mint gate', () => {
    // The load-bearing assertion. All five rows fail §7 on retained mint and
    // freeze authorities — measured, not assumed — so a curated mint that
    // reached the gate would be rejected and the whole category would vanish
    // behind a `failed_safety` count.
    const { calls, policy } = fresh();
    return Promise.all(
      CURATED_CATALOG.map(async (a) => {
        const v = await policy.admit(a.mint);
        expect(v.regime, a.ticker).toBe('curated');
      }),
    ).then(() => {
      expect(calls).toEqual([]);
    });
  });

  it('sends everything else to the gate and lets it decide', async () => {
    const { calls, policy } = fresh();
    await expect(policy.admit(OPEN)).rejects.toBeInstanceOf(RouteError);
    expect(calls).toEqual([OPEN]);
  });

  it('never gives a mint two chances to pass', async () => {
    // A rejected open mint must not then be offered the curated rule, and a
    // curated mint must not be re-checked by the gate. One fork, one answer.
    const { calls, policy } = fresh();
    await expect(policy.assert(OPEN)).rejects.toThrow();
    expect(calls).toEqual([OPEN]);
    expect(openMint.calls).toEqual([]);
  });

  it('CatalogPolicy alone admits the catalog and refuses the rest', () => {
    const p = new CatalogPolicy();
    expect(() => p.assert(SPCX)).not.toThrow();
    expect(() => p.assert(OPEN)).toThrow(RouteError);
  });
});

describe('issuerRestrictions — soft-applied', () => {
  const spcx = curatedByMint(SPCX);
  const bonkish = undefined;

  it('applies to a reader in the restricted country', () => {
    expect(restrictionsFor(spcx, 'US')).toEqual(['us-persons']);
    expect(restrictionsFor(spcx, 'us')).toEqual(['us-persons']);
  });

  it('applies to nobody else', () => {
    for (const country of ['TR', 'DE', 'NG', 'BR', 'GB']) {
      expect(restrictionsFor(spcx, country), country).toEqual([]);
    }
  });

  it('applies to nobody when the country did not resolve', () => {
    // §8 fails open, so an unresolved reader gets no line — and is counted in
    // no funnel. The denominator is readers whose country RESOLVED to a
    // restricted one, not readers who are in one.
    expect(restrictionsFor(spcx, undefined)).toEqual([]);
    expect(restrictionsFor(spcx, '')).toEqual([]);
  });

  it('never applies to an open-mint asset — there is no issuer to restrict', () => {
    expect(restrictionsFor(bonkish, 'US')).toEqual([]);
  });

  it('applies across both SECURITIES issuers, and to no token', () => {
    for (const a of CURATED_CATALOG) {
      if (a.category === 'equity' || a.category === 'commodity') {
        expect(restrictionsFor(a, 'US'), a.ticker).toEqual(['us-persons']);
      } else {
        expect(restrictionsFor(a, 'US'), a.ticker).toEqual([]);
      }
    }
  });

  it('does NOT change what is routable — it warns, it does not gate', () => {
    // The whole design. A restricted reader still gets a card and a working
    // Buy; whether the chain agrees is the thing being measured, and guessing
    // it here would destroy the measurement.
    expect(regimeOf(SPCX).regime).toBe('curated');
    expect(() => new CatalogPolicy().assert(SPCX)).not.toThrow();
  });
});

describe('attributing a failed build', () => {
  const attribute = (
    chainRefused: boolean,
    restriction: 'us-persons' | undefined,
    failure: 'unknown' | 'rate_limited' | 'no_route' | 'quote_unavailable' = 'unknown',
  ) => attributeBuildFailure({ chainRefused, restriction, failure });

  it('attributes a chain rejection for a restricted reader', () => {
    expect(attribute(true, 'us-persons')).toEqual({
      failure: 'issuer_restricted',
      issuerRestricted: true,
    });
  });

  it('does NOT attribute a chain rejection for an unrestricted reader', () => {
    expect(attribute(true, undefined)).toEqual({
      failure: 'unknown',
      issuerRestricted: false,
    });
  });

  it('does NOT attribute a rate limit, however restricted the reader', () => {
    // The inflation that would make a premature hard block look justified. A
    // rate limit is a rate limit in every jurisdiction.
    expect(attribute(false, 'us-persons', 'rate_limited')).toEqual({
      failure: 'rate_limited',
      issuerRestricted: false,
    });
  });

  it('leaves every non-chain failure alone', () => {
    // Those are statements about Jupiter or about us. A mint-level transfer
    // restriction cannot surface in any of them.
    for (const f of ['no_route', 'quote_unavailable', 'rate_limited'] as const) {
      expect(attribute(false, 'us-persons', f).failure, f).toBe(f);
    }
  });

  it('needs BOTH halves — neither alone is enough', () => {
    expect(attribute(true, undefined).issuerRestricted).toBe(false);
    expect(attribute(false, 'us-persons').issuerRestricted).toBe(false);
    expect(attribute(true, 'us-persons').issuerRestricted).toBe(true);
  });
});
