/**
 * Onboarding V2 switch — "önce ürün, sonra hesap, en son para".
 *
 * ON (default): install shows ONE screen (value line + permission grant) and
 * everything else moves to the moment of intent — the card itself walks a
 * reader through sign-in and top-up exactly when a trade needs them.
 *
 * OFF: the original six-screen welcome flow (permissions → sign-in → profile
 * → intro → fund → final) and the card's old behaviour, byte-for-byte — no
 * old code was deleted for V2. THE REVERT IS THIS FLAG:
 *
 *     NEXT_PUBLIC_ONBOARDING_V2=false  →  rebuild  →  old onboarding is back
 *
 * (.env.production line + one build; nothing else to touch.)
 */
const flagOn = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined ? dflt : v === "true"

export const ONBOARDING_V2: boolean = flagOn(
  process.env.NEXT_PUBLIC_ONBOARDING_V2,
  true,
)
