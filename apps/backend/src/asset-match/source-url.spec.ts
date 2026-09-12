import { tweetSourceOrNull } from './asset-match.controller';

/**
 * THE ONE FIELD SOMEBODY WILL EVENTUALLY FORGE. source_url funds caller
 * credit — points now, KOL receipts in weeks, possibly cash one day — so
 * its validator is the whole security model: an X status permalink and
 * nothing else. Off-shape records as NULL rather than refusing the trade,
 * because attribution is bookkeeping and bookkeeping must never cost a
 * reader their fill.
 */
describe('tweetSourceOrNull', () => {
  it('accepts exactly an X status permalink, either domain', () => {
    expect(tweetSourceOrNull('https://x.com/blknoiz06/status/2092930525736341836')).toBe(
      'https://x.com/blknoiz06/status/2092930525736341836',
    );
    expect(tweetSourceOrNull('https://twitter.com/a_b/status/1')).toBe(
      'https://twitter.com/a_b/status/1',
    );
  });

  it('nulls everything else, silently', () => {
    for (const bad of [
      'https://x.com/blknoiz06',                       // profile, not a status
      'https://t.co/abc',                              // shortener
      'https://evil.example/x.com/a/status/1',         // lookalike path
      'https://x.com.evil.example/a/status/1',         // lookalike host
      'http://x.com/a/status/1',                       // not https
      'https://x.com/a/status/1?ref=me',               // query smuggling
      `https://x.com/a/status/${'9'.repeat(30)}`,      // absurd id
      'x.com/a/status/1',                              // schemeless
      42,                                              // not even a string
      null,
      undefined,
    ]) {
      expect(tweetSourceOrNull(bad)).toBeNull();
    }
  });
});
