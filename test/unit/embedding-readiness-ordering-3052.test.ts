import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { memoryProviderTimeoutResponse } from "../../resources/memory-write-lock.ts";
import { warmEmbeddingModel, type FlairInstance } from "../smoke/helpers/flair-instance.ts";

/**
 * flair#3052 — ordering on both entry paths, hermetic.
 *
 * A real Harper with a warm model lets both entry paths pass even when the
 * readiness call is removed. These tests run the actual entry files against a
 * fake instance that answers the first warm-up write with the real
 * `503 memory_provider_timeout`, reports a row read-back only after a vector and
 * stamp are stored, and refuses the smoke path's application writes until then.
 * The stand-in CLI records when each command starts instead of sending writes to
 * the fake instance. The smoke test runs as its own bun process; the CLI script
 * runs as its own bash process.
 *
 * Two checks need no fake instance: the smoke `beforeAll` must register its
 * SETUP_TIMEOUT_MS budget (read from the AST, since Bun's 5 s default would
 * still let the fast hermetic run pass), and the readiness script must run
 * when it is invoked through a symlinked path.
 *
 * Both callers that record the step summary (the CLI entry's `main()` and the
 * smoke helper's `warmEmbeddingModel`) are also run against a fake whose
 * deletes fail after readiness is confirmed: the wait logs its success, the
 * warm-up fails naming what may remain, and no summary line is written.
 */

const ROOT = join(import.meta.dir, "..", "..");
const SUMMARY_LINE = /embedding model ready/;

interface FakeState {
  readyAt?: number;
  timeoutsRemaining: number;
  afterTimeouts: "success" | "error";
  violations: number;
  warmupWrites: number;
  warmRows: Map<string, Record<string, unknown>>;
  applicationWrites: Array<{ at: number; content: string }>;
  /** Every operations-API delete answers HTTP 500. */
  deletesFail: boolean;
}

function readJson(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: import("node:http").ServerResponse, status: number, body: string, contentType = "application/json"): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => { server.off("listening", onListening); reject(err); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startFakeHarper(mode: "retry" | "timeout-then-error", opts: { deletesFail?: boolean } = {}): Promise<{
  httpPort: number;
  state: FakeState;
  stop: () => Promise<void>;
}> {
  const state: FakeState = {
    timeoutsRemaining: 1,
    afterTimeouts: mode === "retry" ? "success" : "error",
    violations: 0,
    warmupWrites: 0,
    warmRows: new Map(),
    applicationWrites: [],
    deletesFail: opts.deletesFail ?? false,
  };
  let ops: Server | undefined;
  let http: Server | undefined;
  let httpPort = 0;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 20_000 + Math.floor(Math.random() * 20_000);
    const opsCandidate = createServer((req, res) => { void handleOps(req, res, state); });
    const httpCandidate = createServer((req, res) => { void handleHttp(req, res, state); });
    try {
      await listen(opsCandidate, candidate - 1);
    } catch {
      await close(opsCandidate);
      continue;
    }
    try {
      await listen(httpCandidate, candidate);
    } catch {
      await close(opsCandidate);
      await close(httpCandidate);
      continue;
    }
    ops = opsCandidate;
    http = httpCandidate;
    httpPort = candidate;
    break;
  }
  if (!ops || !http) throw new Error("could not bind a consecutive loopback port pair");

  return {
    httpPort,
    state,
    stop: async () => {
      await Promise.all([close(ops!), close(http!)]);
    },
  };
}

async function handleOps(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, state: FakeState): Promise<void> {
  const body = await readJson(req);
  if (body.operation === "insert") return send(res, 200, '{"inserted":1}');
  if (body.operation === "upsert") return send(res, 200, '{"upserted":1}');
  if (body.operation === "delete") {
    return state.deletesFail ? send(res, 500, '{"error":"delete_unavailable"}') : send(res, 200, '{"deleted":1}');
  }
  if (body.operation === "search_by_value") return send(res, 200, "[]");
  if (body.operation === "search_by_id") {
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    const rows = ids.map((id) => state.warmRows.get(id)).filter(Boolean);
    return send(res, 200, JSON.stringify(rows));
  }
  return send(res, 200, "{}");
}

