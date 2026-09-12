/**
 * DIAGNOSTICS THAT SURVIVE THE PRODUCTION BUILD, AND A SWITCH A READER CAN
 * REACH.
 *
 * vite.config.ts lists console.log, console.debug, console.trace and
 * console.warn in esbuild's `pure` array, and production minifies, so every
 * one of those calls is DELETED from the shipped bundle. That is the right
 * default — a trading chip should not narrate itself into a stranger's
 * console on every page — but it also means the debug lines this codebase
 * writes to explain a silent failure have never once been readable in a real
 * browser. They appear in vitest output, which is not where a field report
 * comes from. Two investigations were planned around lines that could not
 * exist.
 *
 * console.info is deliberately not on that list, so it is what a diagnostic
 * that must survive uses, and it stays silent until somebody asks.
 *
 * THE ASKING IS A SWITCH IN SETTINGS, not a line typed into DevTools. The
 * first version of this said "run localStorage.setItem(...) in the console",
 * which is a developer's instruction handed to whoever is holding the bug —
 * and it was pasted straight into a shell, where it meant nothing. A person
 * reporting that a chip did not appear should be able to turn the
 * explanation on from the panel they already have open.
 *
 * chrome.storage.local, because Settings and the page are different worlds
 * and only extension storage is shared between them. Read once and then kept
 * current by the change listener, so flipping the switch takes effect on the
 * next chip rather than the next reload. localStorage stays as a developer's
 * escape hatch for a page where the extension context is gone.
 */
export const DEBUG_KEY = "poppin_debug"

let armed = false
let asked = false

const ask = (): void => {
  if (asked) return
  asked = true
  try {
    void chrome.storage.local.get(DEBUG_KEY).then((got) => {
      armed = got?.[DEBUG_KEY] === true
    })
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[DEBUG_KEY]) return
      armed = changes[DEBUG_KEY].newValue === true
    })
  } catch {
    // No extension context (an orphaned page, or a document with no
    // chrome.* at all). The escape hatch below still works.
  }
  try {
    if (localStorage.getItem("poppin:debug") === "1") armed = true
  } catch {
    // A content script shares the page's storage and some sites forbid it.
    // A diagnostic may never be the thing that breaks a chip.
  }
}

export const debugOn = (): boolean => {
  ask()
  return armed
}

export const dbg = (...parts: unknown[]): void => {
  if (!debugOn()) return
  console.info("[poppin]", ...parts)
}
