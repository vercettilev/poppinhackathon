/**
 * Extracted VERBATIM from wallet-ui.tsx (V2-PLAN.md Faz D). This file handles
 * real money: the split moved code, it did not edit it. The import block is
 * the original file's, shared by every sibling — unused lines cost nothing
 * and diffing against history stays trivial.
 */
import { JUICE } from "~/theme/juice"
import ArrowBackIcon from "@mui/icons-material/ArrowBack"
import ContentCopyIcon from "@mui/icons-material/ContentCopy"
import ExpandMore from "@mui/icons-material/ExpandMore"
import FileDownloadIcon from "@mui/icons-material/FileDownload"
import SearchIcon from "@mui/icons-material/Search"
import SwapHorizIcon from "@mui/icons-material/SwapHoriz"
import SwapVert from "@mui/icons-material/SwapVert"
import WalletIcon from "@mui/icons-material/Wallet"
import Visibility from "@mui/icons-material/Visibility"
import VisibilityOff from "@mui/icons-material/VisibilityOff"
import { ChainIcon } from "~/components/icons/ChainIcons"
import {
  alpha,
  Avatar,
  Box,
  Button,
  CircularProgress,
  darken,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputBase,
  lighten,
  Stack,
  TextField,
  Typography,
} from "@mui/material"
import { useTheme } from "@mui/material/styles"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { maxSwapFill, swappableUi } from "~/helpers/swapMax"
import { normalizeDecimal } from "~/helpers/decimalInput"
import { PANEL_PILL, PANEL_ROW, RED } from "~/helpers/panelSurface"
import { JUICE_BUY_FILL } from "~/theme/juice"
import { useToast } from "~/components/Toast/ToastProvider"
import { useCreateComment } from "~/hooks/useComments"
import { useCurrentUser } from "~/hooks/useCurrentUser"
import { useExecuteSwap, useSwapQuote } from "~/hooks/useTerminalTokens"
import { useUpdateProfile } from "~/hooks/useUpdateProfile"
import {
  useMyWallet,
  useProvisionWallets,
  useSOLPrice,
  useWalletBalance,
  useWalletTokens,
  useWalletTransactions,
} from "~/hooks/useWallet"
import { UserService } from "~/services/UserService"
import { WalletService } from "~/services/WalletService"
import ChainSelector, { ChainType } from "~/components/ChainSelector"
import { useChainStore } from "~/store/useChainStore"
import ArcTokenRow from "~/views/ArcTokenRow"
import ArcBridge from "~/views/ArcBridge"
import { ARC_ENABLED } from "~/config/arcChain"
import { useArcBalance } from "~/hooks/useArc"

import type { Token } from "./types"
import { WebsitePostService } from "~/services/WebsitePostService"
import { walletSwapReceipt } from "~/helpers/walletSwapReceipt"

interface SwapProps {
  setActiveTab: (
    tab:
      | "tokens"
      | "receive"
      | "send"
      | "send-final"
      | "swap"
  ) => void
  tokens: Token[]
  walletAddress: string
  preselectedToken?: Token | null
}

