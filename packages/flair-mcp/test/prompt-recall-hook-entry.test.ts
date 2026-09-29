/**
 * prompt-recall-hook-entry.test.ts — flair#2066: the `flair-prompt-recall`
 * ENTRY POINT, spawned as its own process with the real flair-client, against
 * a loopback HTTP stand-in for Flair.
 *
 * What only a spawned process can show: the exit code (always 0), that the
 * whole process ends within its time budget whatever is still pending (stdin
 * held open, a config path that is a FIFO, a result set too large to arrive in
 * time), and what actually goes on the wire.
 *
 * The stand-in authenticates the way Flair does: it parses the Authorization
 * header and verifies the Ed25519 signature over the canonical payload with
 * Flair's OWN verifier code (resources/ed25519-auth.ts), against the fixture
 * agent's PUBLIC key, and answers 401 to anything that does not verify. So the
 * replay passes only when the hook signed with the agent's own key.
 *
 * Spawns the SOURCE entry, not dist/, for the reason recorded in
 * session-start-hook-probe.test.ts: this lane builds flair-client but never
 * this package, so dist/ is not guaranteed to exist.
 *
 * Hermetic: every child gets a minimal environment with its own temp HOME and
 * an explicit FLAIR_KEY_PATH inside it, so key resolution never probes a real
 * home; FLAIR_URL is a loopback port this file owns (or one it just closed).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FlairClient } from "@tpsdev-ai/flair-client";
import { b64ToArrayBuffer } from "../../../resources/b64.ts";
import { importEd25519Key, parseTpsEd25519Header, WINDOW_MS } from "../../../resources/ed25519-auth.ts";
import { childOverranDeadline } from "../../../test/helpers/child-deadline.js";
import { unavailableNote } from "../src/prompt-recall-hook.ts";
import { AGENT, FixtureStore, NOTIFICATION_PROMPT, REPLAY_PROMPT } from "./prompt-recall-fixture.ts";

const ENTRY = join(import.meta.dir, "..", "src", "prompt-recall-hook.ts");
const NOOP = "{}";
const TIMEOUT_NOTE = unavailableNote("timeout");

/** Default per-child deadline: far above any healthy run, so only a hung child hits it. */
const CHILD_DEADLINE_MS = 15_000;
/** Per-test budget: above the child deadline, so a hung child is reported by
 *  name (childOverranDeadline) before bun's own timer fires. */
const CASE_BUDGET_MS = 20_000;
/** A short hook budget for the cases that must end on the deadline. */
const SHORT_BUDGET_MS = 500;
/** Upper bound for a child that must end on its SHORT_BUDGET_MS deadline:
 *  the budget plus process start-up, generous for a loaded lane, and well
 *  below both the 3 s default budget and flair-client's 10 s request timeout. */
const ENDS_ON_DEADLINE_MS = 2_500;

const ADMIN_PASSWORD_SENTINEL = "SENTINEL-admin-pw-3c9d";

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  /** The signature verified against the fixture agent's public key. */
  verified: boolean;
  body: Record<string, unknown>;
}

type Mode = "fixture" | "hang" | "flood";

let server: Server;
let serverUrl: string;
let mode: Mode = "fixture";
/** The current test's agent public key, raw 32 bytes, base64url (a JWK `x`). */
let agentPublicKey = "";
const seen: SeenRequest[] = [];
/** Stops for any flood still running, so none outlives its test. (A client
 *  hang-up is not reported the same way by every runtime's HTTP server, so the
 *  flood is stopped here rather than on a disconnect event.) */
const floodStops: Array<() => void> = [];
const store = new FixtureStore();

/** In `flood` mode: FLOOD_CHUNKS chunks of FLOOD_HITS_PER_CHUNK hits every
 *  FLOOD_INTERVAL_MS, 100,000 hits and ~100 MB in all over ~10 s. */
const FLOOD_CHUNKS = 1000;
const FLOOD_HITS_PER_CHUNK = 100;
const FLOOD_INTERVAL_MS = 10;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Flair's own check (resources/agent-auth.ts): header grammar, time window,
 *  then Ed25519 over `id:ts:nonce:METHOD:pathname+search` with the agent's
 *  public key. Only the fixture agent is registered. */
