// flair-client.mjs needs an explicit identity for EVERY signed action (flair#1851).
//
// Follow-up to #1816. That change made mutations refuse without `FLAIR_AGENT_ID`
// or `--agent <id>`, but deliberately kept a shipped `DEFAULT_AGENT_ID = 'flint'`
// for `list`/`get`/`search`. A read is still a SIGNED request: an identity-less
// `search` or `get` signed as `flint` and could return that principal's
// non-shared records to a caller who never chose that identity. Every action this
// script supports signs — they all go through `flairFetch`, which always sets an
// `Authorization` header — so every action now refuses without an explicit
// identity, and the refusal happens BEFORE the key load and the fetch.
//
// These tests spawn the real script as a subprocess. The refusal's "no network
// request" claim is proven at the real boundary: a recording server stands in for
// Flair, and a refused call leaves its capture EMPTY. The key is supplied via
// FLAIR_PRIV_KEY (an explicit override that wins outright), so a tree that still
// had a default identity would load a key and reach the server — which is exactly
// what the mutation check needs to be able to see.

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "flair-client.mjs");

let scratch = "";
let keyFile = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "flair-1851-"));
  keyFile = join(scratch, "seed.key");
  // Any 32-byte seed is a valid Ed25519 private key. Its presence means a tree
  // that still defaulted the identity would load a key and reach the network,
  // so the empty-capture assertion below is a real observation, not a guess at
  // what a missing key would have done.
  writeFileSync(keyFile, Buffer.alloc(32, 9));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Received {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}

// Async by design: the recording server runs in THIS process, and a synchronous
// spawn would block the event loop that has to answer the child's request.
async function runClient(
  url: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  // Built from scratch, never from process.env: a child that inherited a
  // developer's FLAIR_* deployment config could turn a missing identity into a
  // real signed request against a live host.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    USERPROFILE: scratch,
    FLAIR_KEY_DIR: scratch,
    FLAIR_URL: url,
    FLAIR_PRIV_KEY: keyFile,
  };
  for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
  const proc = Bun.spawn(["node", SCRIPT, ...args], { env, stderr: "pipe", stdout: "pipe" });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();
  return { exitCode, stderr, stdout };
}

async function withRecordingServer(
  fn: (url: string, received: Received[]) => Promise<void>,
): Promise<void> {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      received.push({
        method: req.method,
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization") ?? "",
        body: await req.json().catch(() => null),
      });
      return Response.json({ results: [] });
    },
  });
  try {
    await fn(`http://127.0.0.1:${server.port}`, received);
  } finally {
    server.stop(true);
  }
}

// Every read action, with the HTTP method it signs.
const READS: Array<{ args: string[]; method: string }> = [
  { args: ["memory", "get", "flint-1"], method: "GET" },
  { args: ["memory", "list"], method: "GET" },
  { args: ["memory", "search", "deploy"], method: "POST" },
];

describe("flair-client refuses every signed action without an identity (flair#1851)", () => {
  it("NEGATIVE: get/list/search with no identity refuse, and make NO network request", async () => {
    await withRecordingServer(async (url, received) => {
      for (const { args } of READS) {
        const r = await runClient(url, args);
        const action = args[1]!;
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain(`refusing to ${action}`);
        expect(r.stderr).toContain("FLAIR_AGENT_ID");
        expect(r.stderr).toContain("--agent");
        // Refused before the key load: reaching it would name the agent.
        expect(r.stderr).not.toContain("no private key found");
      }
      // The whole point of #1851: not one request left the process.
      expect(received).toHaveLength(0);
    });
  });

  it("REGRESSION: mutation refusal is unchanged", async () => {
    await withRecordingServer(async (url, received) => {
      for (const args of [
        ["memory", "write", "hello"],
        ["soul", "set", "voice", "dry"],
        ["memory", "delete", "flint-1"],
      ]) {
        const r = await runClient(url, args);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain(`refusing to ${args[1]!}`);
        expect(r.stderr).toContain("FLAIR_AGENT_ID");
        expect(r.stderr).not.toContain("no private key found");
      }
      expect(received).toHaveLength(0);
    });
  });

  it("POSITIVE: FLAIR_AGENT_ID signs each read as that agent", async () => {
    await withRecordingServer(async (url, received) => {
      for (const { args, method } of READS) {
        const r = await runClient(url, args, { FLAIR_AGENT_ID: "anvil" });
        expect(r.exitCode).toBe(0);
        expect(r.stderr).not.toContain("refusing");
        expect(received).toHaveLength(1);
        expect(received[0]!.method).toBe(method);
        expect(received[0]!.auth).toContain("TPS-Ed25519 anvil:");
        received.length = 0;
      }
    });
  });

  it("POSITIVE: --agent signs each read as that agent and is consumed, not folded", async () => {
    await withRecordingServer(async (url, received) => {
      for (const { args, method } of READS) {
        const r = await runClient(url, [...args, "--agent", "anvil"]);
        expect(r.exitCode).toBe(0);
        expect(r.stderr).not.toContain("refusing");
        expect(received).toHaveLength(1);
        expect(received[0]!.method).toBe(method);
        expect(received[0]!.auth).toContain("TPS-Ed25519 anvil:");
        received.length = 0;
      }
    });
  });
});
