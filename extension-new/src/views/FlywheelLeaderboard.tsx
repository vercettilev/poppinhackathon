import { JUICE } from "~/theme/juice"
import { Avatar, Box, Collapse, Typography } from "@mui/material"
import { motion, useReducedMotion } from "framer-motion"
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { sendApiRequest } from "~/lib/fetchService"
import { ACCENT } from "~/helpers/panelSurface"

/**
 * The hero number counts UP to its value — the cheapest real dopamine in
 * the whole redesign, because a number that arrives is an event and a
 * number that sits there is a label. rAF, ease-out so the last points land
 * slowly (anticipation lives at the end), and reduced-motion readers get
 * the value instantly: the count is garnish, the number is the meal.
 */
function useCountUp(target: number, ms = 700): number {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(0)
  const fromRef = useRef(0)
  useEffect(() => {
    if (reduced) {
      setShown(target)
      return
    }
    const from = fromRef.current
    const t0 = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      const eased = 1 - (1 - k) ** 3
      setShown(from + (target - from) * eased)
      if (k < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms, reduced])
  return shown
}

/**
 * THE THREE VERBS THAT EARN. The old screen answered "how do points work"
 * with an eight-row table — honest, and the opposite of hypercasual: a
 * game explains itself in verbs, not a rate card. Three cards, the point
 * value as each card's hero, and every tap goes SOMEWHERE real. The full
 * table survives underneath, folded: the math stays public, it just stops
 * being the furniture.
 */
const EARN = [
  { label: "Trade", value: "1pt / $1", to: "/feed" },
  { label: "Share a trade", value: "+10", to: "/feed" },
  { label: "Bring a friend", value: "+25", to: "/referral" },
] as const

/**
 * The leaderboard, in the product's own visual language — the FOMO structure
 * the card already wears: near-black ground, one accent, big tabular numbers,
 * a podium for the top three because rank IS the reward right now.
 *
 * Three product decisions live in this file's shape:
 *
 *  - TWO PERIODS. "This week" is the race; "All time" is the savings account.
 *    A rolling window that deletes progress weekly was the design bug — nobody
 *    grinds a board that forgets them every Monday. All-time accrues from the
 *    flywheel's launch (server-side constant), not from the product's birth:
 *    the farm era stays history.
 *
 *  - THE MATH IS PUBLIC. "How points work" renders the server's own weight
 *    legend — the API ships it next to the weights, so what users read and
 *    what the scorer does cannot drift apart. An incentive nobody can see is
 *    not an incentive.
 *
 *  - YOUR ROW IS ALWAYS THERE. Pinned under the list when you are outside the
 *    top — a board you are not on tells you nothing about how far you are.
 */

interface Row {
  userId: string
  username: string | null
  displayName: string | null
  photoUrl: string | null
  points: number
  pointsAllTime: number
  /**
   * The two colors of a score, computed server-side for the WEEK window:
   * traded = money actually moved (and what cash rewards pay), social =
   * shares, posts, friends (what lifts rank). All-time rows carry zeros —
   * the server only partitions the week — so the split renders on the
   * week view only. Older servers may omit the fields; ?? 0 everywhere.
   */
  tradedPoints?: number
  socialPoints?: number
}

interface BoardResponse {
  period: "week" | "all"
  rows: Row[]
  viewer: Row | null
  viewerRank: number | null
  weights: Array<{ label: string; points: string }>
  /** null = your board counts from the very beginning (you were there);
   *  a date = your board counts from the relaunch. */
  allTimeSince: string | null
}

const PODIUM = ["#FFD666", "#C9D1D9", "#D4956A"] // gold, silver, bronze

export default function FlywheelLeaderboard() {
  const [period, setPeriod] = useState<"week" | "all">("week")
  const [data, setData] = useState<BoardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [showHow, setShowHow] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    sendApiRequest<BoardResponse>({
      // Top 5 + your own rank. A full table is a spreadsheet; five names and
      // "you are #23" is a race.
      url: `/flywheel/leaderboard?period=${period}&limit=5`,
      method: "GET",
    })
      .then((r) => alive && setData(r ?? null))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [period])

  const rows = data?.rows ?? []
  const viewer = data?.viewer ?? null
  const inTop = viewer && rows.some((r) => r.userId === viewer.userId)
  const name = (r: Row) => r.displayName || r.username || "anon"
  const pts = (r: Row) => (period === "all" ? r.pointsAllTime : r.points)
  const fmt = (n: number) =>
    n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString("en-US")

  const podium = rows.slice(0, 3)
  const rest = rows.slice(3)
  const navigate = useNavigate()
  const myPts = viewer ? pts(viewer) : 0
  const heroPts = useCountUp(myPts)
  const myRank = viewer
    ? (data?.viewerRank ?? rows.findIndex((r) => r.userId === viewer.userId) + 1)
    : null
  const first = myRank === 1

  return (
    // Own scroll context: the panel's shell does not scroll for its views, so
    // without this the content below the fold simply did not exist — which is
    // exactly how "How points work" shipped invisible.
    // flex:1 + minHeight:0, NOT height:100%. Layout's shell is a flex column
    // at 100svh with overflow:hidden; height:100% here measures the WHOLE
    // column including the header above, so the view claimed more room than
    // it was given, its bottom was clipped by the shell, and the last rows
    // were unreachable. Same bug the profile had.
    <Box sx={{ p: 2, flex: 1, minHeight: 0, overflowY: "auto", boxSizing: "border-box" }}>
      {/* ── Header + period switch ─────────────────────────────────────── */}
      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
        <Typography sx={{ fontSize: 19, fontWeight: 700, flex: 1 }}>
          Leaderboard
        </Typography>
        <Box
          sx={{
            display: "flex",
            gap: "2px",
            p: "2px",
            borderRadius: 999,
            backgroundColor: JUICE.well,
          }}
        >
          {(["week", "all"] as const).map((p) => (
            <Box
              key={p}
              onClick={() => setPeriod(p)}
              sx={{
                px: 1.5,
                py: 0.5,
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                color: period === p ? JUICE.onAccent : JUICE.text2,
                backgroundColor: period === p ? ACCENT : "transparent",
                transition: "background-color 150ms ease-out",
              }}
            >
              {p === "week" ? "This week" : "All time"}
            </Box>
          ))}
        </Box>
      </Box>

      {/* ── The other board, one door. /callers is a routable deep link
          (Discover already points at it), not a third period tab: this
          board ranks traders, that one ranks the tweets that moved them. */}
      <Typography
        onClick={() => navigate("/callers")}
        sx={{
          fontSize: 12,
          fontWeight: 600,
          color: JUICE.text3,
          cursor: "pointer",
          mt: -1.25,
          mb: 2,
          transition: "color 150ms ease-out",
          "&:hover": { color: ACCENT },
        }}
      >
        Callers →
      </Typography>

      {/* ── YOUR score is the game ──────────────────────────────────────
          One huge counting number, your face, your rank. The board below
          answers "against whom"; this answers "how am I doing" before a
          single row is read — which is the whole hypercasual contract. */}
      {!loading && viewer && (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 320, damping: 24 }}
        >
          <Box
            sx={{
              textAlign: "center",
              py: 2.25,
              mb: 2,
              borderRadius: "18px",
              backgroundColor: JUICE.well,
              border: `1px solid ${first ? "rgba(255,214,102,.4)" : "rgba(122,183,255,.14)"}`,
              boxShadow: first ? "0 0 26px -12px rgba(255,214,102,.55)" : "none",
            }}
          >
            <Avatar
              src={viewer.photoUrl ?? undefined}
              sx={{
                width: 46,
                height: 46,
                mx: "auto",
                mb: 1,
                border: `2px solid ${first ? "#FFD666" : ACCENT}`,
              }}
            >
              {name(viewer)[0]?.toUpperCase()}
            </Avatar>
            <Typography
              sx={{
                fontSize: 40,
                fontWeight: 800,
                lineHeight: 1.05,
                letterSpacing: "-0.02em",
                fontVariantNumeric: "tabular-nums",
                color: first ? "#FFD666" : JUICE.text,
              }}
            >
              {fmt(Math.round(heroPts * 10) / 10)}
            </Typography>
            <Typography sx={{ fontSize: 12, fontWeight: 700, color: JUICE.text3, mt: 0.25 }}>
              {myRank ? `#${myRank} ${period === "week" ? "this week" : "all time"}` : "points"}
            </Typography>
            {/*
              WHAT A POINT IS, WHERE THE NUMBER IS READ.
              Reported as "the score design isn't easily understandable",
              and the fold below is not the answer: a reader looking at 40px
              of digits should not have to open anything to learn the unit.

              This is also the honest headline rather than a simplification.
              The weights make volume 1 point per dollar while every social
              term is capped (70, 70, 200) specifically so no social week can
              outrun trading — so the score IS roughly dollars traded, and
              saying so is describing it, not rounding it off. The full
              twelve terms stay one tap down for anybody who wants them.
            */}
            <Typography sx={{ fontSize: 11.5, color: JUICE.text3, mt: 0.5 }}>
              1 point = $1 traded. Sharing and friends add on top.
            </Typography>

            {/* ── The two colors of the score ──────────────────────────
                One bar, two segments, two words: green is money you moved
                (and the half cash rewards pay), blue is everything social.
                Week view only — the server partitions the week window and
                sends zeros for all-time rows, and a zeroed bar is a lie.
                The caption is the entire economics lesson, one sentence,
                always visible: hypercasual means nobody opens a fold to
                learn which points pay. */}
            {period === "week" &&
              (() => {
                const traded = viewer.tradedPoints ?? 0
                const social = viewer.socialPoints ?? 0
                const total = traded + social
                if (!(total > 0)) return null
                // A side at exactly zero gets exactly no bar: painting a
                // 4% sliver above a label that reads "Social 0" is the
                // bar calling its own caption a liar. The 4..96 clamp is
                // only for keeping a small NONZERO minority visible.
                const share =
                  social === 0
                    ? 100
                    : traded === 0
                      ? 0
                      : Math.max(4, Math.min(96, (traded / total) * 100))
                return (
                  <Box sx={{ px: 3.5, mt: 1.25 }}>
                    <Box
                      sx={{
                        display: "flex",
                        height: 6,
                        borderRadius: 999,
                        overflow: "hidden",
                        backgroundColor: "rgba(122,183,255,.14)",
                      }}
                    >
                      <Box sx={{ width: `${share}%`, backgroundColor: "#30D158" }} />
                      <Box sx={{ flex: 1, backgroundColor: ACCENT }} />
                    </Box>
                    <Box sx={{ display: "flex", justifyContent: "space-between", mt: 0.5 }}>
                      <Typography sx={{ fontSize: 11, fontWeight: 700, color: "#30D158", fontVariantNumeric: "tabular-nums" }}>
                        Trading {fmt(Math.round(traded * 10) / 10)}
                      </Typography>
                      <Typography sx={{ fontSize: 11, fontWeight: 700, color: ACCENT, fontVariantNumeric: "tabular-nums" }}>
                        Social {fmt(Math.round(social * 10) / 10)}
                      </Typography>
                    </Box>
                    <Typography sx={{ fontSize: 10.5, fontWeight: 600, color: JUICE.text3, mt: 0.5 }}>
                      Cash rewards pay Trading points. Social points lift your rank.
                    </Typography>
                  </Box>
                )
              })()}
          </Box>
        </motion.div>
      )}

      {/* ── Earn: three verbs, three doors ──────────────────────────────── */}
      {!loading && (
        <Box sx={{ display: "flex", gap: 1, mb: 2 }}>
          {EARN.map((e, i) => (
            <motion.div
              key={e.label}
              style={{ flex: 1 }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i, type: "spring", stiffness: 380, damping: 26 }}
              whileTap={{ scale: 0.95 }}
            >
              <Box
                onClick={() => navigate(e.to)}
                sx={{
                  textAlign: "center",
                  py: 1.25,
                  px: 0.5,
                  borderRadius: "14px",
                  cursor: "pointer",
                  backgroundColor: JUICE.well,
                  border: "1px solid rgba(122,183,255,.10)",
                  transition: "border-color 150ms ease-out",
                  "&:hover": { borderColor: "rgba(104,198,255,.4)" },
                }}
              >
                <Typography
                  sx={{ fontSize: 16, fontWeight: 800, color: ACCENT, fontVariantNumeric: "tabular-nums" }}
                >
                  {e.value}
                </Typography>
                <Typography sx={{ fontSize: 11, fontWeight: 600, color: JUICE.text2, mt: 0.25 }}>
                  {e.label}
                </Typography>
              </Box>
            </motion.div>
          ))}
        </Box>
      )}

      {loading && (
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Loading…</Typography>
      )}
      {!loading && rows.length === 0 && (
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
          Nothing yet. First trade takes the top spot.
        </Typography>
      )}

      {/* ── Podium: the top three ARE the product right now ─────────────── */}
      {!loading && podium.length > 0 && (
        <Box sx={{ display: "flex", gap: 1, mb: 2, alignItems: "flex-end" }}>
          {/* visual order: 2nd, 1st, 3rd — the classic podium */}
          {[1, 0, 2].map((i) => {
            const r = podium[i]
            if (!r) return <Box key={i} sx={{ flex: 1 }} />
            const first = i === 0
            return (
              <Box
                key={r.userId}
                sx={{
                  flex: 1,
                  textAlign: "center",
                  py: first ? 2 : 1.25,
                  borderRadius: "14px",
                  backgroundColor: JUICE.well,
                  border: `1px solid ${first ? "rgba(255,214,102,.35)" : "rgba(122,183,255,.10)"}`,
                }}
              >
                <Avatar
                  src={r.photoUrl ?? undefined}
                  sx={{
                    width: first ? 44 : 34,
                    height: first ? 44 : 34,
                    mx: "auto",
                    mb: 0.75,
                    fontSize: 14,
                    border: `2px solid ${PODIUM[i]}`,
                  }}
                >
                  {name(r)[0]?.toUpperCase()}
                </Avatar>
                <Typography
                  sx={{
                    fontSize: 12,
                    fontWeight: 600,
                    px: 0.5,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name(r)}
                </Typography>
                <Typography
                  sx={{
                    fontSize: first ? 17 : 14,
                    fontWeight: 700,
                    color: PODIUM[i],
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmt(pts(r))}
                </Typography>
              </Box>
            )
          })}
        </Box>
      )}

      {/* ── The list ────────────────────────────────────────────────────── */}
      {rest.map((r, i) => (
        <Box
          key={r.userId}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            py: 1.25,
            borderBottom: "1px solid rgba(255,255,255,.06)",
            ...(viewer?.userId === r.userId && { color: ACCENT }),
          }}
        >
          <Typography
            sx={{ fontSize: 13, fontWeight: 700, width: 22, color: JUICE.text3, fontVariantNumeric: "tabular-nums" }}
          >
            {i + 4}
          </Typography>
          <Avatar src={r.photoUrl ?? undefined} sx={{ width: 26, height: 26, fontSize: 12 }}>
            {name(r)[0]?.toUpperCase()}
          </Avatar>
          <Typography
            sx={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {name(r)}
          </Typography>
          <Typography sx={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            {fmt(pts(r))}
          </Typography>
        </Box>
      ))}

      {/* ── You, always ─────────────────────────────────────────────────── */}
      {viewer && !inTop && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            py: 1.25,
            mt: 1,
            color: ACCENT,
            borderTop: "1px dashed rgba(255,255,255,.2)",
          }}
        >
          <Typography sx={{ fontSize: 13, fontWeight: 700, width: 22, fontVariantNumeric: "tabular-nums" }}>
            {data?.viewerRank ?? "—"}
          </Typography>
          <Avatar src={viewer.photoUrl ?? undefined} sx={{ width: 26, height: 26, fontSize: 12 }}>
            {name(viewer)[0]?.toUpperCase()}
          </Avatar>
          <Typography sx={{ fontSize: 14, fontWeight: 600, flex: 1 }}>you</Typography>
          <Typography sx={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            {fmt(pts(viewer))}
          </Typography>
        </Box>
      )}

      {/* ── The math: a toggle again, NOW THAT SCROLL WORKS. The first
          toggle's sin was hiding behind an unscrollable fold; with the fold
          fixed, click-to-open is the right weight — the board is the page,
          the math is the footnote you pull open and push shut. */}
      <Box
        onClick={() => setShowHow((v) => !v)}
        sx={{
          mt: 3,
          mb: 1,
          px: 1.5,
          py: 1,
          borderRadius: "10px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          backgroundColor: JUICE.well,
          transition: "background-color 150ms ease-out",
          "&:hover": { backgroundColor: "rgba(104,198,255,.10)" },
        }}
      >
        <Typography sx={{ fontSize: 12, fontWeight: 700, color: JUICE.text2, flex: 1 }}>
          How points work
        </Typography>
        <Typography sx={{ fontSize: 12, color: JUICE.text3 }}>
          {showHow ? "↑" : "→"}
        </Typography>
      </Box>
      <Collapse in={showHow}>
      <Box sx={{ borderRadius: "12px", backgroundColor: JUICE.well, p: 1.5, mb: 2 }}>
          {/* The split, said once in words for whoever opens the fold. The
              always-visible caption on the hero bar carries the same fact;
              this is the longer form, same colors as the bar. */}
          <Typography sx={{ fontSize: 12, color: JUICE.text2, mb: 1 }}>
            Points come in two colors.{" "}
            <Box component="span" sx={{ color: "#30D158", fontWeight: 700 }}>
              Trading
            </Box>{" "}
            points come from money you moved, and cash rewards pay those.{" "}
            <Box component="span" sx={{ color: ACCENT, fontWeight: 700 }}>
              Social
            </Box>{" "}
            points come from sharing and friends, and they lift your rank.
          </Typography>
          {(data?.weights ?? []).map((w) => (
            <Box key={w.label} sx={{ display: "flex", gap: 1, py: 0.5 }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600, minWidth: 130 }}>
                {w.label}
              </Typography>
              <Typography sx={{ fontSize: 12, color: JUICE.text2 }}>
                {w.points}
              </Typography>
            </Box>
          ))}
          <Typography sx={{ fontSize: 11, color: JUICE.text3, mt: 1 }}>
            Every point comes from a verified action — a trade we signed, a link
            we minted, a click that hit our servers.
            {data?.allTimeSince
              ? ` All-time counts from ${new Date(data.allTimeSince).toLocaleDateString("en-US", { month: "short", year: "numeric" })}, when the leaderboard launched.`
              : " All-time counts from the very beginning — you were here for it."}
          </Typography>
      </Box>
      </Collapse>
    </Box>
  )
}
