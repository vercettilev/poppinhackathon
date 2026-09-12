import { iconCandidates } from './icon.service';

/**
 * A BLANK TOKEN DISC, TRACED END TO END (2026-09-07).
 *
 * $BULLSHIT showed the initial-letter fallback instead of its picture.
 * Measured rather than guessed:
 *
 *   by-mint            → icon: https://ipfs.io/ipfs/bafkrei…  (present)
 *   that URL, laptop   → 200, image/png, 79,945 bytes
 *   api.poppin.so/icon → 404, three times, fast
 *   the same route, SOL→ 200, image/png (a NON-ipfs icon)
 *
 * So the endpoint works, the server can fetch icons, and the icon URL is
 * real — it is IPFS specifically that our egress cannot get. That is the
 * ordinary fate of a datacenter IP against a public gateway.
 *
 * The ladder made it worse than it had to be: ipfs.io, dweb.link and
 * w3s.link are three names for one operator's infrastructure, so a single
 * rate limit took all three rungs at once.
 */
describe('iconCandidates', () => {
  it('spans more than one operator, which three names did not', () => {
    const gws = iconCandidates(
      'https://ipfs.io/ipfs/bafkreiaxj5rl4uuy7wlhggy4bs2rtxdvrzndvuu75w6adiudb54nfzz3pu',
    ).map((u) => new URL(u).hostname);
    // Protocol Labs / Storacha run ipfs.io, dweb.link and w3s.link.
    const others = gws.filter(
      (h) => !['ipfs.io', 'dweb.link', 'w3s.link'].includes(h),
    );
    expect(others.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the original URL first, whatever gateway it names', () => {
    // The upstream's own choice gets the first try: it is the one most
    // likely to have the content pinned.
    const [first] = iconCandidates('https://dweb.link/ipfs/bafyCID');
    expect(first).toBe('https://dweb.link/ipfs/bafyCID');
  });

  it('never offers the same gateway twice', () => {
    const gws = iconCandidates('https://ipfs.io/ipfs/bafyCID').map(
      (u) => new URL(u).hostname,
    );
    expect(new Set(gws).size).toBe(gws.length);
  });

  it('rewrites a subdomain-style URL by CID, not by string surgery', () => {
    const out = iconCandidates('https://bafycid.ipfs.dweb.link/');
    expect(out.length).toBeGreaterThan(1);
    expect(out[1]).toContain('/ipfs/bafycid');
  });

  it('finds a CID that is not where the convention puts it', () => {
    /**
     * $PANTS, measured the same day: its icon is
     * https://ansem.io/api/ipfs/bafybei… — a private host with an
     * /api/ipfs/ prefix. The gateway-convention patterns did not match it,
     * so it got exactly one candidate, and that host answers 403 to
     * anything without a browser's headers. The identical CID served fine
     * from ipfs.io and 4everland in the same second.
     */
    const cid = 'bafybeif7ggfpxrtquzuqp6qdi2xg7w6h66dxhpqsehjytku7jvyauujx3u';
    const out = iconCandidates(`https://ansem.io/api/ipfs/${cid}`);
    expect(out[0]).toBe(`https://ansem.io/api/ipfs/${cid}`);
    expect(out.length).toBeGreaterThan(3);
    expect(out.slice(1).every((u) => u.endsWith(`/ipfs/${cid}`))).toBe(true);
  });

  it('matches a CID by SHAPE, so a long path segment is not content', () => {
    // Position would have been the cheap rule and the wrong one: plenty of
    // URLs carry a long opaque segment that is not addressable content.
    expect(iconCandidates('https://cdn.example/api/ipfs/not-a-cid-just-long-words')).toEqual([
      'https://cdn.example/api/ipfs/not-a-cid-just-long-words',
    ]);
    expect(
      iconCandidates('https://cdn.example/assets/9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c'),
    ).toHaveLength(1);
  });

  it('accepts a v0 CID as well as v1', () => {
    const v0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const out = iconCandidates(`https://host.example/api/ipfs/${v0}`);
    expect(out.length).toBeGreaterThan(3);
    expect(out[1]).toContain(`/ipfs/${v0}`);
  });

  it('leaves a non-IPFS icon alone', () => {
    // SOL's icon is a plain CDN URL and fetches fine; a ladder would be
    // noise.
    const out = iconCandidates('https://example.com/logo.png');
    expect(out).toEqual(['https://example.com/logo.png']);
  });

  it('refuses anything that is not https', () => {
    expect(iconCandidates('http://ipfs.io/ipfs/bafyCID')).toEqual([]);
    expect(iconCandidates('ipfs://bafyCID')).toEqual([]);
    expect(iconCandidates('not a url')).toEqual([]);
  });
});
