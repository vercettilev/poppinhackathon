import { describe, expect, it } from 'vitest';
import {
  ADDRESS_PATH_BUDGET_MS,
  ENTITY_PATH_BUDGET_MS,
  TICKER_PATH_BUDGET_MS,
  resolveEntity,
} from '../src/resolve/paths';
import type {
  JupiterUltraTokenInfo,
  UltraOutcome,
  UltraSearchClient,
} from '../src/resolve/ultra';
import type { Candidates } from '../src/context/extract';

const SPCX = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
// SLERF: real, established, NOT curated — the open-regime exemplar.
// (SLERF, the previous exemplar, graduated into the catalog on 2026-08-14.)
const SLERF = '7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3';

const info = (over: Partial<JupiterUltraTokenInfo>): JupiterUltraTokenInfo => ({
  id: SLERF,
  name: 'Bonk',
  symbol: 'SLERF',
  decimals: 5,
  ...over,
});

/** Records what was asked for and with what deadline. */
class FakeUltra implements UltraSearchClient {
  queries: Array<{ query: string; timeoutMs: number | undefined }> = [];
  constructor(private readonly reply: (q: string) => UltraOutcome<JupiterUltraTokenInfo[]>) {}
  async search(
    query: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<UltraOutcome<JupiterUltraTokenInfo[]>> {
    this.queries.push({ query, timeoutMs: opts.timeoutMs });
    return this.reply(query);
  }
}

const ok = (list: JupiterUltraTokenInfo[]) =>
  new FakeUltra(() => ({ ok: true, value: list }));

const candidates = (over: Partial<Candidates> = {}): Candidates => ({
  addresses: [],
  tickers: [],
  entities: [],
  ...over,
});

describe('§6 path A — address', () => {
  it('resolves by identity and reports the open regime', async () => {
    const ultra = ok([info({})]);
    const r = await resolveEntity(candidates({ addresses: [SLERF] }), ultra);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe('address');
    expect(r.regime).toBe('open');
    expect(r.category).toBe('token');
    expect(r.info.id).toBe(SLERF);
  });

  it('reports the curated regime when the address IS a catalog mint', async () => {
    const ultra = ok([info({ id: SPCX, symbol: 'SPCX' })]);
    const r = await resolveEntity(candidates({ addresses: [SPCX] }), ultra);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.regime).toBe('curated');
    expect(r.category).toBe('equity');
    expect(r.curated?.issuer).toBe('backpack-securities');
  });

  it('says no_asset when Jupiter does not know the mint', async () => {
    const r = await resolveEntity(candidates({ addresses: [SLERF] }), ok([]));
    expect(r).toMatchObject({ ok: false, reason: 'no_asset', path: 'address' });
  });
});

describe('§6 path B — ticker', () => {
  it('takes the CATALOG mint for a curated ticker, without asking Jupiter to pick', async () => {
    // The impostor problem, measured: on 2026-08-12 Ultra returned eight exact
    // `SPCX` matches, separated only by a `verified` flag that is Jupiter's
    // editorial call. A curated ticker must not be re-decided per request.
    const ultra = ok([info({ id: SPCX, symbol: 'SPCX' })]);
    const r = await resolveEntity(
      candidates({ tickers: [{ symbol: 'SPCX', count: 3, prominent: true }] }),
      ultra,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.regime).toBe('curated');
    expect(r.info.id).toBe(SPCX);
    // Queried BY MINT, not by symbol: the mint was already decided locally.
    expect(ultra.queries[0]?.query).toBe(SPCX);
  });

  it('falls to the ambiguity rule for a ticker the catalog does not know', async () => {
    const ultra = ok([
      info({ id: SLERF, symbol: 'SLERF', isVerified: true }),
      info({ id: 'other', symbol: 'SLERF' }),
    ]);
    const r = await resolveEntity(
      candidates({ tickers: [{ symbol: 'SLERF', count: 3, prominent: true }] }),
      ultra,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.regime).toBe('open');
    expect(r.info.id).toBe(SLERF);
    expect(ultra.queries[0]?.query).toBe('SLERF');
  });

  it('stays silent when two candidates survive', async () => {
    const ultra = ok([
      info({ id: 'a', symbol: 'SLERF' }),
      info({ id: 'b', symbol: 'SLERF' }),
    ]);
    const r = await resolveEntity(
      candidates({ tickers: [{ symbol: 'SLERF', count: 3, prominent: true }] }),
      ultra,
    );
    expect(r).toMatchObject({ ok: false, reason: 'low_confidence', path: 'ticker' });
  });
});