async function verifyAgentSignature(req: IncomingMessage): Promise<boolean> {
  const parsed = parseTpsEd25519Header(String(req.headers.authorization ?? ""));
  if (!parsed || parsed.agentId !== AGENT || !agentPublicKey) return false;
  const ts = Number(parsed.tsRaw);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WINDOW_MS) return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  const payload = `${parsed.agentId}:${parsed.tsRaw}:${parsed.nonce}:${req.method}:${url.pathname}${url.search}`;
  try {
    const key = await importEd25519Key(agentPublicKey);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      b64ToArrayBuffer(parsed.signatureB64),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

beforeAll(async () => {
  expect(existsSync(ENTRY), `hook entry point must exist: ${ENTRY}`).toBe(true);
  server = createServer(async (req, res) => {
    const text = await readBody(req).catch(() => "");
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text || "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    const verified = await verifyAgentSignature(req);
    seen.push({
      method: req.method ?? "",
      path: new URL(req.url ?? "/", "http://recall-mock.local").pathname,
      authorization: req.headers.authorization,
      verified,
      body,
    });
    if (mode === "hang") return; // accept, never answer
    if (!verified) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    if (mode === "flood") {
      // A result set far larger than the hook asked for, arriving too slowly
      // to finish within a short budget.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"results":[');
      const hit = JSON.stringify({ id: "mem-flood", content: "x".repeat(1000), _score: 0.9, createdAt: "2026-09-26T00:00:00.000Z" });
      const chunk = Array.from({ length: FLOOD_HITS_PER_CHUNK }, () => hit).join(",");
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= FLOOD_CHUNKS) {
          clearInterval(timer);
          res.end("]}");
          return;
        }
        res.write((sent === 0 ? "" : ",") + chunk);
        sent++;
      }, FLOOD_INTERVAL_MS);
      floodStops.push(() => clearInterval(timer));
      return;
    }
    // The server's SemanticSearch wire shape: results with an absolute `_score`.
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const q = typeof body.q === "string" ? body.q : "";
    const limit = typeof body.limit === "number" ? body.limit : 10;
    const results = store.search(agentId, q, limit).map((h) => ({
      id: h.id,
      content: h.content,
      _score: h.score,
      createdAt: h.createdAt,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("loopback stand-in did not bind a TCP port");
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let home: string;
let keyPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-prompt-recall-entry-"));
  keyPath = join(home, "agent.key");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), { mode: 0o600 });
  agentPublicKey = String(publicKey.export({ format: "jwk" }).x);
  seen.length = 0;
  mode = "fixture";
});

afterEach(() => {
  for (const stop of floodStops.splice(0)) stop();
  rmSync(home, { recursive: true, force: true });
});

/** A minimal child environment: nothing inherited but PATH and the temp dir. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = { HOME: home, USERPROFILE: home };
  if (process.env.PATH) base.PATH = process.env.PATH;
  if (process.env.TMPDIR) base.TMPDIR = process.env.TMPDIR;
  return { ...base, FLAIR_AGENT_ID: AGENT, FLAIR_KEY_PATH: keyPath, FLAIR_URL: serverUrl, ...extra };
}

interface EntryRun {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface RunOptions {
  /** Write the payload but never close stdin. */
  holdStdin?: boolean;
  deadlineMs?: number;
}

function payload(prompt: string): string {
  return JSON.stringify({ session_id: "sess-1", cwd: "/tmp/project", hook_event_name: "UserPromptSubmit", prompt });
}

/** Spawn the entry point, feed it the payload, collect everything. Async, so
 *  the in-process stand-in keeps serving while the child runs. */
function runEntry(env: Record<string, string>, input: string, leg: string, opts: RunOptions = {}): Promise<EntryRun> {
  const deadlineMs = opts.deadlineMs ?? CHILD_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    // A child that stops reading early (the oversized-stdin case) makes the
    // rest of our write fail with EPIPE; that is expected, not a test error.
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => child.kill("SIGTERM"), deadlineMs);
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      child.stdin.destroy();
      const run = { status, signal, stdout, stderr, elapsedMs: Math.round(performance.now() - start) };
      if (signal !== null) {
        reject(new Error(childOverranDeadline("prompt-recall entry point", leg, deadlineMs, run)));
        return;
      }
      resolve(run);
    });
    if (opts.holdStdin) child.stdin.write(input);
    else child.stdin.end(input);
  });
}