async function handleHttp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, state: FakeState): Promise<void> {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (req.method === "GET" && path === "/Health") return send(res, 200, "ok", "text/plain");
  if (req.method === "PUT" && path.startsWith("/Memory/")) {
    const body = await readJson(req);
    const content = String(body.content ?? "");
    if (content.startsWith("embedding warm-up ")) {
      if (state.timeoutsRemaining > 0) {
        state.timeoutsRemaining -= 1;
        const refusal = memoryProviderTimeoutResponse();
        return send(res, refusal.status, await refusal.text());
      }
      if (state.afterTimeouts === "error") {
        return send(res, 500, '{"error":"provider_unavailable"}');
      }
      state.warmupWrites += 1;
      const id = String(body.id ?? "");
      state.warmRows.set(id, { id, embedding: [0.1, 0.2], embeddingModel: "fake-model" });
      state.readyAt ??= Date.now();
      return send(res, 200, "{}");
    }
    if (state.readyAt === undefined) {
      state.violations += 1;
      return send(res, 503, '{"error":"no_application_write_before_readiness"}');
    }
    state.applicationWrites.push({ at: Date.now(), content });
    return send(res, 200, "{}");
  }
  if (req.method === "POST" && path === "/SemanticSearch") {
    if (state.readyAt === undefined) return send(res, 503, "{}");
    return send(res, 200, JSON.stringify({ results: [{ id: "m1", content: "smoke test marker" }] }));
  }
  if (req.method === "POST" && path === "/BootstrapMemories") {
    if (state.readyAt === undefined) return send(res, 503, "{}");
    return send(res, 200, JSON.stringify({ context: "ctx", tokenEstimate: 1, memoriesIncluded: 1 }));
  }
  return send(res, 404, "{}");
}

