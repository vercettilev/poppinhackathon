import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A KEY THE SERVER INVENTS IS NOT A KEY.
 *
 * Every money route here read `body.idempotencyKey?.trim() || randomUUID()`
 * under a comment saying a missing key "would let a double-submit buy
 * twice". A freshly random key PER REQUEST is exactly what lets a
 * double-submit buy twice: two presses arrive as two different keys and
 * both go through. The fallback protected the type, not the trade — and it
 * silenced trade-safety's own "dedup disabled" warning, so the logs read
 * healthy on every buy that had no protection at all.
 *
 * The root cause was a type that could not say "unknown": the service
 * signatures required a string, so something had to be supplied.
 */
const SRC = readFileSync(join(__dirname, 'asset-match.controller.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('idempotency keys', () => {
  it('are never minted by the server', () => {
    expect(CODE).not.toMatch(/idempotencyKey\s*=\s*[^;]*randomUUID\(\)/);
    expect(CODE).not.toContain('randomUUID');
  });

  it('pass the client\'s key through, or nothing', () => {
    const sites = CODE.match(
      /const idempotencyKey = body\?\.idempotencyKey\?\.trim\(\) \|\| undefined;/g,
    );
    // swap, sell, order, order/cancel — every route that moves or parks money.
    expect(sites?.length).toBe(4);
  });

  it('leaves the absent case to trade-safety, which warns', () => {
    // beginTrade logs "dedup disabled for this request" and proceeds. That
    // is the honest state for an old client, and the state the invented
    // key was hiding.
    const svc = readFileSync(
      join(__dirname, '../trade-safety/trade-safety.service.ts'),
      'utf8',
    );
    expect(svc).toMatch(/NO idempotencyKey/);
    expect(svc).toMatch(/return \{ proceed: true, replaySignature: null \}/);
  });
});
