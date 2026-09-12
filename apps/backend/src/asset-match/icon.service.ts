import { Injectable, Logger } from '@nestjs/common';
import { SpotSwapService } from '../spot/spot-swap.service';

/**
 * TOKEN ICONS, SERVED FROM OUR OWN ORIGIN.
 *
 * Round four of "tokenların çoğunun logosu gelmiyor", and the last one.
 * Rounds one to three fixed real client-side holes (no logging, then no
 * IPFS retry, then a single-gateway dependence) and the reports kept
 * coming — because every one of those fixes still asked the READER'S
 * NETWORK to reach an IPFS gateway, and Jupiter's metadata keeps most
 * memecoin icons on IPFS. Every rung of the ladder measured healthy from
 * our side while the discs stayed blank from his; a client-side fix
 * cannot beat an ISP.
 *
 * So the class ends here: THIS server fetches the icon — from a network
 * we can actually observe — caches the bytes, and answers them from
 * api.poppin.so. The extension then depends on exactly one origin it
 * already depends on for everything else. If api.poppin.so is
 * unreachable, there is no chip to decorate anyway.
 *
 * The mint is the only input, ON PURPOSE. Accepting an icon URL from the
 * wire would make this a proxy for fetching arbitrary addresses from
 * inside our network; deriving the URL server-side from the mint keeps
 * the reachable set exactly "what Jupiter says this token's icon is".
 */

// 1.5MB — measured: $ANSEM's real logo is an 863KB PNG, refused for four
// rounds by the old 400KB cap on BOTH ends of the pipe while every network
// probe came back healthy. See helpers/iconBridge.ts for the longer story.
const MAX_ICON_BYTES = 1_500_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Failures are remembered briefly, so one dead icon cannot be re-asked
 *  per chip; successes are remembered for a day. */
const FAIL_TTL_MS = 5 * 60 * 1000;
const CACHE_CAP = 500;

/**
 * FOUR RUNGS AND ONE OPERATOR IS ONE RUNG.
 *
 * The ladder was ipfs.io, dweb.link and w3s.link — three names, all
 * Protocol Labs / Storacha infrastructure. When that operator rate-limits
 * our egress IP, which is the ordinary fate of a datacenter address
 * hitting a public gateway, all three fail together and the ladder has
 * exactly one point of failure.
 *
 * Measured 2026-09-07 against a real token whose icon was blank in the
 * field: all three of the originals served the bytes from a laptop, and
 * api.poppin.so answered 404 for the same CID while serving a
 * non-IPFS icon (SOL) perfectly. That shape — works everywhere except from
 * our server — is what a per-IP limit looks like.
 *
 * The additions are from different operators (Pinata, 4everland, Filebase)
 * and each was probed for this exact CID before being added. Order is by
 * measured latency. flk-ipfs.xyz and trustless-gateway.link were probed and
 * rejected: connection refused and a 406.
 */
const IPFS_GATEWAYS = [
  'ipfs.io',
  '4everland.io',
  'nftstorage.link',
  'ipfs.filebase.io',
  'gateway.pinata.cloud',
  'dweb.link',
  'w3s.link',
] as const;

/** The same content-addressed rewrite the extension's bridge uses: an IPFS
 *  URL names content, the gateway in it is just a door. */
