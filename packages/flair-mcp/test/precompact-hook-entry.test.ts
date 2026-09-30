/**
 * precompact-hook-entry.test.ts — flair#2069: the `flair-precompact` ENTRY
 * POINT, spawned as its own process with the real flair-client, against a
 * loopback HTTP stand-in for Flair; and `flair-session-start`, spawned the
 * same way, reading back what it wrote.
 *
 * What only a spawned process can show: the exit code (always 0, so a
 * PreCompact hook never blocks compaction), that the process ends within
 * its budget whatever asynchronous work is still pending (stdin held open, a
 * write never answered), what goes on the wire, and the full loop the issue asks for:
 * a compaction writes ONE record, a rerun keeps it one, and the next session
 * start shows it at the top, after a compaction and after a restart. And that
 * the hook's own local files cannot hold it past its budget: an oversize or
 * non-regular state file or marker is refused before any byte is read.
 *
 * The stand-in authenticates the way Flair does: it parses the Authorization
 * header and verifies the Ed25519 signature over the canonical payload with
 * Flair's OWN verifier code (resources/ed25519-auth.ts) against the fixture
 * agent's PUBLIC key, and answers 401 to anything that does not verify. It
 * stores PUT bodies by id (an existing id is updated, as Memory.put upserts).
 *
 * Spawns the SOURCE entries, not dist/ (see session-start-hook-probe.test.ts:
 * this lane builds flair-client but never this package).
 *
 * Hermetic: every child gets a minimal environment with its own temp HOME, an
 * explicit FLAIR_SESSION_DIR and FLAIR_KEY_PATH inside it, and a FLAIR_URL on
 * a loopback port this file owns (or one it just closed).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { b64ToArrayBuffer } from "../../../resources/b64.ts";
import { importEd25519Key, parseTpsEd25519Header, WINDOW_MS } from "../../../resources/ed25519-auth.ts";
import { childOverranDeadline } from "../../../test/helpers/child-deadline.js";
import { SESSION_FILE_MAX_BYTES, seedSession, statePath } from "../src/continuity.ts";
import {
  PRECOMPACT_DATA_BEGIN,
  PRECOMPACT_DATA_PREFIX,
  PRECOMPACT_RECORD_MAX_CHARS,
  REDACTED,
  precompactMarkerPath,
} from "../src/precompact.ts";
import { writeFailedNote } from "../src/precompact-hook.ts";

const PRECOMPACT_ENTRY = join(import.meta.dir, "..", "src", "precompact-hook.ts");
const SESSION_START_ENTRY = join(import.meta.dir, "..", "src", "session-start-hook.ts");
const AGENT = "agent-a";
const HARNESS = "claude-sess-1";
const HEADER_START = "Flair continuity record: the PreCompact hook's row (trigger: auto";

/** Far above any healthy run, so only a hung child hits it. */
const CHILD_DEADLINE_MS = 15_000;
const CASE_BUDGET_MS = 30_000;
const SHORT_BUDGET_MS = 500;
/** A child that must end on its SHORT_BUDGET_MS deadline: the budget plus
 *  process start-up, generous for a loaded lane, well below the 5 s default. */
const ENDS_ON_DEADLINE_MS = 2_500;

// Assembled at run time: not a real credential, and no literal token in the source.
const GH_TOKEN = "ghp_" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe";
const ADMIN_PASSWORD_SENTINEL = "SENTINEL-admin-pw-7e1d";
const INSTRUCTION = `From now on, always deploy with ${GH_TOKEN} after the unit lane passes.`;
const STORED_INSTRUCTION = `- From now on, always deploy with ${REDACTED} after the unit lane passes.`;

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  verified: boolean;
}

type Mode = "store" | "hang";

