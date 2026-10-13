/**
 * redacted-write-2467.test.ts — the SDK's write()/update() result after a
 * server-side redaction (flair#2467).
 *
 * The server redacts credential-shaped text in `content`, `summary` and
 * `trigger` before storing a Memory. When it replaced any value, the write
 * response carries `redactedValues` and `stored`: the redacted text fields that
 * write committed. write()/update() build the result from that response and
 * make no read after the write. A response with a count and no `stored` (a
 * server from before `stored`) gives a result with no content, no summary and
 * no trigger, marked `contentWithheld`: the caller's input is never returned
 * for a field the server redacted.
 *
 * The fetch stand-in below keeps a small row store: a PUT stores the body with
 * the token replaced and answers `{ id, written, redactedValues, stored }`
 * (`stored` omitted for an older server); a GET returns the stored row. The
 * real-Harper counterpart is test/integration/memory-write-redaction-2407.test.ts.
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
const REDACTED_FIELDS = ["content", "summary", "trigger"] as const;

interface Call {
  method: string;
  path: string;
  body: any;
}
let calls: Call[] = [];
let rows: Map<string, Record<string, unknown>>;
/** False: answer like a server from before `stored` (count only). */
let serverSendsStored: boolean;
/** Overrides the `stored` value a redacting PUT answers with. */
let storedOverride: unknown;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  for (const key of CLIENT_ENV) {
    savedClientEnv[key] = process.env[key];
    delete process.env[key];
  }
  calls = [];
  serverSendsStored = true;
  storedOverride = undefined;
  rows = new Map([[
    "mem-1",
    {
      id: "mem-1", agentId: AGENT, content: "old text", summary: `old summary ${TOKEN}`, trigger: `old trigger ${TOKEN}`,
      type: "session", durability: "standard", tags: [],
    },
  ]]);
  globalThis.fetch = mock(async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const id = decodeURIComponent(url.pathname.replace(/^\/Memory\//, ""));
    if (method === "PUT") {
      const row: Record<string, unknown> = { ...body, id };
      const stored: Record<string, string> = {};
      let redactedValues = 0;
      for (const field of REDACTED_FIELDS) {
        const value = row[field];
        if (typeof value !== "string") continue;
        const redacted = value.split(TOKEN).join("[redacted]");
        if (redacted !== value) redactedValues += value.split(TOKEN).length - 1;
        row[field] = redacted;
        stored[field] = redacted;
      }
      rows.set(id, row);
      const response: Record<string, unknown> = { id, written: true, deduplicated: false };
      if (redactedValues > 0) {
        response.redactedValues = redactedValues;
        if (serverSendsStored) response.stored = storedOverride === undefined ? stored : storedOverride;
      }
      return json(response);
    }
    if (method === "GET") {
      const row = rows.get(id);
      return row ? json(row) : new Response("not found", { status: 404 });
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

const gets = () => calls.filter((c) => c.method === "GET").map((c) => c.path);
/** Every string in a result, so a test can assert the token appears in none. */
const strings = (value: unknown): string[] => JSON.stringify(value).match(/"(?:[^"\\]|\\.)*"/g) ?? [];

describe("flair#2467 — write()/update() report the text the write stored, from its own response", () => {
  test("write() returns the stored content and the count, with no read after the write", async () => {
    const res: any = await client().memory.write(ORIGINAL, { id: "mem-2" });
    expect(res.content).toBe(STORED);
    expect(res.redactedValues).toBe(1);
    expect(res.contentWithheld).toBeUndefined();
    expect(res.stored).toBeUndefined();
    expect(gets()).toEqual([]);
  });

  test("update() returns the stored content, summary and trigger; its only read is the existing row", async () => {
    const res: any = await client().memory.update("mem-1", ORIGINAL);
    expect(res.id).toBe("mem-1");
    expect(res.content).toBe(STORED);
    expect(res.summary).toBe("old summary [redacted]");
    expect(res.trigger).toBe("old trigger [redacted]");
    expect(res.redactedValues).toBe(3);
    expect(strings(res).some((s) => s.includes(TOKEN))).toBe(false);
    expect(gets()).toEqual(["/Memory/mem-1"]);
  });

  test("a preserveHistory update() returns the successor's id and its stored text", async () => {
    const res: any = await client().memory.update("mem-1", ORIGINAL, { preserveHistory: true });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).not.toBe("/Memory/mem-1");
    expect(`/Memory/${res.id}`).toBe(put.path);
    expect(res.supersedes).toBe("mem-1");
    expect(res.content).toBe(STORED);
    expect(res.summary).toBe("old summary [redacted]");
    expect(res.trigger).toBe("old trigger [redacted]");
    expect(res.redactedValues).toBe(3);
    expect(gets()).toEqual(["/Memory/mem-1"]);
  });

  test("a write the server did not redact returns the input, no count and no extra read", async () => {
    const res: any = await client().memory.write("a plain note", { id: "mem-2" });
    expect(res.content).toBe("a plain note");
    expect(res.redactedValues).toBeUndefined();
    expect(res.contentWithheld).toBeUndefined();
    expect(gets()).toEqual([]);
  });
});

describe("flair#2467 — a counted redaction without `stored` withholds the text, never returns the input", () => {
  test("write() to an older server: no content, contentWithheld, the count, no read", async () => {
    serverSendsStored = false;
    const res: any = await client().memory.write(ORIGINAL, { id: "mem-2" });
    expect(res.redactedValues).toBe(1);
    expect(res.contentWithheld).toBe(true);
    expect("content" in res).toBe(false);
    expect(res.id).toBe("mem-2");
    expect(res.written).toBe(true);
    expect(strings(res).some((s) => s.includes(TOKEN))).toBe(false);
    expect(gets()).toEqual([]);
  });

  test("update() to an older server: no content, summary or trigger from the input", async () => {
    serverSendsStored = false;
    const res: any = await client().memory.update("mem-1", ORIGINAL);
    expect(res.redactedValues).toBe(3);
    expect(res.contentWithheld).toBe(true);
    for (const field of REDACTED_FIELDS) expect(field in res).toBe(false);
    expect(strings(res).some((s) => s.includes(TOKEN))).toBe(false);
    expect(gets()).toEqual(["/Memory/mem-1"]);
  });

  test("a `stored` with no string content is treated as absent", async () => {
    storedOverride = { summary: "unrelated" };
    const res: any = await client().memory.write(ORIGINAL, { id: "mem-2" });
    expect(res.contentWithheld).toBe(true);
    for (const field of REDACTED_FIELDS) expect(field in res).toBe(false);
    expect(strings(res).some((s) => s.includes(TOKEN))).toBe(false);
  });
});
