/**
 * Remote principal state changes through the built CLI. Runs with loopback
 * listeners outside the restricted agent sandbox. The same suite checks the
 * local fallback and both enable/disable verbs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
// mcp enable's served-instance resolver uses ops port 9925. Bind an unusual
// loopback address so this stub cannot be confused with a real local instance.
const REMOTE_HOST = "127.77.21.14";
const REMOTE_OPS_PORT = 9925;
const REMOTE_INSTANCE = `http://${REMOTE_HOST}:19926`;
interface Observed { operation: string; authorization: string; body: any; url: string }
type Mode = "ok" | "empty-body" | "empty-result" | "error-payload" | "wrong-state" | "read-empty" | "read-error" | "read-other-id" | "deny" | "redirect" | "hang";

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, ...args], {
      cwd: env.HOME,
      env: { ...process.env, FLAIR_AGENT_ID: "", FLAIR_URL: "", FLAIR_OPS_PORT: "", FLAIR_TARGET: "", FLAIR_OPS_TARGET: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, { status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr })));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

async function startStub(host: string, port: number) {
  const seen: Observed[] = [];
  let mode: Mode = "ok";
  let redirectTo = "";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ operation: body.operation, authorization: String(req.headers.authorization ?? ""), body, url: req.url ?? "" });
      if (mode === "hang") return;
      if (mode === "redirect") {
        res.writeHead(307, { Location: redirectTo });
        res.end();
        return;
      }
      if (mode === "deny") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"secret-response-token"}');
        return;
      }
      const response = body.operation === "update"
        ? mode === "empty-body" ? "" : mode === "empty-result" ? "[]" : mode === "error-payload" ? '{"error":"secret-response-token"}' : JSON.stringify({ update_hashes: [body.records[0].id], skipped_hashes: [] })
        : seen.length === 1 ? JSON.stringify([{ id: body.search_value, status: expectedStatus }]) : mode === "read-empty" ? "[]" : mode === "read-error" ? '{"error":"secret-response-token"}' : JSON.stringify([{ id: mode === "read-other-id" ? "mallory" : body.search_value, status: mode === "wrong-state" ? "active" : body.search_value === "bob" ? "active" : expectedStatus }]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return { server, seen, port: boundPort, url: `http://${host}:${boundPort}`, setMode: (m: Mode) => { mode = m; }, setRedirect: (u: string) => { redirectTo = u; } };
}

let expectedStatus = "deactivated";
const args = (verb: "disable" | "enable", id = "alice") => ["principal", verb, id, "--instance", REMOTE_INSTANCE, "--admin-pass", "target-pass-2114"];

// Tests are sequential: each case sets the stub's response mode and inspects
// the exact requests made by one child process.
describe("principal disable/enable remote instance (#2114)", () => {
  let scratch: string;
  let remote: Awaited<ReturnType<typeof startStub>>;
  let local: Awaited<ReturnType<typeof startStub>>;
  let sink: Awaited<ReturnType<typeof startStub>>;
  beforeAll(async () => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-2114-home-"));
    remote = await startStub(REMOTE_HOST, REMOTE_OPS_PORT);
    local = await startStub("127.0.0.1", 0);
    sink = await startStub("127.0.0.1", 0);
  });
  afterAll(async () => {
    for (const stub of [remote, local, sink]) {
      stub.server.closeAllConnections();
      await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  for (const [verb, status, word] of [["disable", "deactivated", "deactivated"], ["enable", "active", "activated"]] as const) {
    test(`${verb}: explicit --instance wins over all ambient targets and confirms ${status}`, async () => {
      remote.seen.length = 0;
      sink.seen.length = 0;
      remote.setMode("ok");
      expectedStatus = status;
      const result = await runCli(args(verb), { HOME: scratch, FLAIR_URL: "https://wrong.example", FLAIR_TARGET: sink.url, FLAIR_OPS_TARGET: sink.url, FLAIR_ADMIN_PASS: "local-secret" });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Principal 'alice' ${word}`);
      expect(remote.seen.map((x) => x.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
      expect(remote.seen[1].body.records[0]).toMatchObject({ id: "alice", status });
      expect(remote.seen[2].body.search_value).toBe("alice");
      expect(remote.seen[0].authorization).toBe(`Basic ${Buffer.from("admin:target-pass-2114").toString("base64")}`);
      expect(sink.seen).toHaveLength(0);
    }, 25_000);
  }

  test("FLAIR_URL supplies the instance when --instance is absent", async () => {
    remote.seen.length = 0;
    remote.setMode("ok");
    expectedStatus = "deactivated";
    const result = await runCli(["principal", "disable", "alice", "--admin-pass", "target-pass-2114"], { HOME: scratch, FLAIR_URL: REMOTE_INSTANCE, FLAIR_OPS_TARGET: sink.url });
    expect(result.code).toBe(0);
    expect(remote.seen).toHaveLength(3);
  }, 25_000);

  test("local fallback uses --ops-port only when no instance is set", async () => {
    local.seen.length = 0;
    local.setMode("ok");
    expectedStatus = "active";
    const result = await runCli(["principal", "enable", "bob", "--ops-port", String(local.port), "--admin-pass", "local-pass"], { HOME: scratch, FLAIR_OPS_TARGET: sink.url });
    expect(result.code).toBe(0);
    expect(local.seen.map((x) => x.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
    expect(result.stdout).toContain("Principal 'bob' activated");
  }, 25_000);

  test("empty explicit --instance refuses even when FLAIR_URL and FLAIR_OPS_TARGET are set", async () => {
    remote.seen.length = 0;
    const result = await runCli(["principal", "disable", "alice", "--instance", "", "--admin-pass", "pass"], { HOME: scratch, FLAIR_URL: REMOTE_INSTANCE, FLAIR_OPS_TARGET: sink.url });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--instance is empty");
    expect(remote.seen).toHaveLength(0);
  }, 25_000);

  test("remote credential must be explicit even with local env password", async () => {
    remote.seen.length = 0;
    const result = await runCli(["principal", "enable", "alice", "--instance", REMOTE_INSTANCE], { HOME: scratch, FLAIR_ADMIN_PASS: "local-secret", FLAIR_OPS_TARGET: sink.url });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--admin-pass");
    expect(remote.seen).toHaveLength(0);
  }, 25_000);

  test("empty explicit remote password never falls back to the local env password", async () => {
    remote.seen.length = 0;
    const result = await runCli([...args("disable").slice(0, -1), ""], { HOME: scratch, FLAIR_ADMIN_PASS: "local-secret" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--admin-pass");
    expect(remote.seen).toHaveLength(0);
  }, 25_000);

  for (const mode of ["empty-body", "empty-result", "error-payload", "wrong-state", "read-empty", "read-error", "read-other-id"] as const) {
    test(`2xx ${mode} never reports success`, async () => {
      remote.seen.length = 0;
      remote.setMode(mode);
      expectedStatus = "deactivated";
      const result = await runCli(args("disable"), { HOME: scratch, FLAIR_OPS_TARGET: sink.url });
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("deactivated");
      expect(result.stderr).toContain("Check");
      expect(result.stderr).not.toContain("secret-response-token");
      const readBack = mode === "wrong-state" || mode === "read-empty" || mode === "read-error" || mode === "read-other-id";
      expect(remote.seen.map((x) => x.operation)).toEqual(readBack
        ? ["search_by_value", "update", "search_by_value"]
        : ["search_by_value", "update"]);
      expect(result.stderr).toContain(readBack ? "the read-back found" : "did not confirm the update");
    }, 25_000);
  }

  test("401 and its response body refuse without disclosing body text", async () => {
    remote.setMode("deny");
    const result = await runCli(args("disable"), { HOME: scratch });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HTTP 401");
    expect(result.stderr).toContain("--admin-pass");
    expect(result.stderr).not.toContain("secret-response-token");
  }, 25_000);

  test("redirect is refused and the admin credential never reaches its destination", async () => {
    remote.setMode("redirect");
    remote.setRedirect(sink.url);
    sink.seen.length = 0;
    const result = await runCli(args("disable"), { HOME: scratch, FLAIR_OPS_TARGET: sink.url });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("redirected");
    expect(sink.seen).toHaveLength(0);
  }, 25_000);

  test("unparseable target reports a target-specific remedy without printing supplied URL text", async () => {
    const result = await runCli(["principal", "disable", "alice", "--instance", "http://%bad/path-secret", "--admin-pass", "pass"], { HOME: scratch });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("invalid --instance target");
    expect(result.stderr).toContain("operations API address");
    expect(result.stderr).toContain("<unparseable URL>");
    expect(result.stderr).not.toContain("path-secret");
    expect(result.stderr).not.toContain("http://%bad/path-secret");
  }, 25_000);

  test("a parseable URL containing userinfo is refused without printing either secret", async () => {
    const result = await runCli(["principal", "disable", "alice", "--instance", `http://user:pass@${REMOTE_HOST}:19926/?token=topsecret`, "--admin-pass", "pass"], { HOME: scratch });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("invalid --instance target");
    expect(result.stderr).not.toContain("user:pass");
    expect(result.stderr).not.toContain("topsecret");
  }, 25_000);

  test.each([
    `user:pass@${REMOTE_HOST}:19926/?token=topsecret`,
    `user:pass@${REMOTE_HOST}:19926/?token=topsecret&next=a://b`,
  ])("a scheme-less target with userinfo is refused without printing either secret: %s", async (instance) => {
    const result = await runCli(["principal", "disable", "alice", "--instance", instance, "--admin-pass", "other"], { HOME: scratch });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("invalid --instance target");
    expect(result.stderr).not.toContain("pass");
    expect(result.stderr).not.toContain("topsecret");
  }, 25_000);

  test("unreachable target never prints the raw fetch error or query token", async () => {
    const result = await runCli(["principal", "disable", "alice", "--instance", "http://127.77.21.13/?token=topsecret", "--admin-pass", "pass"], { HOME: scratch });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("could not disable lookup");
    expect(result.stderr).not.toContain("topsecret");
    expect(result.stderr).toContain("Check --instance");
  }, 25_000);

  test("target that never answers times out with a remedy", async () => {
    remote.setMode("hang");
    const started = Date.now();
    const result = await runCli(args("disable"), { HOME: scratch });
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(18_000);
    expect(result.stderr).toContain("Check --instance");
    expect(result.stdout).not.toContain("deactivated");
  }, 25_000);
});
