/**
 * THE TOP OF THE FUNNEL, WHICH HAS NEVER BEEN COUNTED.
 *
 * `page_scanned` exists in the backend enum, in the startup migration and in
 * the controller's accepted list, and nothing in the extension has ever
 * emitted it. So the funnel starts at card_shown: you can read how many
 * people SAW a chip and never what fraction of the chances we took. That is
 * the number that turns "$BULLSHIT does not show" from an anecdote into a
 * rate, and the reason three separate investigations into it had nothing to
 * stand on.
 *
 * ONE EVENT PER DOCUMENT, NOT PER TWEET. A row per examined cell would be
 * thousands of requests down an infinite scroll, which is a cost the reader
 * pays for our curiosity. The counts accumulate here and leave as a single
 * summary when the reader looks away, which is also when the answer is
 * complete rather than half-formed.
 *
 * WHAT IT COUNTS IS DECISIONS, NOT TWEETS. The denominator is cashtags the
 * strip actually reached a verdict on: one `shown` for a chip that mounted,
 * one reason for each that did not. Counting every cell instead would put
 * "500 tweets, 2 chips" on a feed where only two tweets ever mentioned an
 * asset, which reads as a catastrophe and means nothing.
 */
export interface ScanTally {
  /** A chip mounted. */
  shown(): void
  /** A cashtag reached a verdict and it was not a chip. */
  dropped(reason: string): void
  /** Send what has accumulated, if anything. Safe to call repeatedly. */
  flush(): void
  /** Stop the timers and listeners this installed. */
  stop(): void
}

export interface ScanTallyDeps {
  track(event: string, payload?: Record<string, unknown>): void
  /** The host being scanned, for the surface split the funnel already does. */
  host: string
  /** Overridable so a test does not wait a minute. */
  everyMs?: number
}

export function createScanTally(deps: ScanTallyDeps): ScanTally {
  let shown = 0
  const dropped = new Map<string, number>()
  let dirty = false
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  const flush = () => {
    if (!dirty) return
    const reasons: Record<string, number> = {}
    for (const [why, n] of dropped) reasons[why] = n
    const total = shown + [...dropped.values()].reduce((a, b) => a + b, 0)
    deps.track("x_page_scanned", {
      host: deps.host,
      decided: total,
      shown,
      dropped: reasons,
    })
    /* The counters are NOT reset. A summary is the state of this document so
       far, not a delta since the last one, so a reader who tabs away three
       times sends three snapshots of one page rather than three fragments
       that only mean something added together. The funnel counts actors and
       events separately and can tell those apart; fragments it could not. */
    dirty = false
  }

  const onHide = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      flush()
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onHide)
    // pagehide rather than unload: unload is unreliable on mobile and is
    // being retired, and this listener must never keep a page alive.
    window.addEventListener("pagehide", flush)
  }
  const everyMs = deps.everyMs ?? 60_000
  if (typeof setInterval === "function") {
    timer = setInterval(flush, everyMs)
  }

  return {
    shown() {
      if (stopped) return
      shown++
      dirty = true
    },
    dropped(reason) {
      if (stopped) return
      dropped.set(reason, (dropped.get(reason) ?? 0) + 1)
      dirty = true
    },
    flush,
    stop() {
      stopped = true
      if (timer !== null) clearInterval(timer)
      timer = null
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onHide)
        window.removeEventListener("pagehide", flush)
      }
    },
  }
}
