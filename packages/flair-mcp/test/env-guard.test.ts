import { describe, test, expect, afterEach } from "bun:test";
import { FlairClient } from "@tpsdev-ai/flair-client";
import {
  isUnsubstitutedInterpolation,
  readEnvOrUnset,
  stripInterpolationLiteralsFromEnv,
} from "../src/env-guard.ts";

/**
 * flair#1250 — an MCP host that forwards `"FLAIR_URL": "${FLAIR_URL}"` without
 * substituting hands flair-mcp the LITERAL `${FLAIR_URL}`. It is truthy, so it
 * defeats every `?? default` chain (including flair-client's own DEFAULT_URL)
 * and the connection fails confusingly. These tests prove the literal is treated
 * as unset so the default applies — end to end, through flair-client, which
 * independently re-reads process.env.FLAIR_URL as its own fallback.
 */

/** flair-client's DEFAULT_URL (packages/flair-client/src/client.ts). */
const FLAIR_CLIENT_DEFAULT_URL = "http://localhost:19926";
const LITERAL = "${FLAIR_URL}";

// Save/restore the real env vars these tests mutate, so they never leak.
const ORIGINAL: Record<string, string | undefined> = {
  FLAIR_URL: process.env.FLAIR_URL,
  FLAIR_KEY_PATH: process.env.FLAIR_KEY_PATH,
  FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID,
};
afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("isUnsubstitutedInterpolation", () => {
  test("a wholesale ${...} placeholder is a literal", () => {
    expect(isUnsubstitutedInterpolation("${FLAIR_URL}")).toBe(true);
    expect(isUnsubstitutedInterpolation("  ${FLAIR_URL}  ")).toBe(true); // trims
    expect(isUnsubstitutedInterpolation("${}")).toBe(true);
    expect(isUnsubstitutedInterpolation("${A}${B}")).toBe(true);
  });

  test("a real value — even one that merely contains ${...} — is not a literal", () => {
    expect(isUnsubstitutedInterpolation("http://localhost:19926")).toBe(false);
    expect(isUnsubstitutedInterpolation("http://host/#${frag}")).toBe(false); // contains, not whole
    expect(isUnsubstitutedInterpolation("$FLAIR_URL")).toBe(false); // no braces
    expect(isUnsubstitutedInterpolation("")).toBe(false);
  });
});

describe("readEnvOrUnset (injectable env)", () => {
  test("a ${...} literal reads as unset (undefined)", () => {
    expect(readEnvOrUnset("FLAIR_URL", { FLAIR_URL: LITERAL })).toBeUndefined();
  });

  test("a genuinely absent var reads as unset (undefined)", () => {
    expect(readEnvOrUnset("FLAIR_URL", {})).toBeUndefined();
  });

  test("a real value is returned unchanged", () => {
    expect(readEnvOrUnset("FLAIR_URL", { FLAIR_URL: "http://example.test:1234" })).toBe(
      "http://example.test:1234",
    );
  });

  test("defaults to process.env when no env is passed", () => {
    process.env.FLAIR_KEY_PATH = LITERAL.replace("URL", "KEY_PATH"); // "${FLAIR_KEY_PATH}"
    expect(readEnvOrUnset("FLAIR_KEY_PATH")).toBeUndefined();
    process.env.FLAIR_KEY_PATH = "/keys/agent.key";
    expect(readEnvOrUnset("FLAIR_KEY_PATH")).toBe("/keys/agent.key");
  });
});

describe("stripInterpolationLiteralsFromEnv (injectable env)", () => {
  test("deletes a ${...} literal so the key becomes absent", () => {
    const env = { FLAIR_URL: LITERAL };
    stripInterpolationLiteralsFromEnv(env, ["FLAIR_URL"]);
    expect("FLAIR_URL" in env).toBe(false);
  });

  test("leaves a real value untouched", () => {
    const env = { FLAIR_URL: "http://real.test:9999" };
    stripInterpolationLiteralsFromEnv(env, ["FLAIR_URL"]);
    expect(env.FLAIR_URL).toBe("http://real.test:9999");
  });

  test("default name list strips FLAIR_URL only (scope is narrow)", () => {
    const env = { FLAIR_URL: LITERAL, FLAIR_KEY_PATH: "${FLAIR_KEY_PATH}" };
    stripInterpolationLiteralsFromEnv(env); // no explicit names → default list
    expect("FLAIR_URL" in env).toBe(false);
    expect(env.FLAIR_KEY_PATH).toBe("${FLAIR_KEY_PATH}"); // untouched by the strip
  });
});

describe("end-to-end: FLAIR_URL literal resolves to flair-client's default", () => {
  // Mirrors runMcp()'s exact sequence: strip the env boundary, then construct a
  // FlairClient with url: readEnvOrUnset("FLAIR_URL"). This is the POSITIVE
  // CONTROL — it exercises both guards AND flair-client's own env fallback.

  test("POSITIVE CONTROL: literal ${FLAIR_URL} → resolved origin is the default, not the literal", () => {
    process.env.FLAIR_URL = LITERAL;

    stripInterpolationLiteralsFromEnv(); // as runMcp() does at startup
    const client = new FlairClient({
      agentId: "test-agent",
      url: readEnvOrUnset("FLAIR_URL"), // as index.ts does at the call site
    });

    expect(client.url).toBe(FLAIR_CLIENT_DEFAULT_URL);
    expect(client.url).not.toBe(LITERAL);
  });

  test("NARROWNESS CONTROL: a real FLAIR_URL is preserved (guard does not over-fire)", () => {
    process.env.FLAIR_URL = "http://example.test:1234";

    stripInterpolationLiteralsFromEnv();
    const client = new FlairClient({
      agentId: "test-agent",
      url: readEnvOrUnset("FLAIR_URL"),
    });

    expect(client.url).toBe("http://example.test:1234");
  });

  test("FLAIR_KEY_PATH literal is dropped at the call site (flair-client never re-reads it from env)", () => {
    process.env.FLAIR_KEY_PATH = "${FLAIR_KEY_PATH}";
    expect(readEnvOrUnset("FLAIR_KEY_PATH")).toBeUndefined();
  });
});