describe('§6 path C — entity', () => {
  it('resolves a catalog term to its mint and reports the curated regime', async () => {
    const ultra = ok([info({ id: NVDAX, symbol: 'NVDAx' })]);
    const r = await resolveEntity(
      candidates({
        entities: [{ mint: NVDAX, term: 'NVIDIA', count: 3, prominent: true }],
      }),
      ultra,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe('entity');
    expect(r.regime).toBe('curated');
    expect(r.category).toBe('equity');
    expect(r.curated?.ticker).toBe('NVDAx');
    // The mint came from the catalog; Jupiter was asked only for the numbers
    // the card cannot be drawn without.
    expect(ultra.queries[0]?.query).toBe(NVDAX);
  });

  it('renders nothing when Jupiter cannot price a curated asset', async () => {
    // Knowing the mint is not enough: decimals and a price are needed to draw
    // a card, and inventing either is worse than silence.
    const r = await resolveEntity(
      candidates({
        entities: [{ mint: NVDAX, term: 'NVIDIA', count: 3, prominent: true }],
      }),
      ok([]),
    );
    expect(r).toMatchObject({ ok: false, reason: 'no_asset', path: 'entity' });
    // Still categorised, so the silence lands in the equity funnel rather than
    // in `unknown` where nobody would find it.
    expect(r.category).toBe('equity');
  });
});

describe('§9 — each path carries its own budget', () => {
  it('spends the address budget on an address', async () => {
    const ultra = ok([info({})]);
    await resolveEntity(candidates({ addresses: [SLERF] }), ultra);
    expect(ultra.queries[0]?.timeoutMs).toBe(ADDRESS_PATH_BUDGET_MS);
    expect(ADDRESS_PATH_BUDGET_MS).toBe(500);
  });

  it('spends the ticker budget on a ticker', async () => {
    const ultra = ok([info({ isVerified: true })]);
    await resolveEntity(
      candidates({ tickers: [{ symbol: 'SLERF', count: 3, prominent: true }] }),
      ultra,
    );
    expect(ultra.queries[0]?.timeoutMs).toBe(TICKER_PATH_BUDGET_MS);
    expect(TICKER_PATH_BUDGET_MS).toBe(2_000);
  });

  it('spends the entity budget on a catalog term', async () => {
    const ultra = ok([info({ id: NVDAX })]);
    await resolveEntity(
      candidates({
        entities: [{ mint: NVDAX, term: 'NVIDIA', count: 3, prominent: true }],
      }),
      ultra,
    );
    expect(ultra.queries[0]?.timeoutMs).toBe(ENTITY_PATH_BUDGET_MS);
    expect(ENTITY_PATH_BUDGET_MS).toBe(3_000);
  });

  it('gives the widest budget to the path nobody asked for', async () => {
    // Not a claim that prose is slower to resolve — path C decides its mint
    // locally and is the fastest of the three. It is the furthest from an
    // explicit request, so arriving late costs least there and most on a
    // pasted address, where a reader is plainly waiting.
    expect(ADDRESS_PATH_BUDGET_MS).toBeLessThan(TICKER_PATH_BUDGET_MS);
    expect(TICKER_PATH_BUDGET_MS).toBeLessThan(ENTITY_PATH_BUDGET_MS);
  });
});

describe('§5 — silence still carries its reason', () => {
  it('reports no_entity with no path taken', async () => {
    const r = await resolveEntity(candidates(), ok([]));
    expect(r).toMatchObject({ ok: false, reason: 'no_entity' });
    expect((r as { path?: string }).path).toBeUndefined();
    expect(r.category).toBe('unknown');
  });

  it('reports no_intent for an uncorroborated mention', async () => {
    const r = await resolveEntity(
      candidates({ tickers: [{ symbol: 'SLERF', count: 1, prominent: false }] }),
      ok([]),
    );
    expect(r).toMatchObject({ ok: false, reason: 'no_intent' });
  });
});