export function Swap(props: SwapProps) {
  const theme = useTheme()
  const { showToast } = useToast()
  const executeSwap = useExecuteSwap()

  const SOL_MINT = "So11111111111111111111111111111111111111112"
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

  /**
   * THE TOKEN LIST IS THE WALLET'S HOLDINGS — which is right for FROM (you
   * cannot swap what you do not hold) and wrong for TO: a wallet that holds
   * no USDC could never swap INTO it, and USDC is the one mint the whole
   * trading side spends. Reported live: "Swap'a basınca USDC çıkmıyor."
   * The destination list therefore always carries USDC, as a real row when
   * held and as this zero-balance seed when not. Same mint and decimals the
   * quote/execute path uses, so the synthetic row swaps like any other.
   */
  const usdcSeed: Token = {
    name: "USD Coin",
    symbol: "USDC",
    amount: "0",
    value: "-",
    change: "-",
    icon: "",
    iconBg: "#2775CA",
    mint: USDC_MINT,
    logoURI:
      "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
    decimals: 6,
  }
  const heldUsdc = props.tokens.find((t) => t.mint === USDC_MINT)
  const withUsdc = heldUsdc ? props.tokens : [usdcSeed, ...props.tokens]

  // State
  const [fromToken, setFromToken] = useState<Token | null>(
    props.preselectedToken || props.tokens[0] || null
  )
  // USDC is the default destination: the common errand here is "turn what
  // I hold into the money the buy button spends". Swapping FROM USDC keeps
  // the destination open instead.
  const [toToken, setToToken] = useState<Token | null>(() => {
    const from = props.preselectedToken || props.tokens[0] || null
    if (from?.mint === USDC_MINT) return null
    return heldUsdc ?? usdcSeed
  })
  const [fromAmount, setFromAmount] = useState("")
  const [toAmount, setToAmount] = useState("")
  const [isSwapping, setIsSwapping] = useState(false)
  /**
   * THE BEAT BETWEEN THE SWAP AND THE WAY BACK.
   *
   * On success the form was emptied and the screen sat there for 1500ms
   * before jumping to the token list - a second and a half of a blank form
   * that reads as "nothing happened", right after the one moment that did.
   * The button holds the outcome for exactly that beat instead, the same
   * way the card and the chip end a trade.
   */
  const [swapped, setSwapped] = useState(false)
  const [showFromTokenSelect, setShowFromTokenSelect] = useState(false)
  const [showToTokenSelect, setShowToTokenSelect] = useState(false)
  const [fromSearchQuery, setFromSearchQuery] = useState("")
  const [toSearchQuery, setToSearchQuery] = useState("")

  /**
   * The balance Swap may actually spend. `amountExact` because the display
   * string rounds (3.020272 SOL renders "3.0203" — more than exists, and
   * Max once submitted it verbatim); minus the fee reserve when the asset
   * being swapped away is SOL itself, because the backend keeps 0.001 SOL
   * for the transaction fee and refuses a swap that leaves nothing — the
   * fee has to come from somewhere. helpers/swapMax owns the arithmetic.
   */
  const exactAmount = fromToken
    ? (fromToken.amountExact ?? fromToken.amount)
    : "0"
  const fromDecimals = fromToken?.decimals ?? 9
  const availableBalance = swappableUi(exactAmount, fromDecimals, fromToken?.mint)

  // Calculate amount in smallest units (lamports for SOL, token decimals for others)
  const amountInSmallestUnit = useMemo(() => {
    const numAmount = parseFloat(fromAmount || "0")
    if (isNaN(numAmount) || numAmount <= 0) return "0"

    // Use actual token decimals (default to 9 if not available)
    const decimals = fromToken?.decimals || 9
    return Math.floor(numAmount * Math.pow(10, decimals)).toString()
  }, [fromAmount, fromToken])

  // Fetch swap quote
  const {
    data: quoteData,
    isLoading: isLoadingQuote,
    error: quoteError,
  } = useSwapQuote(
    fromToken?.mint || SOL_MINT,
    toToken?.mint || SOL_MINT,
    amountInSmallestUnit,
    50, // 0.5% slippage
    !!fromToken && !!toToken && parseFloat(fromAmount || "0") > 0
  )

  // Update toAmount when quote changes
  useEffect(() => {
    if (quoteData?.outputAmount && toToken) {
      const decimals = toToken.decimals || 9
      const outputAmount =
        parseFloat(quoteData.outputAmount) / Math.pow(10, decimals)
      setToAmount(outputAmount.toFixed(6))
    }
  }, [quoteData, toToken])

  /**
   * ONE LEG IS ALWAYS USDC — so this screen only ever offers a BUY or a
   * SELL, the same two verbs as every other surface in the product.
   *
   * It used to offer any held token for any held token. That is the exact
   * trade the ledger refuses to write (wallet-swap-leg.util.ts: "SOL -> X,
   * X -> Y neither: not written"), and the refusal was silent — the screen
   * toasted success while the position's cost basis, tracked quantity and
   * realized P&L all went wrong, permanently for the destination mint.
   *
   * Picking USDC on one side pins the other to everything; picking a token
   * on one side pins the other to USDC. The pair can no longer be invalid,
   * so the failure cannot be reached from the UI at all.
   */
  const pairFor = (other: Token | null) =>
    other && other.mint !== USDC_MINT
      ? withUsdc.filter((t) => t.mint === USDC_MINT)
      : withUsdc

  const filteredFromTokens = pairFor(toToken).filter(
    (token) =>
      token.name.toLowerCase().includes(fromSearchQuery.toLowerCase()) ||
      token.symbol.toLowerCase().includes(fromSearchQuery.toLowerCase())
  )

  const filteredToTokens = pairFor(fromToken).filter(
    (token) =>
      token.name.toLowerCase().includes(toSearchQuery.toLowerCase()) ||
      token.symbol.toLowerCase().includes(toSearchQuery.toLowerCase())
  )

  /**
   * The typed amount's dollar worth, for the footnote. Derived from the
   * row's own display value over its exact balance - display from display,
   * never fed back into any money math. USDC is its own dollar.
   */
  const fromUsdLine = useMemo(() => {
    if (!fromToken) return "\u00A0"
    const typed = parseFloat(fromAmount || "0")
    if (!(typed > 0)) return "\u00A0"
    if (fromToken.mint === USDC_MINT) return `\u2248 $${typed.toFixed(2)}`
    const held = parseFloat(fromToken.amountExact ?? fromToken.amount)
    const worth = parseFloat(String(fromToken.value).replace(/[$,]/g, ""))
    if (!(held > 0) || !Number.isFinite(worth) || worth <= 0) return "\u00A0"
    return `\u2248 $${((typed * worth) / held).toFixed(2)}`
  }, [fromToken, fromAmount])

  /** The quote's fine print: impact and the floor, only when known. */
  const quoteLine = useMemo(() => {
    if (!quoteData || !toToken) return ""
    const bits: string[] = []
    const impact = parseFloat(quoteData.priceImpact)
    if (Number.isFinite(impact)) bits.push(`price impact ${(impact * 100).toFixed(2)}%`)
    const dec = toToken.decimals || 9
    const minOut = parseFloat(quoteData.minimumReceived) / Math.pow(10, dec)
    if (Number.isFinite(minOut) && minOut > 0)
      bits.push(`at least ${minOut.toFixed(6)} ${toToken.symbol}`)
    return bits.join(" \u00B7 ")
  }, [quoteData, toToken])

  const isValid =
    fromToken &&
    toToken &&
    parseFloat(fromAmount || "0") > 0 &&
    parseFloat(fromAmount || "0") <= availableBalance

  function handleSetMaxAmount() {
    if (!fromToken) return
    setFromAmount(maxSwapFill(exactAmount, fromDecimals, fromToken.mint))
  }

  /**
   * Flip the DIRECTION, never the pairing. One leg is always USDC here, so
   * this turns a buy into a sell and back — it can no longer produce a
   * token-for-token pair, which is the one trade the ledger refuses to
   * record (apps/backend/src/spot/wallet-swap-leg.util.ts) and which used
   * to leave a position with no cost basis and a silent success toast.
   */
  function handleSwapTokens() {
    const tempToken = fromToken
    const tempAmount = fromAmount

    setFromToken(toToken)
    setToToken(tempToken)
    setFromAmount(toAmount)
    setToAmount(tempAmount)
  }

  async function handleSwap() {
    if (!isValid || !fromToken || !toToken) return

    setIsSwapping(true)

    try {
      const result = await executeSwap.mutateAsync({
        inputMint: fromToken.mint || SOL_MINT,
        outputMint: toToken.mint || SOL_MINT,
        amount: amountInSmallestUnit,
        slippageBps: 50,
      })

      // Names the money, no ceremony - the same voice as Send's "Sent 5 USDC".
      // Names the money in the same two verbs the button used.
      showToast(
        fromToken.mint === USDC_MINT
          ? `Bought ${toToken.symbol}`
          : `Sold ${fromAmount} ${fromToken.symbol}`,
        "success",
      )

      /**
       * THE FEED HEARS ABOUT IT, like every other surface's trade.
       *
       * Reported: a buy or a sell made here never reached the feed, while
       * the same trade made from the chip or the card did. One product, two
       * behaviours, decided by which screen the reader happened to be on.
       *
       * The decision of WHETHER this is a receipt at all, and what it says,
       * lives in walletSwapReceipt beside its tests — the same boundary the
       * ledger draws one layer down. Best effort and silent: a post that
       * does not land must never look like a trade that did not happen.
       */
      const receipt = walletSwapReceipt({
        from: fromToken,
        to: toToken,
        fromAmount,
        toAmount,
        signature: result?.signature ?? "",
      })
      if (receipt) {
        void WebsitePostService.create(receipt as never).catch(() => {})
      }

      // The outcome holds the button for the beat before the way back; the
      // form is cleared WITH the navigation, not before it, so the reader
      // never watches an empty form where their trade used to be.
      setSwapped(true)
      setTimeout(() => {
        setSwapped(false)
        setFromAmount("")
        setToAmount("")
        props.setActiveTab("tokens")
      }, 1500)
    } catch (error: any) {
      showToast(error?.message || "Swap failed", "error")
    } finally {
      setIsSwapping(false)
    }
  }

  return (
    <Box
      sx={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        // The PANEL's own ground. "#0e141d" was the terminal era's stage
        // color, and it made this one money room read as another product.
        backgroundColor: JUICE.groundDeep,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        padding: "14px 16px",
        overflowY: "auto",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          gap: "12px",
          alignItems: "center",
        }}
      >
        <IconButton
          onClick={() => props.setActiveTab("tokens")}
          sx={{
            marginRight: "6px",
            background: JUICE.well,
            width: "24px",
            height: "24px",
            borderRadius: "9999px",
            "&:hover": {
              opacity: 0.7,
            },
          }}
        >
          <ArrowBackIcon
            sx={{
              color: "#FFFFFF",
              fontSize: 16,
            }}
          />
        </IconButton>

        {/* The room's NAME, in the panel's own heading grammar - not a
            title-case chip that says "Tokens" about a screen that moves
            money. Same voice as "Deposit USDC" next door. */}
        <Typography sx={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.01em" }}>
          Buy &amp; Sell
        </Typography>
      </Box>

      <Box
        sx={{
          width: "100%",
          height: "1px",
          background: `linear-gradient(90deg, #FFFFFF33, #FFFFFF0D) border-box`,
          marginY: "10px",
        }}
      />

      {/* From Token */}
      <Box sx={{ marginBottom: "12px" }}>
        <Typography
          sx={{
            color: "#ADADAD",
            fontSize: "13px",
            fontWeight: "400",
            marginBottom: "8px",
          }}
        >
          From
        </Typography>
        <Box
          onClick={() => setShowFromTokenSelect(true)}
          sx={{
            width: "100%",
            padding: "10px",
            borderRadius: "15px",
            backgroundColor: "#0F0F16",
            border: "1px solid rgba(255,255,255,0.07)",
            display: "flex",
            alignItems: "center",
            cursor: "pointer",
            "&:hover": {
              opacity: 0.9,
            },
          }}
        >
          {fromToken ? (
            <>
              <Avatar
                src={fromToken.logoURI}
                sx={{
                  backgroundColor: fromToken.logoURI
                    ? "transparent"
                    : fromToken.iconBg,
                  borderRadius: "14px",
                  width: "45px",
                  height: "45px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "20px",
                  fontWeight: 700,
                }}
              >
                {!fromToken.logoURI && fromToken.icon}
              </Avatar>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  marginLeft: "10px",
                  justifyContent: "center",
                  flex: 1,
                }}
              >
                <Typography
                  sx={{
                    color: "#FFFFFF",
                    fontWeight: "700",
                    fontSize: "14px",
                  }}
                >
                  {fromToken.name}
                </Typography>
                <Typography
                  sx={{
                    color: JUICE.text3,
                    fontWeight: "400",
                    fontSize: "13px",
                    marginTop: "-6px",
                  }}
                >
                  {fromToken.symbol}
                </Typography>
              </Box>
              <ExpandMore sx={{ color: JUICE.text3, fontSize: 28 }} />
            </>
          ) : (
            <Typography
              sx={{ color: JUICE.text3, fontSize: "13px", fontWeight: "400" }}
            >
              Select token
            </Typography>
          )}
        </Box>

        {fromToken && (
          <Box sx={{ marginTop: "12px", position: "relative" }}>
            <Box sx={{ position: "relative" }}>
              {/*
                THE LOCALE RULE, HERE TOO. type="number" was the one amount
                field in the product that let the OS's decimal comma turn a
                paste into NaN and scroll-wheel a figure the reader never
                typed. Same normalizeDecimal road as the chip and the card,
                and the digits wear the data voice (rule 6: mono is for live
                data, and an amount being typed is the livest data there is).
              */}
              <InputBase
                fullWidth
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={fromAmount}
                onChange={(e) => {
                  const clean = normalizeDecimal(e.target.value)
                  setFromAmount(clean)
                }}
                sx={{
                  background: JUICE.well,
                  borderRadius: "14px",
                  height: "50px",
                  pl: "16px",
                  pr: "110px",
                  color: "#FFFFFF",
                  fontFamily: JUICE.mono,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: "15px",
                  fontWeight: 700,
                  "& input::placeholder": { color: JUICE.text3 },
                }}
              />
              <Box
                sx={{
                  position: "absolute",
                  right: "10px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <Typography sx={{ color: JUICE.text3, fontSize: "13px", fontWeight: 700 }}>
                  {fromToken.symbol}
                </Typography>
                <Box
                  component="button"
                  onClick={handleSetMaxAmount}
                  className="click-animation"
                  sx={{
                    ...PANEL_PILL,
                    border: "none",
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "#FFFFFF",
                    px: "10px",
                    py: "5px",
                  }}
                >
                  Max
                </Box>
              </Box>
            </Box>
            <Box
              sx={{
                display: "flex",
                marginTop: "10px",
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <Typography
                sx={{
                  color: JUICE.text3,
                  fontSize: "13px",
                  fontFamily: JUICE.mono,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {/* The TYPED amount's worth, not the whole holding's - the
                    old line printed the position's total value under an
                    amount field, which answered a question nobody asked
                    here. Display-derived price, display-only figure. */}
                {fromUsdLine}
              </Typography>
              <Box
                sx={{
                  background: JUICE.well,
                  borderRadius: "14px",
                  paddingY: "2px",
                  paddingX: "8px",
                  color: "#ADADAD",
                  fontSize: "14px",
                  fontWeight: "400",
                }}
              >
                {/* The SWAPPABLE amount, floored — not the raw balance.
                    Printing a number this screen then refuses to accept
                    ("Available 3.0203", max 3.0193) is the bug that put
                    the reserve arithmetic here in the first place. */}
                Available {(Math.floor(availableBalance * 1e4) / 1e4).toString()}{" "}
                {fromToken.symbol}
              </Box>
            </Box>
          </Box>
        )}
      </Box>

      {/* Swap Direction Button */}
      <Box sx={{ display: "flex", justifyContent: "center", margin: "6px 0" }}>
        <IconButton
          aria-label="Swap the two tokens"
          onClick={handleSwapTokens}
          disabled={!fromToken || !toToken}
          sx={{
            background: JUICE.well,
            width: "32px",
            height: "32px",
            "&:hover": {
              opacity: 0.8,
            },
            "&:disabled": {
              opacity: 0.4,
            },
          }}
        >
          <SwapVert sx={{ color: JUICE.accent, fontSize: 20 }} />
        </IconButton>
      </Box>

      {/* To Token */}
      <Box sx={{ marginBottom: "12px" }}>
        <Typography
          sx={{
            color: "#ADADAD",
            fontSize: "13px",
            fontWeight: "400",
            marginBottom: "8px",
          }}
        >
          To
        </Typography>
        <Box
          onClick={() => setShowToTokenSelect(true)}
          sx={{
            width: "100%",
            padding: "10px",
            borderRadius: "15px",
            backgroundColor: "#0F0F16",
            border: "1px solid rgba(255,255,255,0.07)",
            display: "flex",
            alignItems: "center",
            cursor: "pointer",
            "&:hover": {
              opacity: 0.9,
            },
          }}
        >
          {toToken ? (
            <>
              <Avatar
                src={toToken.logoURI}
                sx={{
                  backgroundColor: toToken.logoURI
                    ? "transparent"
                    : toToken.iconBg,
                  borderRadius: "14px",
                  width: "45px",
                  height: "45px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "20px",
                  fontWeight: 700,
                }}
              >
                {!toToken.logoURI && toToken.icon}
              </Avatar>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  marginLeft: "10px",
                  justifyContent: "center",
                  flex: 1,
                }}
              >
                <Typography
                  sx={{
                    color: "#FFFFFF",
                    fontWeight: "700",
                    fontSize: "14px",
                  }}
                >
                  {toToken.name}
                </Typography>
                <Typography
                  sx={{
                    color: JUICE.text3,
                    fontWeight: "400",
                    fontSize: "13px",
                    marginTop: "-6px",
                  }}
                >
                  {toToken.symbol}
                </Typography>
              </Box>
              <ExpandMore sx={{ color: JUICE.text3, fontSize: 28 }} />
            </>
          ) : (
            <Typography
              sx={{ color: JUICE.text3, fontSize: "13px", fontWeight: "400" }}
            >
              Select token
            </Typography>
          )}
        </Box>

        {toToken && (
          <Box sx={{ marginTop: "12px" }}>
            {/*
              A QUOTE IS A SENTENCE, NOT A FAKE INPUT. The old disabled
              TextField dressed the router's answer as something the reader
              could type into - an output wearing an input's clothes. The
              answer is a line now, in the data voice, with the two facts a
              quote owes: how far it can move the price, and the least that
              will arrive.
            */}
            <Box sx={{ ...PANEL_ROW, p: "12px 14px" }}>
              <Typography
                sx={{
                  color: "#FFFFFF",
                  fontFamily: JUICE.mono,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: "15px",
                  fontWeight: 700,
                }}
              >
                {isLoadingQuote
                  ? "Fetching quote\u2026"
                  : quoteError
                    ? "No route found"
                    : toAmount
                      ? `\u2248 ${toAmount} ${toToken.symbol}`
                      : "\u2014"}
              </Typography>
              {quoteData && !isLoadingQuote && !quoteError && (
                <Typography sx={{ color: JUICE.text3, fontSize: "11.5px", mt: "4px" }}>
                  {quoteLine}
                </Typography>
              )}
            </Box>
          </Box>
        )}
      </Box>

      <Box sx={{ flexGrow: 1 }} />

      {/* Error Message */}
      {quoteError &&
        fromToken &&
        toToken &&
        parseFloat(fromAmount || "0") > 0 && (
          <Box
            sx={{
              padding: "12px",
              borderRadius: "14px",
              backgroundColor: "rgba(255,69,58,.10)",
              border: "1px solid rgba(255,69,58,.30)",
              marginBottom: "12px",
            }}
          >
            <Typography sx={{ color: RED, fontSize: "13px", fontWeight: 600 }}>
              {quoteError?.message?.includes("Could not find any route")
                ? "No liquidity route found. Try a larger amount or different tokens."
                : quoteError?.message || "Failed to get quote"}
            </Typography>
          </Box>
        )}

      {/* The last control before money moves. It names the money and wears
          the direction: USDC in is a buy (green), USDC out is a sell (red).
          There is no third case any more — the pair is pinned to USDC on
          one side, so the token-for-token trade the ledger refuses cannot
          be composed here at all. */}
      {(() => {
        const buying = fromToken?.mint === USDC_MINT && toToken?.mint !== USDC_MINT
        const sellingSide = toToken?.mint === USDC_MINT && fromToken?.mint !== USDC_MINT
        const armed = Boolean(isValid && !isSwapping && !isLoadingQuote && !quoteError)
        // The success beat keeps the button's colour: a filled control that
        // says what just happened, not a greyed one that says nothing.
        const dressed = armed || swapped || isSwapping
        const ground = buying ? JUICE_BUY_FILL : RED
        const ink = buying ? JUICE.onBuyFill : "#FFFFFF"
        const label = swapped
          ? (buying ? `\u2713 Bought` : `\u2713 Sold`)
          : isSwapping
            ? (buying ? "Buying\u2026" : "Selling\u2026")
            : isLoadingQuote
            ? "Fetching quote\u2026"
            : !fromToken || !toToken
              ? "Select tokens"
              : parseFloat(fromAmount || "0") <= 0
                ? "Type an amount"
                : parseFloat(fromAmount || "0") > availableBalance
                  ? "Insufficient balance"
                  : quoteError
                    ? "No route available"
                    : buying
                      ? `Buy ${toToken.symbol} \u00B7 $${parseFloat(fromAmount).toFixed(2)}`
                      : `Sell ${fromAmount} ${fromToken.symbol}`
        return (
          <Button
            fullWidth
            disabled={!armed}
            onClick={handleSwap}
            sx={{
              height: "52px",
              background: swapped
                ? JUICE_BUY_FILL
                : dressed
                  ? ground
                  : "rgba(255,255,255,.08)",
              color: swapped ? JUICE.onBuyFill : dressed ? ink : "rgba(255,255,255,.4)",
              fontSize: "14px",
              fontWeight: 700,
              borderRadius: "999px",
              textTransform: "none",
              "&:hover": {
                background: dressed ? ground : "rgba(255,255,255,.08)",
                opacity: armed ? 0.92 : 1,
              },
              "&:disabled": swapped
                ? { background: JUICE_BUY_FILL, color: JUICE.onBuyFill }
                : isSwapping
                  ? { background: ground, color: ink, opacity: 0.75 }
                  : { background: "rgba(255,255,255,.08)", color: "rgba(255,255,255,.4)" },
            }}
          >
            {label}
          </Button>
        )
      })()}
      {/* The one number the screen owed and never said: the submit rides
          dynamic slippage capped at 300 bps server-side. */}
      <Typography sx={{ color: JUICE.text3, fontSize: "11px", textAlign: "center", mt: 1, mb: 0.5 }}>
        Fills within 3% of the quote, or not at all.
      </Typography>

      {/* From Token Selection Dialog */}
      <Dialog
        fullWidth
        open={showFromTokenSelect}
        onClose={() => setShowFromTokenSelect(false)}
        slotProps={{
          paper: {
            sx: {
              backgroundColor: "transparent",
              backdropFilter: "blur(8px)",
              borderRadius: "16px",
              padding: "24px",
              // NO FIXED FLOOR. 360px plus MUI's own 32px paper margins
              // demands 424px of panel, and the panel's supported minimum is
              // 320px — so this sheet was wider than the window it opens in
              // and its right edge was clipped. `fullWidth` on the Dialog
              // gives the paper calc(100% - 64px); the cap keeps the old
              // 360px wherever there is room for it.
              minWidth: 0,
              maxWidth: "360px",
              border: `1px solid ${alpha("#FFFFFF", 0.1)}`,
              boxShadow: `0 24px 60px ${alpha("#000", 0.6)}`,
            },
          },
        }}
      >
        <Typography
          sx={{
            color: "#FFFFFF",
            fontSize: "13px",
            fontWeight: 600,
            marginBottom: "20px",
          }}
        >
          Select Token
        </Typography>
        <Box
          sx={{
            backgroundColor: theme.palette.secondary.main,
            borderRadius: "14px",
            marginBottom: "20px",
            border: `1px solid ${lighten(theme.palette.secondary.main, 0.1)}`,
          }}
        >
          <InputBase
            fullWidth
            value={fromSearchQuery}
            onChange={(e) => setFromSearchQuery(e.target.value)}
            placeholder="Search tokens..."
            sx={{
              color: "#FFFFFF",
              fontSize: "14px",
              padding: "12px 16px",
              "& input": {
                padding: 0,
                "&::placeholder": {
                  // MEASURE ON THE FIELD'S OWN GROUND, NOT THE SHEET'S. The
                  // Box wrapping this input paints
                  // theme.palette.secondary.main, which themeHelper.ts:29
                  // resolves to JUICE.wellSolid #1B2534 — opaque, so the
                  // paper behind it never shows through. Measured there:
                  // #666666 was 2.69:1 and JUICE.text3 is only 4.05:1, both
                  // under AA for the 14px declared above. text2 is 5.94:1.
                  color: JUICE.text2,
                  opacity: 1,
                },
              },
            }}
          />
        </Box>
        <Box
          sx={{
            maxHeight: "400px",
            overflowY: "auto",
            "&::-webkit-scrollbar": {
              width: "6px",
            },
            "&::-webkit-scrollbar-track": {
              background: "transparent",
            },
            "&::-webkit-scrollbar-thumb": {
              background: "rgba(255, 255, 255, 0.2)",
              borderRadius: "3px",
            },
            "&::-webkit-scrollbar-thumb:hover": {
              background: "rgba(255, 255, 255, 0.3)",
            },
          }}
        >
          {filteredFromTokens.map((token) => (
            <Box
              key={token.mint || token.symbol}
              onClick={() => {
                setFromToken(token)
                setShowFromTokenSelect(false)
                setFromSearchQuery("")
              }}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "12px 16px",
                borderRadius: "14px",
                cursor: "pointer",
                marginBottom: "8px",
                backgroundColor: lighten(theme.palette.secondary.main, 0.02),
                border: `1px solid ${lighten(theme.palette.secondary.main, 0.05)}`,
                transition: "all 0.2s ease",
                "&:hover": {
                  backgroundColor: lighten(theme.palette.secondary.main, 0.08),
                  border: `1px solid ${lighten(theme.palette.secondary.main, 0.15)}`,
                },
              }}
            >
              {token.logoURI ? (
                <Box
                  component="img"
                  src={token.logoURI}
                  alt={token.symbol}
                  sx={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                  }}
                />
              ) : (
                <Avatar
                  sx={{
                    width: 36,
                    height: 36,
                    backgroundColor: token.iconBg,
                    fontSize: "16px",
                    fontWeight: 600,
                  }}
                >
                  {token.icon}
                </Avatar>
              )}
              {/* minWidth:0 is the whole fix: a flex item floors at
                  min-content by default, so `text-overflow: ellipsis` on the
                  children below could never fire and a long SPL name wrapped
                  instead — rows in one list at different heights. The balance
                  keeps its own width (flexShrink:0) so the name yields first. */}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  noWrap
                  sx={{
                    color: "#FFFFFF",
                    fontSize: "14px",
                    fontWeight: 600,
                  }}
                >
                  {token.symbol}
                </Typography>
                <Typography
                  noWrap
                  sx={{
                    color: JUICE.text2,
                    fontSize: "12px",
                  }}
                >
                  {token.name}
                </Typography>
              </Box>
              <Typography
                sx={{
                  color: "#FFFFFF",
                  fontSize: "14px",
                  fontWeight: 500,
                  flexShrink: 0,
                }}
              >
                {parseFloat(token.amount).toFixed(4)}
              </Typography>
            </Box>
          ))}
        </Box>
      </Dialog>

      {/* To Token Selection Dialog */}
      <Dialog
        fullWidth
        open={showToTokenSelect}
        onClose={() => setShowToTokenSelect(false)}
        slotProps={{
          paper: {
            sx: {
              backgroundColor: "transparent",
              backdropFilter: "blur(8px)",
              borderRadius: "16px",
              padding: "24px",
              // NO FIXED FLOOR. 360px plus MUI's own 32px paper margins
              // demands 424px of panel, and the panel's supported minimum is
              // 320px — so this sheet was wider than the window it opens in
              // and its right edge was clipped. `fullWidth` on the Dialog
              // gives the paper calc(100% - 64px); the cap keeps the old
              // 360px wherever there is room for it.
              minWidth: 0,
              maxWidth: "360px",
              border: `1px solid ${alpha("#FFFFFF", 0.1)}`,
              boxShadow: `0 24px 60px ${alpha("#000", 0.6)}`,
            },
          },
        }}
      >
        <Typography
          sx={{
            color: "#FFFFFF",
            fontSize: "13px",
            fontWeight: 600,
            marginBottom: "20px",
          }}
        >
          Select Token
        </Typography>
        <Box
          sx={{
            backgroundColor: theme.palette.secondary.main,
            borderRadius: "14px",
            marginBottom: "20px",
            border: `1px solid ${lighten(theme.palette.secondary.main, 0.1)}`,
          }}
        >
          <InputBase
            fullWidth
            value={toSearchQuery}
            onChange={(e) => setToSearchQuery(e.target.value)}
            placeholder="Search tokens..."
            sx={{
              color: "#FFFFFF",
              fontSize: "14px",
              padding: "12px 16px",
              "& input": {
                padding: 0,
                "&::placeholder": {
                  // MEASURE ON THE FIELD'S OWN GROUND, NOT THE SHEET'S. The
                  // Box wrapping this input paints
                  // theme.palette.secondary.main, which themeHelper.ts:29
                  // resolves to JUICE.wellSolid #1B2534 — opaque, so the
                  // paper behind it never shows through. Measured there:
                  // #666666 was 2.69:1 and JUICE.text3 is only 4.05:1, both
                  // under AA for the 14px declared above. text2 is 5.94:1.
                  color: JUICE.text2,
                  opacity: 1,
                },
              },
            }}
          />
        </Box>
        <Box
          sx={{
            maxHeight: "400px",
            overflowY: "auto",
            "&::-webkit-scrollbar": {
              width: "6px",
            },
            "&::-webkit-scrollbar-track": {
              background: "transparent",
            },
            "&::-webkit-scrollbar-thumb": {
              background: "rgba(255, 255, 255, 0.2)",
              borderRadius: "3px",
            },
            "&::-webkit-scrollbar-thumb:hover": {
              background: "rgba(255, 255, 255, 0.3)",
            },
          }}
        >
          {filteredToTokens.map((token) => (
            <Box
              key={token.mint || token.symbol}
              onClick={() => {
                setToToken(token)
                setShowToTokenSelect(false)
                setToSearchQuery("")
              }}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "12px 16px",
                borderRadius: "14px",
                cursor: "pointer",
                marginBottom: "8px",
                backgroundColor: lighten(theme.palette.secondary.main, 0.02),
                border: `1px solid ${lighten(theme.palette.secondary.main, 0.05)}`,
                transition: "all 0.2s ease",
                "&:hover": {
                  backgroundColor: lighten(theme.palette.secondary.main, 0.08),
                  border: `1px solid ${lighten(theme.palette.secondary.main, 0.15)}`,
                },
              }}
            >
              {token.logoURI ? (
                <Box
                  component="img"
                  src={token.logoURI}
                  alt={token.symbol}
                  sx={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                  }}
                />
              ) : (
                <Avatar
                  sx={{
                    width: 36,
                    height: 36,
                    backgroundColor: token.iconBg,
                    fontSize: "16px",
                    fontWeight: 600,
                  }}
                >
                  {token.icon}
                </Avatar>
              )}
              {/* minWidth:0 is the whole fix: a flex item floors at
                  min-content by default, so `text-overflow: ellipsis` on the
                  children below could never fire and a long SPL name wrapped
                  instead — rows in one list at different heights. The balance
                  keeps its own width (flexShrink:0) so the name yields first. */}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  noWrap
                  sx={{
                    color: "#FFFFFF",
                    fontSize: "14px",
                    fontWeight: 600,
                  }}
                >
                  {token.symbol}
                </Typography>
                <Typography
                  noWrap
                  sx={{
                    color: JUICE.text2,
                    fontSize: "12px",
                  }}
                >
                  {token.name}
                </Typography>
              </Box>
              <Typography
                sx={{
                  color: "#FFFFFF",
                  fontSize: "14px",
                  fontWeight: 500,
                  flexShrink: 0,
                }}
              >
                {parseFloat(token.amount).toFixed(4)}
              </Typography>
            </Box>
          ))}
        </Box>
      </Dialog>
    </Box>
  )
}
