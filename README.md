# Poppin

Poppin lets you buy and sell tokenized stocks inside the tweet, the Reddit post or the news headline you are already reading. You see a post about Tesla on X, and you buy TSLAx right there, in USDC, on Solana. No new tab, no order form, no wallet popup, and the gas is on us.

**[Install it from the Chrome Web Store](https://chromewebstore.google.com/detail/poppin-trade-on-your-feed/chhcknncbbmnmhkaacbkfdmkahaemdkk)**. It is live today, and everything described here is what is actually running.

This repository is the code written **after the pivot**: on 12 August 2026 Poppin stopped being a prediction-market product and became a trading one, and everything here was written since. Nothing from before that date is included, which is why some files reach for a neighbour that is not in the tree.

## What is here

```
extension-new/src/entries/contentScript/   the strip: what runs inside X, Reddit and news pages
extension-new/src/helpers/                 the pure logic, and most of the tests
extension-new/src/components/              the trade sheet, the profile, the money surfaces
extension-new/src/views/                   panel screens
packages/spot-core/                        the asset catalog: tokenized equities and Solana assets
apps/backend/src/asset-match/              the server side of recognition
```

Roughly three hundred files, a month of work.

## Run it

```
npm install
npm test
```

That runs 91 rules the recognition engine and the two site adapters are not allowed to break. These are the parts that stand alone: they take a page, or a string, and return an answer. The rest of the source is published to be read rather than executed, since the product it belongs to is not.

## The hard part

The hard part of this product is not the buttons. It is knowing **when to show them** and, far more often, **when to stay quiet**.

A page is a hostile place to guess. "I ate an apple" is a breakfast. "apple earnings tomorrow, loading up" is a position. "I am packing my backpack" is luggage; "holding backpack, bullish" is a bag. The same word carries a trade in one sentence and nothing in the next, and the two mistakes do not cost the same: a missing button loses one trade, while a button under every noun turns the product into wallpaper and loses the reader for good.

So the engine is built to be reluctant. It ranks evidence and takes the strongest available answer rather than the first one it finds:

1. **Cashtag.** `$NVDA` is a person naming an asset on purpose. Nothing beats it.
2. **Dollar amount.** A figure attached to a name is someone sizing a position.
3. **The account.** An account that *is* an asset is the least ambiguous evidence on a page. When Tesla posts, the page is about Tesla. Mentions count too, so a post about `@Pumpfun` resolves even when the body never spells the name.
4. **Curated names, matched case-sensitively.** "Apple" is a company and "apple" is fruit, and the capital letter is the whole of that distinction.
5. **Ordinary words, but only inside a sentence about a trade.** The weakest evidence, admitted only when the surrounding sentence vouches for it.

Two guards sit across all of it. An author whose handle names an asset vouches narrowly, for their own asset and never for the rest of the list. And a name already on screen three times stops producing buttons, because a screen papered in one chip is worse than no chip at all.

## Why the comments are long

About half of `xMatch.ts` is prose, and the same is true of much of the rest. Each block records a case measured on a live page and the rule that came out of it: the account that announced its own airdrop and mentioned itself nowhere in the body, the thread headed "ORE Liquidity" that got nothing because the evidence was the author rather than the text, the ticker that is also an English verb, the font the manifest never exposed so the browser faked the weight for weeks. The tests are written the same way. They are the specification, and the comments are the reason each line of it exists.

## What it stands on

We do not create any of these assets. The listed companies come from **xStocks**, the ones that have not gone public come from **PreStocks**, and **Jupiter** handles the routing.

That matters more than it sounds. A broker cannot put their app inside someone else's web page, so nobody can build this on top of a brokerage. It works because the stock is just a token on Solana. And when someone tokenizes a new company, it shows up in Poppin without us doing anything.

## What is not here

The custody layer. Poppin holds wallets, sponsors gas and signs transactions, and that code stays private: the custodial signer, the gas tank, the funding and auth paths. What is published is the judgment layer and the surfaces around it, which is the part worth reading rather than the part worth hiding.
