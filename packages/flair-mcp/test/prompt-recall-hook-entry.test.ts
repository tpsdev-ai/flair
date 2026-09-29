/**
 * prompt-recall-hook-entry.test.ts — flair#2066: the `flair-prompt-recall`
 * ENTRY POINT, spawned as its own process with the real flair-client, against
 * a loopback HTTP stand-in for Flair.
 *
 * What only a spawned process can show: the exit code (always 0), that the
 * process ends within its time budget even when a request is still open, and
 * what actually goes on the wire (the agent's own Ed25519 signature, never
 * admin Basic credentials, even with FLAIR_ADMIN_USER / FLAIR_ADMIN_PASSWORD
 * in the environment).
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
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childOverranDeadline } from "../../../test/helpers/child-deadline.js";
import { AGENT, FixtureStore, NOTIFICATION_PROMPT, REPLAY_PROMPT } from "./prompt-recall-fixture.ts";

const ENTRY = join(import.meta.dir, "..", "src", "prompt-recall-hook.ts");
const NOOP = "{}";

/** Per-child deadline: far above any healthy run, so only a hung child hits it. */
const CHILD_DEADLINE_MS = 15_000;
/** Per-test budget: above the child deadline, so a hung child is reported by
 *  name (childOverranDeadline) before bun's own timer fires. */
const CASE_BUDGET_MS = 20_000;

const ADMIN_PASSWORD_SENTINEL = "SENTINEL-admin-pw-3c9d";

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

type Mode = "fixture" | "unauthorized" | "hang";

let server: Server;
let serverUrl: string;
let mode: Mode = "fixture";
const seen: SeenRequest[] = [];
const store = new FixtureStore();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
    seen.push({
      method: req.method ?? "",
      path: new URL(req.url ?? "/", "http://recall-mock.local").pathname,
      authorization: req.headers.authorization,
      body,
    });
    if (mode === "hang") return; // accept, never answer
    if (mode === "unauthorized") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "authentication required" }));
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
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), { mode: 0o600 });
  seen.length = 0;
  mode = "fixture";
});

afterEach(() => {
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

function payload(prompt: string): string {
  return JSON.stringify({ session_id: "sess-1", cwd: "/tmp/project", hook_event_name: "UserPromptSubmit", prompt });
}

/** Spawn the entry point, feed it the payload, collect everything. Async, so
 *  the in-process stand-in keeps serving while the child runs. */
function runEntry(env: Record<string, string>, input: string, leg: string): Promise<EntryRun> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), CHILD_DEADLINE_MS);
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      const run = { status, signal, stdout, stderr, elapsedMs: Math.round(performance.now() - start) };
      if (signal !== null) {
        reject(new Error(childOverranDeadline("prompt-recall entry point", leg, CHILD_DEADLINE_MS, run)));
        return;
      }
      resolve(run);
    });
    child.stdin.end(input);
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
    "replay: the direction reaches stdout; the request is signed with the agent's own key, never admin Basic",
    async () => {
      const run = await runEntry(
        childEnv({ FLAIR_ADMIN_USER: "admin", FLAIR_ADMIN_PASSWORD: ADMIN_PASSWORD_SENTINEL }),
        payload(REPLAY_PROMPT),
        "replay",
      );
      expect(run.status).toBe(0);
      const ctx = contextOf(run.stdout);
      expect(ctx).toContain("mem-dir-jev-routing");
      expect(ctx).toContain("The decision model is local and routes generation");
      expect(ctx).not.toContain("mem-release-checklist");

      expect(seen).toHaveLength(1);
      const req = seen[0]!;
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/SemanticSearch");
      expect(req.authorization?.startsWith(`TPS-Ed25519 ${AGENT}:`)).toBe(true);
      expect(req.body.agentId).toBe(AGENT);
      expect(String(req.body.q)).toContain("Jev");
      expect(String(req.body.q)).not.toContain("https://");
      expect(JSON.stringify(seen)).not.toContain("Basic ");
      expect(JSON.stringify(seen)).not.toContain(ADMIN_PASSWORD_SENTINEL);
    },
    CASE_BUDGET_MS,
  );

  test(
    "no key: the request carries no credential at all despite admin env; the refusal is one note line, exit 0",
    async () => {
      mode = "unauthorized";
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
        childEnv({ FLAIR_PROMPT_RECALL_TIMEOUT_MS: "500" }),
        payload(REPLAY_PROMPT),
        "flair-slow",
      );
      expect(run.status).toBe(0);
      expect(seen).toHaveLength(1); // the request was accepted and never answered
      const ctx = contextOf(run.stdout);
      expect(ctx.split("\n")).toHaveLength(1);
      expect(ctx).toContain("(timeout)");
      // A 500 ms budget plus process start-up. The bound is generous for a
      // loaded lane, and still well below flair-client's own 10 s request
      // timeout, which is what a process that waited on the socket would hit.
      expect(run.elapsedMs).toBeLessThan(6_000);
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
