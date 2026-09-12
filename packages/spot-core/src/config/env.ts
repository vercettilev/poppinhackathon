/**
 * §14 "Env parsing" trap, handled once so no call site repeats it.
 *
 * Deployed env values arrive with surrounding quotes, stray whitespace, and
 * mixed case. But the correct handling is NOT uniform, and treating it as
 * uniform is how a fail-safe gets inverted. There are two classes of flag here
 * and they need opposite parsers:
 *
 *   FEATURE FLAG (readFeatureFlag) — turns a capability ON. Default off.
 *     Lenient: trim, strip quotes, lowercase, accept true/1/yes/on. The
 *     expensive failure mode is a flag that silently stays OFF, because
 *     someone then concludes the feature is broken. This is the posture
 *     `SunriseEnabledGuard.isEnabled()` settled on in commentin-mono, after
 *     `GeoBlockingService.embedGeoDisabled` was bitten by a strict
 *     `=== 'true'` against a Railway value carrying a quote/space/capital.
 *
 *   SAFETY FLAG (readSafetyFlag) — DISARMS a protection. Default armed.
 *     Strict: only the exact string 'false' lowers the guard. Not ' false',
 *     not 'FALSE', not '"false"', not '0', not 'no', not 'off'. The expensive
 *     failure mode here is the opposite one: a protection that silently comes
 *     DOWN because a value was typo'd or quoted. Being conservative means an
 *     operator who genuinely wants it off has to type it exactly, which is a
 *     cheap cost next to a guard that fell over on its own.
 *
 * A single lenient parser applied to a safety flag reads '0' / 'no' / 'off' as
 * false and takes the protection down — the exact inversion this split exists
 * to prevent. §8's fail-closed geofence uses readSafetyFlag.
 */

/** Strip wrapping quotes and whitespace. Returns undefined for empty. */
export function readEnv(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  let v = raw.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1).trim();
    }
  }
  return v.length > 0 ? v : undefined;
}

/**
 * A capability switch. Default OFF; anything recognisably affirmative turns it
 * on, through quotes, whitespace and case.
 *
 * Do NOT use this for anything that disarms a protection — see readSafetyFlag.
 */
export function readFeatureFlag(raw: string | undefined | null): boolean {
  const v = readEnv(raw)?.toLowerCase();
  if (v === undefined) return false;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * A protection switch, reported as "is the guard ARMED?".
 *
 * Returns true (armed) for every value except the exact string 'false'. The
 * env var is named for the protection, so `POPPIN_GEOFENCE=false` is the one
 * and only way to take it down.
 *
 * Deliberately does NOT trim, strip quotes, or lowercase. That asymmetry with
 * readFeatureFlag is the whole point: leniency here means a stray character
 * can disarm a guard, and every unrecognised value must resolve toward safety
 * rather than away from it.
 */
export function readSafetyFlag(raw: string | undefined | null): boolean {
  return raw !== 'false';
}

/** Integer env read with an explicit default and an inclusive range guard. */
export function readEnvInt(
  raw: string | undefined | null,
  defaultValue: number,
  opts: { min?: number; max?: number } = {},
): number {
  const v = readEnv(raw);
  if (v === undefined) return defaultValue;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return defaultValue;
  if (opts.min !== undefined && n < opts.min) return defaultValue;
  if (opts.max !== undefined && n > opts.max) return defaultValue;
  return n;
}

/** Comma-separated list, trimmed and de-emptied. */
export function readEnvList(raw: string | undefined | null): string[] {
  const v = readEnv(raw);
  if (v === undefined) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
