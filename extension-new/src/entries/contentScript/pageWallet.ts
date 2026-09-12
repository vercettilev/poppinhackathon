/**
 * THE PAGE'S WALLET, REACHED FROM OUR ISOLATED WORLD.
 *
 * Phantom injects `window.solana` into the page's MAIN world. Content scripts
 * live in an isolated world and cannot see it — which is why the panel can
 * never touch a wallet, and why this shim exists for the surfaces that can:
 * the chip and the card, on a real page.
 *
 * WHAT IT IS FOR, and what it is deliberately not. It exists so somebody
 * whose Poppin balance ran out mid-buy can move USDC in from the wallet they
 * already have, with ONE approval, without leaving the tweet. It is NOT a
 * second trading path: the transaction it signs is built by our backend and
 * is a plain USDC transfer into the reader's own custodial account, which is
 * the one thing a wallet popup can show clearly. Trading itself stays where
 * every surface agrees on it.
 *
 * ── THE PROTOCOL IS NARROW ON PURPOSE ───────────────────────────────────────
 * Anything in the MAIN world is reachable by the page, so this answers three
 * questions and nothing else: is there a wallet, connect it, sign this exact
 * base64 transaction. It holds no state the page could read, exposes no
 * global, and every reply carries the id of the request it answers so a
 * page's own postMessage traffic cannot be mistaken for ours.
 */

interface WalletReq {
  type: "POPPIN_WALLET_REQ"
  id: string
  op: "probe" | "connect" | "sign"
  tx?: string
}

type Provider = {
  connect?: () => Promise<{ publicKey: { toString(): string } }>
  signAndSendTransaction?: (tx: unknown) => Promise<{ signature: string }>
  isPhantom?: boolean
}

function provider(): Provider | null {
  const w = window as unknown as Record<string, any>
  const p = w.phantom?.solana ?? w.solana ?? w.solflare
  return p?.connect && p?.signAndSendTransaction ? (p as Provider) : null
}

function reply(id: string, body: Record<string, unknown>) {
  window.postMessage({ type: "POPPIN_WALLET_RES", id, ...body }, "*")
}

window.addEventListener("message", (event) => {
  // Same-window only. A message from a frame we did not create is not ours.
  if (event.source !== window) return
  const msg = event.data as WalletReq | null
  if (msg?.type !== "POPPIN_WALLET_REQ" || typeof msg.id !== "string") return

  const p = provider()
  if (msg.op === "probe") {
    reply(msg.id, { present: !!p })
    return
  }
  if (!p) {
    reply(msg.id, { error: "no-wallet" })
    return
  }

  if (msg.op === "connect") {
    p.connect!()
      .then((r) => reply(msg.id, { address: r.publicKey.toString() }))
      // A closed popup is a decision, and it reaches the caller as the same
      // "cancelled" every other refusal does.
      .catch(() => reply(msg.id, { error: "cancelled" }))
    return
  }

  if (msg.op === "sign" && typeof msg.tx === "string") {
    // Decoded HERE rather than passed as bytes: a structured clone of a
    // Transaction across the world boundary loses its prototype, and the
    // wallet is handed an object it cannot read.
    void (async () => {
      try {
        const bytes = Uint8Array.from(atob(msg.tx!), (c) => c.charCodeAt(0))
        // web3.js is already in this bundle's graph on the page side; the
        // wallet needs a real Transaction, so build one from the wire bytes.
        const { Transaction } = await import("@solana/web3.js")
        const { signature } = await p.signAndSendTransaction!(
          Transaction.from(bytes),
        )
        reply(msg.id, { signature })
      } catch (e) {
        const code = (e as { code?: number } | null)?.code
        reply(msg.id, { error: code === 4001 ? "cancelled" : "failed" })
      }
    })()
  }
})
