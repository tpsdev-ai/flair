// hub-url.test.ts — new pairings store the normalized hub URL; sync normalizes
// previously stored endpoints when sending. The pair and sync call sites are
// driven through the CLI with mocked `fetch` (hub and instance API responses
// are fakes) in federation-pair-cli.test.ts and federation-liveness-ping.test.ts.
import { describe, expect, test } from "bun:test";
import { normalizeHubUrl } from "../../src/lib/hub-url.ts";
import { isCanonicalRequestTarget } from "../../resources/request-target.ts";

describe("normalizeHubUrl", () => {
  for (const [typed, want] of [
    ["https://hub.example", "https://hub.example"],
    ["https://hub.example/", "https://hub.example"],
    ["https://hub.example///", "https://hub.example"],
    ["https://hub.example:9926/", "https://hub.example:9926"],
    ["https://hub.example/flair/", "https://hub.example/flair"],
    ["https://hub.example/flair", "https://hub.example/flair"],
  ] as const) {
    test(`${typed} → ${want}`, () => {
      expect(normalizeHubUrl(typed)).toBe(want);
      for (const route of ["/FederationPair", "/FederationSync"]) {
        const sent = new URL(`${normalizeHubUrl(typed)}${route}`);
        expect(isCanonicalRequestTarget(`${sent.pathname}${sent.search}`)).toBe(true);
      }
    });
  }
});