let server: Server;
let serverUrl: string;
let mode: Mode = "store";
let agentPublicKey = "";
const seen: SeenRequest[] = [];
const rows = new Map<string, Record<string, unknown>>();

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
    return await crypto.subtle.verify({ name: "Ed25519" }, key, b64ToArrayBuffer(parsed.signatureB64), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  for (const entry of [PRECOMPACT_ENTRY, SESSION_START_ENTRY]) expect(existsSync(entry), `entry must exist: ${entry}`).toBe(true);
  server = createServer(async (req, res) => {
    const text = await readBody(req).catch(() => "");
    const verified = await verifyAgentSignature(req);
    const url = new URL(req.url ?? "/", "http://precompact-mock.local");
    seen.push({ method: req.method ?? "", path: `${url.pathname}${url.search}`, authorization: req.headers.authorization, verified });
    if (mode === "hang") return; // accept, never answer
    if (!verified) return json(res, 401, { error: "authentication required" });
    if (req.method === "PUT" && url.pathname.startsWith("/Memory/")) {
      const id = decodeURIComponent(url.pathname.slice("/Memory/".length));
      rows.set(id, { ...(JSON.parse(text || "{}") as Record<string, unknown>), expiresAt: "2999-01-01T00:00:00.000Z" });
      return json(res, 200, { id });
    }
    if (req.method === "GET" && url.pathname === "/Memory" && url.searchParams.has("agentId")) return json(res, 200, [...rows.values()]);
    if (req.method === "GET" && url.pathname.startsWith("/Memory/")) {
      const row = rows.get(decodeURIComponent(url.pathname.slice("/Memory/".length)));
      return row ? json(res, 200, row) : json(res, 404, { error: "not found" });
    }
    if (req.method === "POST" && url.pathname === "/BootstrapMemories") return json(res, 200, { context: "## Bootstrap context" });
    return json(res, 200, {});
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
let sessionDir: string;
let keyPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-precompact-entry-"));
  sessionDir = join(home, ".flair", "session");
  keyPath = join(home, "agent.key");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), { mode: 0o600 });
  agentPublicKey = String(publicKey.export({ format: "jwk" }).x);
  seen.length = 0;
  rows.clear();
  mode = "store";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A minimal child environment: nothing inherited but PATH and the temp dir. */
/** A path under `home` as a note shows it: the child's HOME is `home`, so the note collapses it to "~". */
function shown(path: string): string {
  expect(path.startsWith(`${home}/`)).toBe(true);
  return `~${path.slice(home.length)}`;
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { HOME: home, USERPROFILE: home };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return {
    ...env,
    FLAIR_AGENT_ID: AGENT,
    FLAIR_KEY_PATH: keyPath,
    FLAIR_URL: serverUrl,
    FLAIR_SESSION_DIR: sessionDir,
    ...extra,
  };
}

interface EntryRun {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function runEntry(
  entry: string,
  env: Record<string, string>,
  input: string,
  leg: string,
  opts: { holdStdin?: boolean; deadlineMs?: number } = {},
): Promise<EntryRun> {
  const deadlineMs = opts.deadlineMs ?? CHILD_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [entry], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => child.kill("SIGTERM"), deadlineMs);
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      child.stdin.destroy();
      const run = { status, signal, stdout, stderr, elapsedMs: Math.round(performance.now() - start) };
      if (signal !== null) return reject(new Error(childOverranDeadline("precompact entry point", leg, deadlineMs, run)));
      resolve(run);
    });
    if (opts.holdStdin) child.stdin.write(input);
    else child.stdin.end(input);
  });
}

function writeTranscript(lines: readonly unknown[], name = "transcript.jsonl"): string {
  const path = join(home, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function transcriptLines(): unknown[] {
  return [
    { type: "user", message: { role: "user", content: INSTRUCTION } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/a.ts" } }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Edited a.ts; running the unit lane next." }] } },
  ];
}

function precompactInput(transcriptPath: string, trigger = "auto"): string {
  return JSON.stringify({ session_id: HARNESS, transcript_path: transcriptPath, cwd: "/repo", hook_event_name: "PreCompact", trigger });
}

function sessionStartInput(source: string, sessionId: string): string {
  return JSON.stringify({ session_id: sessionId, cwd: "/repo", hook_event_name: "SessionStart", source });
}

function contextOf(stdout: string): string {
  const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
  return parsed.hookSpecificOutput?.additionalContext ?? "";
}

/** The note output: exactly one JSON object with only a systemMessage. */
function noteOf(stdout: string): string {
  expect(stdout.split("\n")).toHaveLength(1);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["systemMessage"]);
  return String(parsed.systemMessage);
}

async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const addr = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!addr || typeof addr === "string") throw new Error("could not reserve a loopback port");
  return `http://127.0.0.1:${addr.port}`;
}