export function iconCandidates(url: string): string[] {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return [];
    let cid: string | null = null;
    let rest = '';
    const path = /^\/ipfs\/([A-Za-z0-9]+)(\/.*)?$/.exec(u.pathname);
    if (path) {
      cid = path[1];
      rest = path[2] ?? '';
    } else {
      const sub = /^([a-z0-9]+)\.ipfs\./.exec(u.hostname);
      if (sub) {
        cid = sub[1];
        rest = u.pathname === '/' ? '' : u.pathname;
      } else {
        /**
         * A CID ANYWHERE IN THE PATH, FOUND BY SHAPE.
         *
         * Measured on $PANTS, whose icon is
         * https://ansem.io/api/ipfs/bafybei… — a private host with an
         * /api/ipfs/ prefix. The two patterns above expect the gateway
         * convention exactly, so this fell through as "not IPFS", got a
         * single candidate, and that host answers 403 to anything without
         * a browser's headers. The same CID served fine from ipfs.io and
         * 4everland in the same second.
         *
         * This module's own premise is that an IPFS URL NAMES CONTENT and
         * the gateway in it is just a door. That has to hold wherever the
         * door happens to sit in the path.
         *
         * Matched by CID SHAPE rather than by position, so a path segment
         * that merely looks long cannot be mistaken for content: CIDv0 is
         * Qm + 44 base58, CIDv1 base32 starts with b and uses a-z2-7 only.
         */
        const seg = u.pathname
          .split('/')
          .find(
            (part) =>
              /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(part) ||
              /^b[a-z2-7]{50,}$/.test(part),
          );
        if (seg) {
          cid = seg;
          const after = u.pathname.slice(
            u.pathname.indexOf(seg) + seg.length,
          );
          rest = after === '/' ? '' : after;
        }
      }
    }
    if (!cid) return [url];
    const alts = IPFS_GATEWAYS.filter((gw) => !u.hostname.includes(gw)).map(
      (gw) => `https://${gw}/ipfs/${cid}${rest}`,
    );
    return [url, ...alts];
  } catch {
    return [];
  }
}

export interface IconAnswer {
  contentType: string;
  bytes: Buffer;
}

@Injectable()
export class IconService {
  private readonly logger = new Logger(IconService.name);
  private readonly cache = new Map<
    string,
    { at: number; answer: IconAnswer | null }
  >();
  private readonly inflight = new Map<string, Promise<IconAnswer | null>>();

  constructor(private readonly spot: SpotSwapService) {}

  async iconFor(mint: string): Promise<IconAnswer | null> {
    const hit = this.cache.get(mint);
    if (hit && Date.now() - hit.at < (hit.answer ? CACHE_TTL_MS : FAIL_TTL_MS)) {
      return hit.answer;
    }
    let flight = this.inflight.get(mint);
    if (!flight) {
      flight = this.fetchIcon(mint)
        .catch(() => null)
        .then((answer) => {
          if (this.cache.size > CACHE_CAP) this.cache.clear();
          this.cache.set(mint, { at: Date.now(), answer });
          return answer;
        })
        .finally(() => this.inflight.delete(mint));
      this.inflight.set(mint, flight);
    }
    return flight;
  }

  /**
   * WHY AN ICON IS MISSING, SAID OUT LOUD.
   *
   * This returned null three different ways and the route turned all of
   * them into a bare 404: Ultra had no icon URL, every gateway refused us,
   * or the bytes failed their checks. The client already complains about
   * exactly this ambiguity on its own side ("a reader reporting 'the token
   * image is gone' cannot tell us which") — the server had the same
   * blindness, and it is the side that can actually see the answers.
   */
  private async fetchIcon(mint: string): Promise<IconAnswer | null> {
    const stats = await this.spot.tokenStats(mint);
    if (!stats.icon) {
      this.logger.debug(`[icon] ${mint}: upstream has no icon url`);
      return null;
    }
    const tried: string[] = [];
    for (const url of iconCandidates(stats.icon)) {
      const got = await this.fetchOnce(url);
      if (got) {
        if (tried.length) {
          this.logger.log(
            `[icon] ${mint}: served by ${new URL(url).hostname} after ${tried.length} refusal(s): ${tried.join(', ')}`,
          );
        }
        return got;
      }
      tried.push(new URL(url).hostname);
    }
    this.logger.warn(
      `[icon] ${mint}: every source refused (${tried.join(', ')}) for ${stats.icon}`,
    );
    return null;
  }

  private async fetchOnce(url: string): Promise<IconAnswer | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const type = (res.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!type.startsWith('image/')) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
      return { contentType: type, bytes };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