function fakeCliSource(): string {
  return `const fs = require("node:fs");
const log = process.env.FAKE_CLI_LOG;
const store = process.env.FAKE_CLI_STORE;
const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];
const record = (line) => fs.appendFileSync(log, line + "\\n");
if (cmd === "status") { console.log("status ok"); process.exit(0); }
if (cmd === "agent" && sub === "add") { record("agent " + Date.now() + " " + args[2]); process.exit(0); }
if (cmd === "memory" && sub === "add") {
  const content = args[args.indexOf("--content") + 1];
  fs.writeFileSync(store, content);
  record("memory " + Date.now() + " " + content);
  process.exit(0);
}
if (cmd === "memory" && sub === "list") {
  console.log(fs.existsSync(store) ? fs.readFileSync(store, "utf8") : "");
  process.exit(0);
}
if (cmd === "memory" && sub === "search") {
  console.log(JSON.stringify({ results: [{ id: "m1", content: "quick brown fox" }] }));
  process.exit(0);
}
console.error("fake cli: unsupported " + args.join(" "));
process.exit(1);
`;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 60_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}${String(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function prepareCliFixture(dir: string): string {
  const scriptDir = join(dir, "test");
  mkdirSync(scriptDir, { recursive: true });
  copyFileSync(join(ROOT, "test", "e2e-cli.sh"), join(scriptDir, "e2e-cli.sh"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "cli.js"), fakeCliSource());
  mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
  copyFileSync(
    join(ROOT, "scripts", "ci", "embedding-readiness.mjs"),
    join(dir, "scripts", "ci", "embedding-readiness.mjs"),
  );
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  return scriptDir;
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("flair#3052 — ordering on the smoke entry path", () => {
  test("the warm-up succeeds before the first application write", async () => {
    const fake = await startFakeHarper("retry");
    const dir = mkdtempSync(join(tmpdir(), "flair-3052-smoke-"));
    dirs.push(dir);
    try {
      const result = await run(process.execPath, ["test", "test/smoke/golden-path.test.ts"], {
        ...process.env,
        FLAIR_TEST_URL: `http://127.0.0.1:${fake.httpPort}`,
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        FLAIR_ADMIN_USER: "admin",
        FLAIR_ADMIN_PASS: "admin123",
      });
      const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
      expect(result.status, output).toBe(0);
      expect(fake.state.violations, output).toBe(0);
      expect(fake.state.timeoutsRemaining).toBe(0);
      expect(fake.state.warmupWrites).toBeGreaterThanOrEqual(1);
      expect(fake.state.applicationWrites.length).toBeGreaterThan(0);
      expect(fake.state.applicationWrites[0].at).toBeGreaterThanOrEqual(fake.state.readyAt!);
      const summary = readFileSync(join(dir, "summary.md"), "utf8");
      expect(summary).toMatch(SUMMARY_LINE);
    } finally {
      await fake.stop();
    }
  }, 90_000);

  test("a readiness failure stops the first application write", async () => {
    const fake = await startFakeHarper("timeout-then-error");
    const dir = mkdtempSync(join(tmpdir(), "flair-3052-smoke-fail-"));
    dirs.push(dir);
    try {
      const result = await run(process.execPath, ["test", "test/smoke/golden-path.test.ts"], {
        ...process.env,
        FLAIR_TEST_URL: `http://127.0.0.1:${fake.httpPort}`,
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        FLAIR_ADMIN_USER: "admin",
        FLAIR_ADMIN_PASS: "admin123",
      });
      const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("smoke warm-up");
      expect(output).toContain("not memory_provider_timeout");
      expect(fake.state.applicationWrites).toEqual([]);
      expect(readIfExists(join(dir, "summary.md"))).toBe("");
    } finally {
      await fake.stop();
    }
  }, 90_000);
});

describe("flair#3052 — ordering on the CLI E2E entry path", () => {
  test("the CLI writes only after readiness succeeds", async () => {
    const fake = await startFakeHarper("retry");
    const dir = mkdtempSync(join(tmpdir(), "flair-3052-cli-"));
    dirs.push(dir);
    const scriptDir = prepareCliFixture(dir);
    const log = join(dir, "cli.log");
    const store = join(dir, "store.txt");
    try {
      const result = await run("bash", [join(scriptDir, "e2e-cli.sh")], {
        ...process.env,
        FLAIR_PORT: String(fake.httpPort),
        FLAIR_ADMIN_PASS: "admin123",
        EMBEDDING_READY_DEADLINE_MS: "5000",
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        FAKE_CLI_LOG: log,
        FAKE_CLI_STORE: store,
      });
      const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
      expect(result.status, output).toBe(0);
      expect(fake.state.readyAt, output).toBeTruthy();
      const lines = readFileSync(log, "utf8").trim().split("\n");
      const memoryAdd = lines.find((line) => line.startsWith("memory "));
      expect(memoryAdd, lines.join("\n")).toBeTruthy();
      const at = Number(memoryAdd!.split(" ")[1]);
      expect(at).toBeGreaterThanOrEqual(fake.state.readyAt!);
      const agentAdd = lines.find((line) => line.startsWith("agent "));
      expect(agentAdd, lines.join("\n")).toBeTruthy();
      expect(Number(agentAdd!.split(" ")[1])).toBeGreaterThanOrEqual(fake.state.readyAt!);
      expect(output).toMatch(/Integration Tests \(E2E CLI\): embedding ready after \d+ms and \d+ attempt\(s\)/);
      expect(readFileSync(join(dir, "summary.md"), "utf8")).toMatch(
        /- Integration Tests \(E2E CLI\): embedding model ready in \d+ ms after \d+ attempt\(s\)\n/,
      );
    } finally {
      await fake.stop();
    }
  }, 90_000);

  test("a readiness failure stops every CLI write", async () => {
    const fake = await startFakeHarper("timeout-then-error");
    const dir = mkdtempSync(join(tmpdir(), "flair-3052-cli-fail-"));
    dirs.push(dir);
    const scriptDir = prepareCliFixture(dir);
    const log = join(dir, "cli.log");
    const store = join(dir, "store.txt");
    try {
      const result = await run("bash", [join(scriptDir, "e2e-cli.sh")], {
        ...process.env,
        FLAIR_PORT: String(fake.httpPort),
        FLAIR_ADMIN_PASS: "admin123",
        EMBEDDING_READY_DEADLINE_MS: "5000",
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        FAKE_CLI_LOG: log,
        FAKE_CLI_STORE: store,
      });
      const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("Integration Tests (E2E CLI)");
      expect(output).toContain("not memory_provider_timeout");
      expect(readIfExists(log).trim()).toBe("");
      expect(readIfExists(store)).toBe("");
    } finally {
      await fake.stop();
    }
  }, 90_000);
});

describe("flair#3052 — the smoke setup hook registers its budget", () => {
  /** Every top-level `beforeAll(...)` call in the golden path, read from the AST. */
  function beforeAllCalls(): ts.CallExpression[] {
    const file = join(ROOT, "test", "smoke", "golden-path.test.ts");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "beforeAll") {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return calls;
  }

  test("beforeAll passes SETUP_TIMEOUT_MS as its second argument", () => {
    const calls = beforeAllCalls();
    expect(calls.length).toBe(1);
    const timeout = calls[0].arguments[1];
    expect(timeout, "beforeAll registers no timeout, so Bun's 5 s hook default applies").toBeDefined();
    expect(ts.isIdentifier(timeout!) ? timeout.text : timeout!.getText()).toBe("SETUP_TIMEOUT_MS");
  });
});

describe("flair#3052 — the readiness script runs through a symlinked path", () => {
  test("invoked through a symlink, the entry still runs main() and fails on a bad flag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-3052-entry-link-"));
    dirs.push(dir);
    const link = join(dir, "embedding-readiness.mjs");
    symlinkSync(join(ROOT, "scripts", "ci", "embedding-readiness.mjs"), link);
    const result = await run("node", [link, "--deadline-ms", "0"], { ...process.env }, 15_000);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("--deadline-ms must be a positive number");
  }, 20_000);
});

