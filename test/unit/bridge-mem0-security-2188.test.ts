/** Credential-boundary probes for the mem0 bridge. No listener or network is used. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mem0MemoryBridge } from "../../src/bridges/builtins/mem0.js";
import { formatBridgeErrorLines, serializeBridgeLogLine } from "../../src/commands/bridge.js";
import { BridgeRuntimeError, type BridgeContext } from "../../src/bridges/types.js";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

const KEY = "mem0-secret-security-2188";
const CLI_PATH = join(import.meta.dirname, "..", "..", "dist", "cli.js");

function fakeContext(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, logs: string[]): BridgeContext {
  const log = (message: string, meta?: Record<string, unknown>) => logs.push(JSON.stringify({ message, meta }));
  return {
    fetch: fetcher as unknown as typeof fetch,
    log: { debug: log, info: log, warn: log, error: log },
    cache: { get: async () => null, set: async () => {}, del: async () => {} },
  };
}

async function drain(opts: Record<string, unknown>, ctx: BridgeContext): Promise<void> {
  for await (const _ of mem0MemoryBridge.import!(opts, ctx)) { /* drain */ }
}

describe("mem0 credential diagnostics (socket-free)", () => {
  test("representative invalid explicit base URLs refuse before fetch", async () => {
    let calls = 0;
    const ctx = fakeContext(async () => { calls++; throw new Error("fetch called"); }, []);
    for (const baseUrl of ["", " ", "not-a-url", "ftp://mem0.example", "https://user:pass@mem0.example", "https://mem0.example/?q=1"]) {
      let error: unknown;
      try { await drain({ user: "u1", apiKey: KEY, baseUrl }, ctx); }
      catch (err) { error = err; }
      expect(calls).toBe(0);
      expect(String(error)).toContain("--base-url");
    }
  });

  test("a 500 echoing the key emits only status and a bounded fixed reason", async () => {
    const logs: string[] = [];
    const ctx = fakeContext(async () => new Response(`error: ${KEY}`, { status: 500, statusText: KEY }), logs);
    let diagnostic = "";
    try { await drain({ user: "u1", apiKey: KEY, baseUrl: "https://mem0.example" }, ctx); }
    catch (err) { diagnostic = JSON.stringify((err as any).detail) + String(err); }
    expect(diagnostic).toContain("HTTP 500");
    expect(diagnostic).toContain("check the Mem0 API server logs");
    expect(diagnostic.length).toBeLessThan(500);
    expect(diagnostic + logs.join("\n")).not.toContain(KEY);
    expect(diagnostic).not.toContain("error:");
  });

  test("a pagination URL containing the key never appears in diagnostics or logs", async () => {
    const logs: string[] = [];
    const next = `https://mem0.example/v1/memories/?token=${KEY}`;
    let calls = 0;
    const ctx = fakeContext(async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ results: [], next }), { status: 200 })
        : new Response(`failure ${KEY}`, { status: 500 });
    }, logs);
    let diagnostic = "";
    try { await drain({ user: "u1", apiKey: KEY, baseUrl: "https://mem0.example" }, ctx); }
    catch (err) { diagnostic = JSON.stringify((err as any).detail) + String(err); }
    expect(calls).toBe(2);
    expect(diagnostic).toContain("HTTP 500");
    expect(diagnostic + logs.join("\n")).not.toContain(KEY);
    expect(diagnostic + logs.join("\n")).not.toContain(next);
  });

  test("a cross-origin pagination URL cannot receive the API key", async () => {
    let calls = 0;
    const ctx = fakeContext(async () => {
      calls++;
      return new Response(JSON.stringify({ results: [], next: "https://other.example/page" }), { status: 200 });
    }, []);
    await expect(drain({ user: "u1", apiKey: KEY, baseUrl: "https://mem0.example" }, ctx)).rejects.toThrow(/unsafe pagination URL/);
    expect(calls).toBe(1);
  });

  test("a fetch exception cannot echo the key or requested URL", async () => {
    const ctx = fakeContext(async () => { throw new Error(`fetch failed for https://mem0.example/?token=${KEY}`); }, []);
    let diagnostic = "";
    try { await drain({ user: "u1", apiKey: KEY, baseUrl: "https://mem0.example" }, ctx); }
    catch (err) { diagnostic = JSON.stringify((err as any).detail) + String(err); }
    expect(diagnostic).toContain("network error");
    expect(diagnostic).not.toContain(KEY);
    expect(diagnostic).not.toContain("https://mem0.example/");
  });

  test("the final serialized log line redacts a metadata field named with the key", () => {
    const line = serializeBridgeLogLine({
      message: "metadata probe",
      meta: { [KEY]: { nested: `value-${KEY}` } },
    }, KEY);
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain(KEY);
  });

  test("structured and trust errors redact the key from every rendered line", () => {
    const structured = new BridgeRuntimeError({
      bridge: "mem0",
      op: "import",
      field: "response",
      expected: "fixed diagnostic",
      got: "failure",
      hint: `error message contains ${KEY}`,
    });
    const trust = new BridgeRuntimeError({
      bridge: "mem0",
      op: "import",
      field: "(trust)",
      expected: "approved package",
      got: "path-mismatch",
      hint: `trust error contains ${KEY}`,
      context: {
        approvedPath: `/approved/${KEY}`,
        observedPath: `/observed/${KEY}`,
      },
    });
    const output = [...formatBridgeErrorLines(structured, KEY), ...formatBridgeErrorLines(trust, KEY)].join("\n");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(KEY);
  });
});

