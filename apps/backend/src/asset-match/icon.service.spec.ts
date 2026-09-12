import { iconCandidates, IconService } from './icon.service';
import type { SpotSwapService } from '../spot/spot-swap.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function service(
  icon: string | null,
  fetchScript: (url: string) => Promise<Response>,
) {
  const spot = {
    tokenStats: jest.fn(async () => ({ icon })),
  } as unknown as SpotSwapService;
  global.fetch = jest.fn(fetchScript) as unknown as typeof fetch;
  return { svc: new IconService(spot), spot };
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

const ok = (type = 'image/png') =>
  ({
    ok: true,
    headers: { get: () => type },
    arrayBuffer: async () => PNG.buffer.slice(0, 4),
  }) as unknown as Response;

describe('iconCandidates', () => {
  it('gives every gateway a turn on IPFS content, original first', () => {
    /**
     * The exact list is no longer pinned here — icon-gateways.spec owns the
     * rule that matters (more than one OPERATOR, no duplicates, original
     * first), and freezing the membership made this test fail every time a
     * rung was added for a measured reason.
     */
    const out = iconCandidates('https://ipfs.io/ipfs/bafkabc');
    expect(out[0]).toBe('https://ipfs.io/ipfs/bafkabc');
    expect(out.length).toBeGreaterThan(3);
    expect(out.every((u) => u.endsWith('/ipfs/bafkabc'))).toBe(true);
  });

  it('leaves a CDN icon with its one real address', () => {
    expect(iconCandidates('https://static.jup.ag/x.png')).toEqual([
      'https://static.jup.ag/x.png',
    ]);
    expect(iconCandidates('http://insecure.example/x.png')).toEqual([]);
  });
});

describe('IconService', () => {
  it('serves the bytes and remembers them for the next chip', async () => {
    const { svc } = service('https://ipfs.io/ipfs/bafkabc', async () => ok());
    const first = await svc.iconFor('Mint1111');
    expect(first?.contentType).toBe('image/png');
    await svc.iconFor('Mint1111');
    // One upstream fetch for two asks: the cache is the whole point of
    // moving this server-side.
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it('climbs the ladder when the first gateway refuses', async () => {
    const calls: string[] = [];
    const { svc } = service('https://ipfs.io/ipfs/bafkabc', async (url) => {
      calls.push(url);
      return url.includes('dweb.link') ? ok() : ({ ok: false } as Response);
    });
    const got = await svc.iconFor('Mint2222');
    expect(got).not.toBeNull();
    // Tries the original first and keeps going until one answers. The
    // rungs BETWEEN are not pinned: the ladder gained gateways from other
    // operators after a per-IP limit took all three of the originals at
    // once, and this test is about climbing, not about membership.
    expect(calls[0]).toBe('https://ipfs.io/ipfs/bafkabc');
    expect(calls.at(-1)).toBe('https://dweb.link/ipfs/bafkabc');
    expect(calls).toContain('https://dweb.link/ipfs/bafkabc');
  });

  it('refuses an answer that is not an image', async () => {
    // A gateway's HTML error page arrives with ok:200 more often than it
    // should; bytes that are not an image must never be served as one.
    const { svc } = service('https://cdn.example/x.png', async () =>
      ok('text/html'),
    );
    expect(await svc.iconFor('Mint3333')).toBeNull();
  });

  it('answers null quickly when the token has no icon at all', async () => {
    const { svc } = service(null, async () => ok());
    expect(await svc.iconFor('Mint4444')).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(0);
  });
});
