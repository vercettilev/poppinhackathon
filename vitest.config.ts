import path from "node:path"
import { defineConfig } from "vitest/config"

/**
 * `npm test` runs the recognition engine and nothing else.
 *
 * This repository is the code written after the pivot, and most of it is
 * one half of a conversation: a helper here calls a view that is part of
 * the shipped product, a controller there wants the Nest application it
 * lives in. Those files are published to be read, not to be run, and
 * pointing a test runner at them would produce failures that say nothing
 * about the code.
 *
 * The engine is the exception. It takes a string and returns an answer,
 * so it can be verified in isolation, and it is the part worth verifying.
 */
export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "extension-new/src"),
      "@spot-catalog": path.resolve(__dirname, "packages/spot-core/src/catalog/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: [
      "extension-new/src/entries/contentScript/x/xMatch.spec.ts",
      "extension-new/src/entries/contentScript/x/xSite.spec.ts",
      "extension-new/src/entries/contentScript/x/redditSite.spec.ts",
      "extension-new/src/entries/contentScript/x/newsSite.spec.ts",
      "extension-new/src/helpers/pageIsLight.spec.ts",
    ],
  },
})
