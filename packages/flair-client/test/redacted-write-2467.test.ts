/**
 * redacted-write-2467.test.ts — the SDK's write()/update() result after a
 * server-side redaction (flair#2467).
 *
 * The server redacts credential-shaped text before storing a Memory and
 * reports `redactedValues` on the write response; the response does NOT echo
 * the stored `content` (measured on a real Harper, flair#2407). So a write
 * whose value was redacted must re-read the row and return the STORED text,
 * never the caller's input.
 *
 * The fetch stand-in below mirrors those two documented shapes: a PUT
 * answered with `{ id, written, redactedValues }` and no `content`, and the
 * GET that returns the stored row.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

const originalFetch = globalThis.fetch;
const CLIENT_ENV = ["FLAIR_URL", "FLAIR_AGENT_ID", "FLAIR_CLIENT", "FLAIR_ADMIN_USER", "FLAIR_ADMIN_PASSWORD"];
const savedClientEnv: Record<string, string | undefined> = {};

const AGENT = "agent-a";
const TOKEN = `ghp_${"a".repeat(24)}`;
const ORIGINAL = `deploy note: use token ${TOKEN} for the CI job`;
const STORED = "deploy note: use token [redacted] for the CI job";

interface Call {
  method: string;
  path: string;
  body: any;
}
let calls: Call[] = [];
/** What the GET after a redacted write returns (the STORED row). */
let storedRow: Record<string, unknown>;
/** What an update's FIRST read (the existing row) returns. */
let existingRow: Record<string, unknown>;
let redactedValues: number | undefined;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  for (const key of CLIENT_ENV) {
    savedClientEnv[key] = process.env[key];
    delete process.env[key];
  }
  calls = [];
  redactedValues = 1;
  storedRow = { id: "mem-1", agentId: AGENT, content: STORED, type: "session", durability: "standard", tags: [] };
  existingRow = { id: "mem-1", agentId: AGENT, content: "old text", type: "session", durability: "standard", tags: [] };
  let wroteRedacted = false;
  globalThis.fetch = mock(async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (method === "PUT") {
      const response: Record<string, unknown> = { id: body?.id ?? "mem-1", written: true, deduplicated: false };
      wroteRedacted = redactedValues !== undefined;
      if (redactedValues !== undefined) response.redactedValues = redactedValues;
      return json(response);
    }
    if (method === "GET") {
      // Before the write, a read is update()'s existing-row read; after a
      // redacted write, a read is the STORED row.
      return json(wroteRedacted ? storedRow : existingRow);
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of CLIENT_ENV) {
    if (savedClientEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedClientEnv[key];
  }
});

const { FlairClient } = await import("../src/client.js");

function client(): InstanceType<typeof FlairClient> {
  const { privateKey } = generateKeyPairSync("ed25519");
  return new FlairClient({ agentId: AGENT, url: "http://flair.invalid", privateKey });
}

const gets = () => calls.filter((c) => c.method === "GET");

describe("flair#2467 — write()/update() return the STORED content after a redaction", () => {
  test("write() re-reads the row and returns the redacted text, not the caller's input", async () => {
    const res: any = await client().memory.write(ORIGINAL, { id: "mem-1" });
    expect(res.content).toBe(STORED);
    expect(res.redactedValues).toBe(1);
    // It re-read the STORED row rather than trusting its own input.
    expect(gets().map((c) => c.path)).toEqual(["/Memory/mem-1"]);
  });

  test("update() re-reads the row and returns the redacted text", async () => {
    const res: any = await client().memory.update("mem-1", ORIGINAL);
    expect(res.content).toBe(STORED);
    expect(res.redactedValues).toBe(1);
    // one read for the existing row, one after the redacted write.
    expect(gets().map((c) => c.path)).toEqual(["/Memory/mem-1", "/Memory/mem-1"]);
  });

  test("preserveHistory update() re-reads the successor and returns the redacted text", async () => {
    const res: any = await client().memory.update("mem-1", ORIGINAL, { preserveHistory: true });
    expect(res.content).toBe(STORED);
    expect(res.redactedValues).toBe(1);
    // The re-read targets the NEW successor id, not the superseded one.
    expect(gets().at(-1)!.path).not.toBe("/Memory/mem-1");
  });

  test("a write the server did not redact returns the input and makes no extra read", async () => {
    redactedValues = undefined;
    const res: any = await client().memory.write(ORIGINAL, { id: "mem-1" });
    expect(res.content).toBe(ORIGINAL);
    expect(res.redactedValues).toBeUndefined();
    expect(gets()).toEqual([]);
  });
});
