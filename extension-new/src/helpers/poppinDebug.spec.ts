import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The point of this module is that its output SURVIVES the production build,
 * where console.log/debug/warn are deleted by esbuild's pure list. A test
 * cannot observe minification, so what it pins instead is the two properties
 * that made the old lines useless: the method used, and the fact that it
 * stays quiet until somebody asks.
 */
const load = async () => {
  vi.resetModules()
  return import("./poppinDebug")
}

let store: Record<string, string> = {}
let ext: Record<string, unknown> = {}
let listener: ((c: Record<string, { newValue: unknown }>, a: string) => void) | null = null

beforeEach(() => {
  store = {}
  ext = {}
  listener = null
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    },
  })
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: async (k: string) => ({ [k]: ext[k] }) },
      onChanged: {
        addListener: (fn: typeof listener) => {
          listener = fn
        },
      },
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the diagnostic channel", () => {
  it("says nothing until a reader asks for it", async () => {
    const { dbg } = await load()
    const spy = vi.spyOn(console, "info").mockImplementation(() => {})
    dbg("no chip for $BULLSHIT: the server has no tradeable mint")
    // Every reader's console would otherwise carry our reasoning on every
    // page. The chip is a guest there.
    expect(spy).not.toHaveBeenCalled()
  })

  it("speaks on console.info, which production keeps", async () => {
    store["poppin:debug"] = "1"
    const { dbg } = await load()
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    dbg("icon fetch failed for WIF")
    // console.debug is on vite's pure list and is deleted from the shipped
    // bundle; console.info is not. Using the wrong one is exactly how two
    // investigations came to be planned around lines that could not exist.
    expect(info).toHaveBeenCalledOnce()
    expect(debug).not.toHaveBeenCalled()
    expect(String(info.mock.calls[0][0])).toContain("[poppin]")
  })

  it("survives a page that forbids storage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError")
      },
    })
    const { dbg } = await load()
    // A content script shares the page's storage and some sites block it
    // outright. A diagnostic may not be the thing that breaks a chip.
    expect(() => dbg("anything")).not.toThrow()
  })

  it("reads the flag once, not on every line", async () => {
    store["poppin:debug"] = "1"
    const { dbg } = await load()
    let reads = 0
    vi.stubGlobal("localStorage", {
      getItem: () => {
        reads++
        return "1"
      },
    })
    vi.spyOn(console, "info").mockImplementation(() => {})
    dbg("a")
    dbg("b")
    dbg("c")
    // Three lines, ONE read: the first call caches the answer for the life of
    // the document. These paths run per chip and per mount, and a storage hit
    // each time is a real cost for a line that is usually off.
    expect(reads).toBe(1)
  })

  it("turns on from the panel's switch, not from a typed console line", async () => {
    ext["poppin_debug"] = true
    const { dbg } = await load()
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    // The read is async, so the first line after boot can still be silent;
    // what matters is that the extension's own storage arms it at all.
    dbg("first")
    await Promise.resolve()
    await Promise.resolve()
    dbg("no chip for $BULLSHIT: the cell was recycled")
    expect(info).toHaveBeenCalled()
  })

  it("follows the switch without waiting for a reload", async () => {
    const { dbg } = await load()
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    dbg("before")
    await Promise.resolve()
    expect(info).not.toHaveBeenCalled()
    // Settings writes the key; the chip is already mounted on a page that
    // will not be reloaded, so the change event is what makes the switch
    // worth having.
    listener?.({ poppin_debug: { newValue: true } }, "local")
    dbg("after")
    expect(info).toHaveBeenCalledOnce()
  })
})
