# Poppin — the recognition engine

Poppin puts Buy and Sell buttons inside the page you are already reading. You see a post about Tesla on X, Reddit or a news site, and you buy TSLAx right there, in USDC, on Solana.

The hard part of that product is not the buttons. It is knowing **when to show them** and, far more often, **when to stay quiet**.

This repository is that part.

## What is in here

```
src/match/xMatch.ts    the engine: five tiers of evidence, in descending confidence
src/match/xMatch.spec.ts   72 tests, each one a rule the engine is not allowed to break
src/catalog/index.ts   the asset catalog: tokenized equities and Solana assets
```

Clone it and run the tests. Everything below is enforced by them.

```
npm install
npm test
```

## The problem

A page is a hostile place to guess. "I ate an apple" is a breakfast. "apple earnings tomorrow, loading up" is a position. "I'm packing my backpack" is luggage; "holding backpack, bullish" is a bag. The same word carries a trade in one sentence and nothing at all in the next, and the cost of the two mistakes is not symmetric: a missing button loses one trade, while a button under every noun turns the product into wallpaper and loses the reader permanently.

So the engine is built to be *reluctant*. It asks for evidence, ranks it, and takes the strongest available answer rather than the first one it finds.

## How it decides

Five tiers, strongest first:

1. **Cashtag.** `$NVDA` is a person naming an asset on purpose. Nothing beats it.
2. **Dollar amount.** A figure attached to a name is someone sizing a position.
3. **The account.** An account that *is* an asset is the least ambiguous evidence on a page. When Tesla posts, the page is about Tesla. This tier also reads mentions, so a post about `@Pumpfun` resolves even when the body never spells the name.
4. **Curated names, matched case-sensitively.** "Apple" is a company and "apple" is fruit, and that distinction is carried by the capital letter alone.
5. **Ordinary words, but only inside a sentence about a trade.** The weakest evidence, admitted only when the surrounding sentence vouches for it.

Two guards sit across the whole thing. An **author whose handle names an asset** vouches narrowly, for their own asset only, never for the rest of the list. And a name that appears three times on one screen stops producing buttons, because a screen papered in the same chip is worse than no chip.

## Why the comments are long

Roughly half of `xMatch.ts` is prose. Each block records a case that was measured on a live page and the rule that came out of it: the account that announced its own airdrop and mentioned itself nowhere in the body, the thread headed "ORE Liquidity" that got nothing because the evidence was the author rather than the text, the ticker that is also an English verb. The tests are written the same way. They are the specification, and the comments are why each line of it exists.

## What is not in here

The product. Poppin is a Chrome extension with a custodial wallet, sponsored gas, Jupiter routing and a trading backend, and that backend stays private because it holds custody logic. What is published here is the piece that is worth reading rather than the piece that is worth hiding: the judgment layer, with its full test suite, runnable in one command.