describe("flair-precompact entry point (spawned, real client)", () => {
  test(
    "acceptance: a compaction writes ONE signed record (secret redacted, bounded); a rerun keeps it one; the next session start shows it at the top, after a compaction and after a restart",
    async () => {
      // A session starts: flair-session-start seeds the continuity state.
      const boot = await runEntry(SESSION_START_ENTRY, childEnv(), sessionStartInput("startup", HARNESS), "session-start startup");
      expect(boot.status).toBe(0);

      const transcript = writeTranscript(transcriptLines());
      const first = await runEntry(PRECOMPACT_ENTRY, childEnv(), precompactInput(transcript), "precompact");
      expect(first.status).toBe(0);
      expect(first.stdout).toBe(""); // success is silent
      const puts = () => seen.filter((r) => r.method === "PUT");
      expect(puts()).toHaveLength(1);
      expect(puts()[0]!.verified).toBe(true); // signed with the agent's own key
      expect(rows.size).toBe(1);
      const [row] = [...rows.values()];
      const content = String(row!.content);
      expect(content).toContain(STORED_INSTRUCTION);
      expect(JSON.stringify(row)).not.toContain(GH_TOKEN);
      expect(content.length).toBeLessThanOrEqual(PRECOMPACT_RECORD_MAX_CHARS);
      expect(row!.durability).toBe("ephemeral");
      expect(row!.visibility).toBe("private");

      // The hook runs again for the same compaction: still one record.
      const rerun = await runEntry(PRECOMPACT_ENTRY, childEnv(), precompactInput(transcript), "precompact rerun");
      expect(rerun.status).toBe(0);
      expect(puts()).toHaveLength(2);
      expect(rows.size).toBe(1);

      // Session start after the compaction: the record first, then bootstrap.
      const afterCompact = await runEntry(SESSION_START_ENTRY, childEnv(), sessionStartInput("compact", HARNESS), "session-start compact");
      expect(afterCompact.status).toBe(0);
      const ctx = contextOf(afterCompact.stdout);
      expect(ctx.startsWith(HEADER_START)).toBe(true);
      expect(ctx.split("\n")[1]).toBe(PRECOMPACT_DATA_BEGIN); // the record is quoted data…
      expect(ctx).toContain(`\n${PRECOMPACT_DATA_PREFIX}${STORED_INSTRUCTION}\n`); // …every line of it prefixed
      expect(ctx.indexOf(STORED_INSTRUCTION)).toBeGreaterThan(0);
      expect(ctx.indexOf("## Bootstrap context")).toBeGreaterThan(ctx.indexOf(STORED_INSTRUCTION));
      expect(ctx).not.toContain(GH_TOKEN);

      // A restart (a new harness session): the previous session's record first.
      const restart = await runEntry(SESSION_START_ENTRY, childEnv(), sessionStartInput("startup", "claude-sess-2"), "session-start restart");
      expect(restart.status).toBe(0);
      const restartCtx = contextOf(restart.stdout);
      expect(restartCtx.startsWith(HEADER_START)).toBe(true);
      expect(restartCtx).toContain(STORED_INSTRUCTION);
      expect(seen.every((r) => r.verified)).toBe(true);
    },
    CASE_BUDGET_MS,
  );

  test(
    "Flair down: exit 0 and one note",
    async () => {
      seedSession(sessionDir, AGENT, HARNESS);
      const run = await runEntry(
        PRECOMPACT_ENTRY,
        childEnv({ FLAIR_URL: await closedPortUrl() }),
        precompactInput(writeTranscript(transcriptLines())),
        "flair-down",
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(writeFailedNote("unreachable"));
      expect(noteOf(run.stdout)).toContain("could not be confirmed (unreachable), so it may be missing");
    },
    CASE_BUDGET_MS,
  );

  test(
    "Flair slow: the process exits 0 on its budget with the write still open",
    async () => {
      seedSession(sessionDir, AGENT, HARNESS);
      mode = "hang";
      const run = await runEntry(
        PRECOMPACT_ENTRY,
        childEnv({ FLAIR_PRECOMPACT_TIMEOUT_MS: String(SHORT_BUDGET_MS) }),
        precompactInput(writeTranscript(transcriptLines())),
        "flair-slow",
      );
      expect(run.status).toBe(0);
      expect(seen.filter((r) => r.method === "PUT")).toHaveLength(1); // sent, never answered
      expect(run.stdout).toBe(writeFailedNote("timeout"));
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
    },
    CASE_BUDGET_MS,
  );

  test(
    "stdin held open: the deadline armed before stdin is read ends the hook with one note, exit 0",
    async () => {
      seedSession(sessionDir, AGENT, HARNESS);
      const run = await runEntry(
        PRECOMPACT_ENTRY,
        childEnv({ FLAIR_PRECOMPACT_TIMEOUT_MS: String(SHORT_BUDGET_MS) }),
        precompactInput(writeTranscript(transcriptLines())),
        "held-stdin",
        { holdStdin: true, deadlineMs: 8_000 },
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(writeFailedNote("timeout"));
      expect(seen).toHaveLength(0); // stdin never ended, so nothing was written
      expect(run.elapsedMs).toBeGreaterThanOrEqual(SHORT_BUDGET_MS - 50);
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
    },
    CASE_BUDGET_MS,
  );

  test(
    "an oversized transcript: only its tail is read, the record stays bounded, and the hook ends within its budget",
    async () => {
      seedSession(sessionDir, AGENT, HARNESS);
      const path = join(home, "big.jsonl");
      const fd = openSync(path, "w");
      try {
        const filler = JSON.stringify({ type: "user", message: { role: "user", content: `Always remember old rule ${"z".repeat(4000)}.` } }) + "\n";
        for (let i = 0; i < 2000; i++) writeSync(fd, filler); // ~8 MB, far over the 1 MiB tail cap
        for (const line of transcriptLines()) writeSync(fd, JSON.stringify(line) + "\n");
      } finally {
        closeSync(fd);
      }
      const run = await runEntry(
        PRECOMPACT_ENTRY,
        childEnv({ FLAIR_PRECOMPACT_TIMEOUT_MS: "1500" }),
        precompactInput(path),
        "oversized-transcript",
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
      expect(rows.size).toBe(1);
      const content = String([...rows.values()][0]!.content);
      expect(content.length).toBeLessThanOrEqual(PRECOMPACT_RECORD_MAX_CHARS);
      expect(content).toContain(STORED_INSTRUCTION); // positive control: the newest turn is in
    },
    CASE_BUDGET_MS,
  );

  test(
    "a FIFO at the transcript path is refused before it is opened: one note, no write, exit 0",
    async () => {
      seedSession(sessionDir, AGENT, HARNESS);
      const fifo = join(home, "fifo.jsonl");
      const made = spawnSync("mkfifo", [fifo], { encoding: "utf-8" });
      expect(made.status).toBe(0); // a missing mkfifo must FAIL, not skip the case
      const run = await runEntry(PRECOMPACT_ENTRY, childEnv(), precompactInput(fifo), "transcript-fifo", { deadlineMs: 8_000 });
      expect(run.status).toBe(0);
      expect(noteOf(run.stdout)).toContain("the transcript could not be read (not-a-file)");
      expect(seen).toHaveLength(0);
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
    },
    CASE_BUDGET_MS,
  );

  /** A SPARSE file far over the session-file cap: large to any reader, no disk used. */
  function sparseFile(path: string, bytes = 64 * 1024 * 1024): void {
    writeFileSync(path, "");
    truncateSync(path, bytes);
    expect(statSync(path).size).toBe(bytes);
  }

  test(
    "an oversize continuity state file: refused before any byte is read; one note, no request, no record, exit 0 within the budget",
    async () => {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      const path = statePath(sessionDir, AGENT, HARNESS);
      sparseFile(path);
      const run = await runEntry(
        PRECOMPACT_ENTRY,
        childEnv({ FLAIR_PRECOMPACT_TIMEOUT_MS: String(SHORT_BUDGET_MS) }),
        precompactInput(writeTranscript(transcriptLines())),
        "oversize-state",
      );
      expect(run.status).toBe(0);
      expect(noteOf(run.stdout)).toBe(
        `Flair: the continuity state file ${shown(path)} could not be read (larger than ${SESSION_FILE_MAX_BYTES} bytes), so no pre-compaction record was saved. Remove that file to reset it; flair-session-start recreates it when a session starts.`,
      );
      expect(seen).toHaveLength(0);
      expect(rows.size).toBe(0);
      expect(existsSync(precompactMarkerPath(sessionDir, AGENT))).toBe(false);
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
    },
    CASE_BUDGET_MS,
  );

  test(
    "an oversize marker: refused before any byte is read; one note, no request, no record, exit 0 within the budget",
    async () => {
      seedSession(sessionDir, AGENT, HARNESS);
      const markerPath = precompactMarkerPath(sessionDir, AGENT);
      sparseFile(markerPath);
      const run = await runEntry(
        PRECOMPACT_ENTRY,
        childEnv({ FLAIR_PRECOMPACT_TIMEOUT_MS: String(SHORT_BUDGET_MS) }),
        precompactInput(writeTranscript(transcriptLines())),
        "oversize-marker",
      );
      expect(run.status).toBe(0);
      expect(noteOf(run.stdout)).toBe(
        `Flair: the pre-compaction marker ${shown(markerPath)} could not be read (larger than ${SESSION_FILE_MAX_BYTES} bytes), so no record was saved. Remove that file to reset it.`,
      );
      expect(seen).toHaveLength(0);
      expect(rows.size).toBe(0);
      expect(statSync(markerPath).size).toBe(64 * 1024 * 1024); // left as it was
      expect(run.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
    },
    CASE_BUDGET_MS,
  );

  test(
    "a FIFO at the state path or the marker path is refused, never read (a synchronous read would block for good): one note each, exit 0",
    async () => {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      const statePipe = statePath(sessionDir, AGENT, HARNESS);
      expect(spawnSync("mkfifo", [statePipe], { encoding: "utf-8" }).status).toBe(0); // a missing mkfifo must FAIL, not skip
      const stateRun = await runEntry(
        PRECOMPACT_ENTRY,
        childEnv({ FLAIR_PRECOMPACT_TIMEOUT_MS: String(SHORT_BUDGET_MS) }),
        precompactInput(writeTranscript(transcriptLines())),
        "state-fifo",
        { deadlineMs: 8_000 },
      );
      expect(stateRun.status).toBe(0);
      expect(noteOf(stateRun.stdout)).toContain(`the continuity state file ${shown(statePipe)} could not be read (not a regular file)`);
      expect(stateRun.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);

      rmSync(statePipe);
      seedSession(sessionDir, AGENT, HARNESS);
      const markerPipe = precompactMarkerPath(sessionDir, AGENT);
      expect(spawnSync("mkfifo", [markerPipe], { encoding: "utf-8" }).status).toBe(0);
      const markerRun = await runEntry(
        PRECOMPACT_ENTRY,
        childEnv({ FLAIR_PRECOMPACT_TIMEOUT_MS: String(SHORT_BUDGET_MS) }),
        precompactInput(writeTranscript(transcriptLines())),
        "marker-fifo",
        { deadlineMs: 8_000 },
      );
      expect(markerRun.status).toBe(0);
      expect(noteOf(markerRun.stdout)).toContain(`the pre-compaction marker ${shown(markerPipe)} could not be read (not a regular file)`);
      expect(markerRun.elapsedMs).toBeLessThan(ENDS_ON_DEADLINE_MS);
      expect(seen).toHaveLength(0);
      expect(rows.size).toBe(0);
    },
    CASE_BUDGET_MS,
  );

  test(
    "no key: the write carries no credential at all despite admin env; the refusal is one note, exit 0",
    async () => {
      seedSession(sessionDir, AGENT, HARNESS);
      const run = await runEntry(
        PRECOMPACT_ENTRY,
        childEnv({ FLAIR_KEY_PATH: join(home, "missing.key"), FLAIR_ADMIN_USER: "admin", FLAIR_ADMIN_PASSWORD: ADMIN_PASSWORD_SENTINEL }),
        precompactInput(writeTranscript(transcriptLines())),
        "no-key",
      );
      expect(run.status).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.authorization).toBeUndefined(); // never admin Basic
      expect(noteOf(run.stdout)).toContain("could not be confirmed (auth), so it may be missing");
      expect(run.stdout).not.toContain(ADMIN_PASSWORD_SENTINEL);
      expect(rows.size).toBe(0);
    },
    CASE_BUDGET_MS,
  );

  test(
    "probe mode exits 0 silently, before stdin, files or network",
    async () => {
      seedSession(sessionDir, AGENT, HARNESS);
      const run = await runEntry(PRECOMPACT_ENTRY, childEnv({ FLAIR_HOOK_PROBE: "1" }), precompactInput(writeTranscript(transcriptLines())), "probe");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
      expect(seen).toHaveLength(0);
      expect(existsSync(precompactMarkerPath(sessionDir, AGENT))).toBe(false);
    },
    CASE_BUDGET_MS,
  );
});