function contextOf(stdout: string): string {
  const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
  return parsed.hookSpecificOutput?.additionalContext ?? "";
}

/** A loopback port with nothing listening: bind, note the port, close. */
async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const addr = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!addr || typeof addr === "string") throw new Error("could not reserve a loopback port");
  return `http://127.0.0.1:${addr.port}`;
}

describe("flair-prompt-recall entry point (spawned, real client)", () => {
  test(
    "control: the stand-in refuses a request signed with a key other than the agent's",
    async () => {
      const other = generateKeyPairSync("ed25519").privateKey;
      const client = new FlairClient({ agentId: AGENT, url: serverUrl, privateKey: other, adminUser: "", adminPassword: "" });
      await expect(client.memory.search("Jev", { limit: 1 })).rejects.toMatchObject({ status: 401 });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.authorization?.startsWith(`TPS-Ed25519 ${AGENT}:`)).toBe(true); // the prefix alone proves nothing
      expect(seen[0]!.verified).toBe(false);
    },
    CASE_BUDGET_MS,
  );

  test(
    "replay: the direction reaches stdout; the request verifies against the agent's own public key, never admin Basic",
    async () => {
      const run = await runEntry(
        childEnv({ FLAIR_ADMIN_USER: "admin", FLAIR_ADMIN_PASSWORD: ADMIN_PASSWORD_SENTINEL }),
        payload(REPLAY_PROMPT),
        "replay",
      );
      expect(run.status).toBe(0);
      expect(seen).toHaveLength(1);
      const req = seen[0]!;
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/SemanticSearch");
      expect(req.verified).toBe(true);
      expect(req.body.agentId).toBe(AGENT);
      expect(String(req.body.q)).toContain("Jev");
      expect(String(req.body.q)).not.toContain("https://");
      expect(JSON.stringify(seen)).not.toContain("Basic ");
      expect(JSON.stringify(seen)).not.toContain(ADMIN_PASSWORD_SENTINEL);

      const ctx = contextOf(run.stdout);
      expect(ctx).toContain("mem-dir-jev-routing");
      expect(ctx).toContain("The decision model is local and routes generation");
      expect(ctx).not.toContain("mem-release-checklist");
    },
    CASE_BUDGET_MS,
  );

  test(
    "no key: the request carries no credential at all despite admin env; the refusal is one note line, exit 0",
    async () => {
      const run = await runEntry(
        childEnv({
          FLAIR_KEY_PATH: join(home, "missing.key"),
          FLAIR_ADMIN_USER: "admin",
          FLAIR_ADMIN_PASSWORD: ADMIN_PASSWORD_SENTINEL,
        }),
        payload(REPLAY_PROMPT),
        "no-key",
      );
      expect(run.status).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.authorization).toBeUndefined();
      expect(seen[0]!.verified).toBe(false);
      const ctx = contextOf(run.stdout);
      expect(ctx.split("\n")).toHaveLength(1);
      expect(ctx).toContain("(auth)");
      expect(run.stdout).not.toContain(ADMIN_PASSWORD_SENTINEL);
    },
    CASE_BUDGET_MS,
  );

  test(
    "Flair down: exit 0 and one note line",
    async () => {
      const run = await runEntry(childEnv({ FLAIR_URL: await closedPortUrl() }), payload(REPLAY_PROMPT), "flair-down");
      expect(run.status).toBe(0);
      const ctx = contextOf(run.stdout);
      expect(ctx.split("\n")).toHaveLength(1);
      expect(ctx).toContain("Flair recall was unavailable for this prompt (unreachable)");
    },
    CASE_BUDGET_MS,
  );

  test(
    "Flair slow: the process exits 0 once its budget runs out, with the request still open",
    async () => {
      mode = "hang";
      const run = await runEntry(
        childEnv({ FLAIR_PROMPT_RECALL_TIMEOUT_MS: String(SHORT_BUDGET_MS) }),
        payload(REPLAY_PROMPT),
        "flair-slow",
      );
      expect(run.status).toBe(0);
      expect(seen).toHaveLength(1); // the request was accepted and never answered
      expect(contextOf(run.stdout)).toBe(TIMEOUT_NOTE);
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
    },
    CASE_BUDGET_MS,
  );

  test(
    "stdin held open: the deadline armed before stdin is read ends the hook with one note, exit 0",
    async () => {
      const run = await runEntry(
        childEnv({ FLAIR_PROMPT_RECALL_TIMEOUT_MS: String(SHORT_BUDGET_MS) }),
        payload(REPLAY_PROMPT),
        "held-stdin",
        { holdStdin: true, deadlineMs: 8_000 },
      );
      expect(run.status).toBe(0);
      expect(contextOf(run.stdout)).toBe(TIMEOUT_NOTE);
      expect(seen).toHaveLength(0); // stdin never ended, so nothing was searched
      // It waited for its budget (not an early exit) and no longer.
      expect(run.elapsedMs).toBeGreaterThanOrEqual(SHORT_BUDGET_MS - 50);
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
    },
    CASE_BUDGET_MS,
  );

  test(
    "a FIFO at the config path is refused before it is opened: no stall, recall proceeds on defaults, exit 0",
    async () => {
      mkdirSync(join(home, ".flair"), { recursive: true });
      const fifo = join(home, ".flair", "config.yaml");
      const made = spawnSync("mkfifo", [fifo], { encoding: "utf-8" });
      expect(made.status).toBe(0); // a missing mkfifo must FAIL, not skip the case
      const run = await runEntry(
        childEnv({ FLAIR_PROMPT_RECALL_TIMEOUT_MS: "1500" }),
        payload(REPLAY_PROMPT),
        "config-fifo",
        { deadlineMs: 8_000 },
      );
      expect(run.status).toBe(0);
      // Not the deadline's note: the FIFO cost nothing and the search ran.
      const ctx = contextOf(run.stdout);
      expect(ctx).toContain("mem-dir-jev-routing");
      expect(seen).toHaveLength(1);
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
    },
    CASE_BUDGET_MS,
  );

  test(
    "an oversized result set that cannot arrive within the budget: exit 0 within the budget, one note",
    async () => {
      mode = "flood";
      const run = await runEntry(
        childEnv({ FLAIR_PROMPT_RECALL_TIMEOUT_MS: String(SHORT_BUDGET_MS) }),
        payload(REPLAY_PROMPT),
        "oversized-results",
      );
      expect(run.status).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.verified).toBe(true); // the search itself was accepted
      expect(contextOf(run.stdout)).toBe(TIMEOUT_NOTE);
      // Sending all of it takes about FLOOD_CHUNKS × FLOOD_INTERVAL_MS (~10 s):
      // the hook ended on its budget instead of waiting for, or processing, the rest.
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
    },
    CASE_BUDGET_MS,
  );

  test(
    "an oversized stdin payload is not read past its cap and not searched: {} and exit 0",
    async () => {
      const big = payload(`What about Jev? ${"x ".repeat(700_000)}`); // ~1.4 MB, over the 1 MiB cap
      const run = await runEntry(childEnv({}), big, "oversized-stdin");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(NOOP);
      expect(seen).toHaveLength(0);
    },
    CASE_BUDGET_MS,
  );

  test(
    "a notification-shaped prompt never reaches Flair",
    async () => {
      const run = await runEntry(childEnv({}), payload(NOTIFICATION_PROMPT), "notification");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(NOOP);
      expect(seen).toHaveLength(0);
    },
    CASE_BUDGET_MS,
  );

  test(
    "probe mode prints {} and exits 0 without contacting Flair",
    async () => {
      const run = await runEntry(childEnv({ FLAIR_HOOK_PROBE: "1" }), payload(REPLAY_PROMPT), "probe");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(NOOP);
      expect(seen).toHaveLength(0);
    },
    CASE_BUDGET_MS,
  );
});