describe("flair#3052 — the step summary is written only when readiness is confirmed and its cleanup succeeds", () => {
  test("CLI entry: confirmed readiness with failed deletes logs the wait, fails naming what may remain, and writes no summary", async () => {
    const fake = await startFakeHarper("retry", { deletesFail: true });
    const dir = mkdtempSync(join(tmpdir(), "flair-3052-cli-cleanup-"));
    dirs.push(dir);
    const summary = join(dir, "summary.md");
    try {
      const result = await run("node", [
        join(ROOT, "scripts", "ci", "embedding-readiness.mjs"),
        "--base-url", `http://127.0.0.1:${fake.httpPort}`,
        "--label", "cleanup-failure CLI",
        "--deadline-ms", "5000",
      ], {
        ...process.env,
        FLAIR_ADMIN_USER: "admin",
        FLAIR_ADMIN_PASS: "admin123",
        GITHUB_STEP_SUMMARY: summary,
      }, 30_000);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status, output).toBe(1);
      expect(fake.state.readyAt, output).toBeTruthy();
      expect(result.stdout).toMatch(/cleanup-failure CLI: embedding ready after \d+ms and \d+ attempt\(s\)/);
      expect(result.stderr).toContain("cleanup-failure CLI: embedding warm-up cleanup failed; these rows may remain");
      expect(result.stderr).toMatch(/Memory \[embedding-warmup-/);
      expect(result.stderr).toMatch(/Agent \[embedding-warmup-/);
      expect(readIfExists(summary)).toBe("");
    } finally {
      await fake.stop();
    }
  }, 40_000);

  test("smoke caller: confirmed readiness with failed deletes rejects and writes no summary", async () => {
    const fake = await startFakeHarper("retry", { deletesFail: true });
    const dir = mkdtempSync(join(tmpdir(), "flair-3052-smoke-cleanup-"));
    dirs.push(dir);
    const summary = join(dir, "summary.md");
    const savedSummary = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summary;
    try {
      const flair: FlairInstance = {
        baseUrl: `http://127.0.0.1:${fake.httpPort}`,
        opsUrl: `http://127.0.0.1:${fake.httpPort - 1}`,
        adminUser: "admin",
        adminPass: "admin123",
        authHeader: `Basic ${Buffer.from("admin:admin123").toString("base64")}`,
        cleanup: async () => {},
      };
      const error = await warmEmbeddingModel(flair, { deadlineMs: 5_000 }).then(() => null, (err: Error) => err);

      expect(fake.state.readyAt).toBeTruthy();
      expect(error?.message).toContain("smoke warm-up: embedding warm-up cleanup failed; these rows may remain");
      expect(error?.message).toMatch(/Agent \[embedding-warmup-/);
      expect(readIfExists(summary)).toBe("");
    } finally {
      if (savedSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = savedSummary;
      await fake.stop();
    }
  }, 30_000);
});
