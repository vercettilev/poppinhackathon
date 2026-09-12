/**
 * Connecting X (settings button, onboarding step, the identity step's door,
 * and the "Connect Your Twitter" task) is off.
 *
 * Not a code problem, and never was: GET /2/users/me — the one call every
 * surface makes to read back the linked handle — 403s with
 * client-not-enrolled, because the X app's Project has no paid access.
 *
 * WHAT CHANGED, measured 2026-08-26 against docs.x.com itself: the "$200/mo
 * cheapest plan" this comment used to name is gone. X retired subscriptions
 * on 2026-02-06 and moved everyone, legacy Basic included, to PAY-PER-USE:
 * credits bought upfront, no monthly minimum, no contract, a spend cap you
 * set yourself. A user read is $0.010 and an "owned" read $0.001, and this
 * product's whole appetite is ONE users/me per person, once, at the moment
 * they press connect. A thousand people linking X costs somewhere between
 * one and ten dollars, forever.
 *
 * So the wall is no longer the price. What is still missing is only the
 * setup: OAuth 2.0 credentials in X_CLIENT_ID/X_CLIENT_SECRET (backend),
 * https://api.poppin.so/api/v1/auth/x/callback registered on the X app, the
 * app attached to a Project, and a little credit loaded.
 *
 * Flip this back on once that is done — nothing else needs to change; every
 * surface already checks it, and the backend refuses honestly until its own
 * credentials exist (see x-oauth.controller).
 */
export const CONNECT_X_ENABLED = false
