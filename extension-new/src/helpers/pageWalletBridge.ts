/**
 * The isolated-world half of the page-wallet bridge (see
 * entries/contentScript/pageWallet.ts for the MAIN-world half and for why
 * this exists at all).
 *
 * Promise-shaped over a postMessage protocol, with a timeout on every call:
 * the other side is a script we injected into somebody else's page, and a
 * page that never answers must not leave a button spinning forever.
 */

type Res = Record<string, unknown>

let seq = 0

function ask(op: "probe" | "connect" | "sign", tx?: string, timeoutMs = 60_000) {
  return new Promise<Res>((resolve) => {
    const id = `pw-${Date.now()}-${++seq}`
    let done = false
    const finish = (body: Res) => {
      if (done) return
      done = true
      window.removeEventListener("message", onMsg)
      clearTimeout(timer)
      resolve(body)
    }
    const onMsg = (event: MessageEvent) => {
      if (event.source !== window) return
      const d = event.data as { type?: string; id?: string } | null
      if (d?.type !== "POPPIN_WALLET_RES" || d.id !== id) return
      finish(d as Res)
    }
    // Connect and sign both wait on a HUMAN in a wallet popup, so the
    // timeout is generous; probe answers in a tick or not at all.
    const timer = setTimeout(
      () => finish({ error: "timeout" }),
      op === "probe" ? 800 : timeoutMs,
    )
    window.addEventListener("message", onMsg)
    window.postMessage({ type: "POPPIN_WALLET_REQ", id, op, tx }, "*")
  })
}

/** Is there an injected Solana wallet on this page? */
export async function hasPageWallet(): Promise<boolean> {
  return (await ask("probe")).present === true
}

/** Connect, returning the address or null if they closed the popup. */
export async function connectPageWallet(): Promise<string | null> {
  const r = await ask("connect")
  return typeof r.address === "string" ? r.address : null
}

/** Sign and send a backend-built transaction; null means it did not happen. */
export async function signWithPageWallet(txBase64: string): Promise<string | null> {
  const r = await ask("sign", txBase64)
  return typeof r.signature === "string" ? r.signature : null
}