describe("bridge import credential flags (socket-free CLI)", () => {
  let scratch: string;
  let preload: string;
  let marker: string;
  beforeAll(() => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-mem0-security-"));
    preload = join(scratch, "fetch-tap.mjs");
    marker = join(scratch, "fetch-calls");
    writeFileSync(preload, `import { appendFileSync } from "node:fs";
let calls = 0;
globalThis.fetch = async (_input, init) => {
  appendFileSync(process.env.FLAIR_FETCH_TAP, "1\\n");
  calls++;
  const key = process.env.MEM0_API_KEY;
  if (process.env.FLAIR_FETCH_REPLY === "echo500") {
    return new Response("server echoed " + key, { status: 500, statusText: key });
  }
  if (process.env.FLAIR_FETCH_REPLY === "pagination") {
    return calls === 1
      ? new Response(JSON.stringify({ results: [], next: "https://mem0.example/v1/memories/?token=" + key }), { status: 200 })
      : new Response("server echoed " + key, { status: 500 });
  }
  if (process.env.FLAIR_FETCH_REPLY === "progress") {
    return calls === 1
      ? new Response(JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ id: i === 24 ? key : "m" + i, memory: "memory " + i }))), { status: 200 })
      : new Response("", { status: 200 });
  }
  if (process.env.FLAIR_FETCH_REPLY === "write500") {
    return calls === 1
      ? new Response(JSON.stringify([{ id: "m1", memory: "memory" }]), { status: 200 })
      : new Response("server echoed " + key, { status: 500, statusText: key });
  }
  if (process.env.FLAIR_FETCH_REPLY === "filekey") {
    if (init?.headers?.Authorization !== "Token " + process.env.FLAIR_TEST_EXPECT_KEY) throw new Error("authorization mismatch");
    return new Response("server failure", { status: 500 });
  }
  throw new Error("fetch called");
};
`);
  });
  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string; fetches: number }> {
    writeFileSync(marker, "");
    return new Promise((resolve, reject) => {
      const child = spawn("bun", ["--preload", preload, CLI_PATH, "bridge", "import", ...args], {
        cwd: scratch,
        env: { ...process.env, HOME: scratch, FLAIR_AGENT_ID: "", MEM0_API_KEY: "", FLAIR_FETCH_TAP: marker, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      });
      let stderr = "";
      let stdout = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (signal) return reject(new Error(`CLI terminated by ${signal}: ${stderr}`));
        resolve({ code, stdout, stderr, fetches: readFileSync(marker, "utf8").split("\n").filter(Boolean).length });
      });
    });
  }

  test("explicit empty or invalid --base-url refuses before any request", async () => {
    for (const value of ["", "not-a-url"]) {
      const result = await cli(["mem0", "--user", "u1", "--base-url", value, "--agent", "a1", "--url", "http://127.0.0.1:1", "--dry-run"], { MEM0_API_KEY: KEY });
      expect(result.code).not.toBe(0);
      expect(result.fetches).toBe(0);
      expect(result.stderr).toContain("--base-url");
      expect(result.stderr).not.toContain(KEY);
    }
  }, 25_000);

  test("an invalid Flair URL containing the active key is redacted from the error", async () => {
    const result = await cli(["mem0", "--user", "u1", "--base-url", "https://mem0.example", "--agent", "a1", "--url", KEY, "--dry-run"], { MEM0_API_KEY: KEY });
    expect(result.code).not.toBe(0);
    expect(result.fetches).toBe(0);
    expect(result.stderr).toContain("Flair base URL must be a valid URL");
    expect(result.stdout + result.stderr).not.toContain(KEY);
  }, 25_000);

  test("an empty --api-key-file refuses despite MEM0_API_KEY", async () => {
    const result = await cli(["mem0", "--user", "u1", "--api-key-file", "", "--base-url", "https://mem0.example", "--agent", "a1", "--url", "http://127.0.0.1:1", "--dry-run"], { MEM0_API_KEY: KEY });
    expect(result.code).not.toBe(0);
    expect(result.fetches).toBe(0);
    expect(result.stderr).toContain("--api-key-file requires a non-empty path");
    expect(result.stderr).not.toContain(KEY);
  }, 25_000);

  test("an owner-only 0400 key file is accepted by the actual permission rule", async () => {
    const file = join(scratch, "read-only-key");
    writeFileSync(file, KEY + "\n");
    chmodSync(file, 0o400);
    const result = await cli(["mem0", "--user", "u1", "--api-key-file", file, "--base-url", "https://mem0.example", "--agent", "a1", "--url", "http://127.0.0.1:1", "--dry-run"], { FLAIR_FETCH_REPLY: "filekey", FLAIR_TEST_EXPECT_KEY: KEY });
    expect(result.fetches).toBe(1);
    expect(result.stderr).toContain("HTTP 500");
    expect(result.stderr).not.toContain(KEY);
  }, 25_000);

  test("a 500 body and status text echoing the key stay out of CLI output", async () => {
    const result = await cli(["mem0", "--user", "u1", "--base-url", "https://mem0.example", "--agent", "a1", "--url", "http://127.0.0.1:1", "--dry-run"], { MEM0_API_KEY: KEY, FLAIR_FETCH_REPLY: "echo500" });
    expect(result.code).not.toBe(0);
    expect(result.fetches).toBe(1);
    expect(result.stderr).toContain("HTTP 500");
    expect(result.stdout + result.stderr).not.toContain(KEY);
    expect(result.stdout + result.stderr).not.toContain("server echoed");
  }, 25_000);

  test("a pagination URL containing the key stays out of CLI output", async () => {
    const result = await cli(["mem0", "--user", "u1", "--base-url", "https://mem0.example", "--agent", "a1", "--url", "http://127.0.0.1:1", "--dry-run"], { MEM0_API_KEY: KEY, FLAIR_FETCH_REPLY: "pagination" });
    expect(result.code).not.toBe(0);
    expect(result.fetches).toBe(2);
    expect(result.stderr).toContain("HTTP 500");
    expect(result.stdout + result.stderr).not.toContain(KEY);
    expect(result.stdout + result.stderr).not.toContain("token=");
  }, 25_000);

  test("a server-controlled memory id containing the key is redacted from progress", async () => {
    const result = await cli(["mem0", "--user", "u1", "--base-url", "https://mem0.example", "--agent", "a1", "--url", "http://127.0.0.1:1"], { MEM0_API_KEY: KEY, FLAIR_FETCH_REPLY: "progress" });
    expect(result.code).toBe(0);
    expect(result.fetches).toBe(26);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout + result.stderr).not.toContain(KEY);
  }, 25_000);

  test("a Flair write failure cannot print its response body", async () => {
    const result = await cli(["mem0", "--user", "u1", "--base-url", "https://mem0.example", "--agent", "a1", "--url", "http://127.0.0.1:1"], { MEM0_API_KEY: KEY, FLAIR_FETCH_REPLY: "write500" });
    expect(result.code).not.toBe(0);
    expect(result.fetches).toBe(2);
    expect(result.stderr).toContain("HTTP 500");
    expect(result.stdout + result.stderr).not.toContain(KEY);
    expect(result.stdout + result.stderr).not.toContain("server echoed");
  }, 25_000);

  test("YAML imports refuse a credential flag they cannot use", async () => {
    const result = await cli(["agentic-stack", "--api-key-file", "missing-file", "--agent", "a1", "--url", "http://127.0.0.1:1", "--dry-run"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("YAML imports cannot use it");
    expect(result.fetches).toBe(0);
  }, 25_000);
});
