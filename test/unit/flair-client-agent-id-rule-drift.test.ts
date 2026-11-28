/**
 * flair-client-agent-id-rule-drift.test.ts — flair#3188.
 *
 * `@tpsdev-ai/flair-client` is a standalone published package and cannot import
 * the repo's `src/lib/agent-id-rule.ts`, so it carries a copy. This test runs
 * both modules over one shared corpus and requires identical answers for the
 * rule, its constants and its refusal message.
 */
import { describe, expect, test } from "bun:test";
import * as src from "../../src/lib/agent-id-rule.js";
import * as client from "../../packages/flair-client/src/agent-id-rule.js";

/** Ids on both sides of every boundary the rule names, plus values that are
 *  not strings at all. */
const CORPUS: unknown[] = [
  // valid shapes, including each allowed class and both length boundaries
  "a",
  "A",
  "0",
  "_",
  "-",
  "agent_a",
  "agent-a",
  "A0_-z",
  "x".repeat(64),
  // empty and separators
  "",
  "/",
  "\\",
  "a/b",
  "a\\b",
  "a//b",
  "a\\\\b",
  // dots
  "..",
  "...",
  "a..b",
  ".hidden",
  "a.",
  // NUL and whitespace
  "\0",
  "a\0b",
  " ",
  "a b",
  "a\tb",
  "a\nb",
  " a",
  "a ",
  // over-long
  "a".repeat(65),
  "a".repeat(100),
  // unicode lookalikes
  "\u0430gent", // Cyrillic а
  "agent\u2011a", // non-breaking hyphen
  "\uFF41", // fullwidth a
  "agent\u200b", // zero-width space
  "é",
  // other characters
  "a.b",
  "a:b",
  "a@b",
  "a+b",
  "a=b",
  // non-strings the rule distinguishes
  null,
  undefined,
  5,
  0,
  123,
  -1,
  1.5,
  NaN,
  Infinity,
  9007199254740993,
  5n,
  true,
  {},
  [],
  ["agent"],
];

describe("flair#3188 — the client rule does not drift from src/lib/agent-id-rule.ts", () => {
  test("the rule and its constants are identical", () => {
    expect(client.AGENT_ID_RULE).toBe(src.AGENT_ID_RULE);
    expect(client.AGENT_ID_MAX_LENGTH).toBe(src.AGENT_ID_MAX_LENGTH);
    expect(client.AGENT_ID_ERROR).toBe(src.AGENT_ID_ERROR);
    expect(client.AGENT_ID_STRING_REMEDY).toBe(src.AGENT_ID_STRING_REMEDY);
    expect(client.AGENT_ID_PATTERN.source).toBe(src.AGENT_ID_PATTERN.source);
    expect(client.AGENT_ID_PATTERN.flags).toBe(src.AGENT_ID_PATTERN.flags);
  });

  test("both rules answer the shared corpus identically", () => {
    for (const id of CORPUS) {
      const label = typeof id === "string" ? JSON.stringify(id) : String(id);
      expect(client.isValidAgentId(id), `isValidAgentId ${label}`).toBe(src.isValidAgentId(id));
      expect(client.invalidAgentIdMessage(id), `invalidAgentIdMessage ${label}`).toBe(
        src.invalidAgentIdMessage(id),
      );
    }
  });

  test("both pattern matchers answer the string corpus identically", () => {
    for (const id of CORPUS.filter((v): v is string => typeof v === "string")) {
      expect(client.AGENT_ID_PATTERN.test(id), `pattern ${JSON.stringify(id)}`).toBe(
        src.AGENT_ID_PATTERN.test(id),
      );
    }
  });
});
