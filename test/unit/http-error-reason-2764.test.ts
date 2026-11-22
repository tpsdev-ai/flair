/**
 * flair#2764 — when sendJsonRequest builds the error from a failed response's
 * body (every failure except a refused redirect, a credential-less 403 and a
 * response with `Content-Length: 0`), the ApiHttpError message is
 * `HTTP <status>` plus the JSON body's named error, or else a bounded one-line
 * excerpt of the body, and the error keeps the body's display form, which
 * sendJsonRequest writes to stderr only with FLAIR_DEBUG set (a JSON body shown
 * re-serialized, or withheld when it cannot be). In the message, `body`, that
 * stderr line and the rem display texts, the credential values the CLI reads
 * from the request's Authorization header (a Basic password and a TPS-Ed25519
 * signature read with Flair's server grammar) are replaced with `[redacted]` in
 * the text the server supplied, and a non-empty response's text is withheld
 * (in the rem display texts too, even when the text derived from it is empty)
 * when the header names basic, bearer or tps-ed25519 but its credential cannot
 * be read. Scope: redaction removes
 * the request's credential values from the text the server supplied (literal,
 * inside any JSON string, percent-encoded); text the CLI writes itself (the
 * `HTTP <status>: ` prefix, the debug line's labels, a caller's `Error: `
 * prefix) is never altered, so a credential that matches the CLI's own
 * wording, or matches only once that wording is joined to the server's text,
 * is not covered. Classifiers read the unredacted body. A zero-length failure keeps the message `HTTP <status>`,
 * and the credential-less 403 keeps main's hint.
 *
 * Every request that receives a fixture response goes through the real
 * sendJsonRequest to a node HTTP listener on 127.0.0.1 that this file starts;
 * the refused-connection case sends to a port whose listener it has closed. Two kinds of case spawn the built CLI
 * with a scratch HOME: the run-once describe names its listener with FLAIR_URL,
 * and the alternate-port case sets no FLAIR_URL, naming one listener in the
 * scratch `~/.flair/data/harper-config.yaml` and another in
 * `~/.flair/config.yaml`.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import {
  ApiHttpError,
  BASIC_HEADER_GRAMMAR,
  TPS_ED25519_HEADER_GRAMMAR,
  apiErrorBody,
  apiErrorRawBody,
  boundErrorText,
  credentialsInHeader,
  sendJsonRequest,
} from "../../src/lib/auth-resolve.ts";
import { TPS_ED25519_HEADER_RE, parseTpsEd25519Header } from "../../resources/ed25519-auth.ts";
import { BASIC_AUTH_HEADER_RE, parseBasicAuthHeader } from "../../resources/basic-auth-header.ts";
import { isNoBackendConfigured, isRemAbortedFailure, runNightlyCycle } from "../../src/rem/runner.ts";
import { describeReflectError } from "../../src/commands/rem.ts";
import {
  isFederationStatusAuthFailure,
  isFederationStatusAuthRemedy,
  isFederationStatusConnectFailure,
} from "../../src/commands/federation.ts";
import { proveAdminPassAgainstInstance } from "../../src/cli.ts";
import {
  FederationPairLocalAccessError,
  rewriteFederationPairLocalAccessError,
} from "../../src/lib/federation-pair-access.ts";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";

type Reply = { status: number; body: string };

async function startListener(route: (line: string, req: IncomingMessage) => Reply) {
  const seen: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const line = `${req.method} ${req.url}`;
      seen.push(line);
      const reply = route(line, req);
      res.writeHead(reply.status, { "Content-Type": "text/plain" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { seen, port, close };
}

const replies = new Map<string, Reply>();
let listener: Awaited<ReturnType<typeof startListener>>;

beforeAll(async () => {
  listener = await startListener((line) => replies.get(line) ?? { status: 404, body: `no route for ${line}` });
});
afterAll(async () => {
  if (listener) await listener.close();
});

/** GET `path` from this file's listener, answered with `reply`; returns the thrown ApiHttpError. */
async function failWith(
  path: string,
  reply: Reply,
  opts: { authHeader?: string; isLocal?: boolean; signedOnly?: { keysDir: string } } = { authHeader: "Basic fixture" },
): Promise<ApiHttpError> {
  replies.set(`GET ${path}`, reply);
  const url = new URL(path, `http://127.0.0.1:${listener.port}`);
  expect(url.host).toBe(`127.0.0.1:${listener.port}`);
  let caught: unknown;
  try {
    await sendJsonRequest(url, "GET", undefined, opts.authHeader, opts.isLocal ?? true, { signedOnly: opts.signedOnly });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiHttpError);
  return caught as ApiHttpError;
}

describe("flair#2764 — the reason a failed request prints", () => {
  test("a JSON error body prints its named error: error, else code, else message", async () => {
    const cases: Array<[number, unknown, string]> = [
      [503, { error: "rem_aborted", code: "E_PAUSE", message: "paused", detail: "operator pause" }, "HTTP 503: rem_aborted"],
      [429, { code: "E_QUOTA", message: "over quota" }, "HTTP 429: E_QUOTA"],
      [400, { message: "bad input" }, "HTTP 400: bad input"],
      [500, { error: { nested: true } }, 'HTTP 500: {"error":{"nested":true}}'],
    ];
    for (const [i, [status, json, expected]] of cases.entries()) {
      const body = JSON.stringify(json);
      const err = await failWith(`/json-${i}`, { status, body });
      expect(err.message).toBe(expected);
      expect(err.status).toBe(status);
      expect(err.body).toBe(body);
      expect(apiErrorBody(err)).toBe(body);
    }
  });

  test("a large text body prints the capped excerpt, and the error keeps the whole body", async () => {
    const body = `${"a".repeat(150)} ${"b".repeat(10_000)}`;
    const err = await failWith("/large", { status: 500, body });
    expect(err.message).toBe(`HTTP 500: ${"a".repeat(150)} ${"b".repeat(49)}...`);
    expect(err.body).toBe(body);
  });

  test("a zero-length error response prints the status alone, and the error's body is empty", async () => {
    const err = await failWith("/empty", { status: 500, body: "" });
    expect(err.message).toBe("HTTP 500");
    expect(err.body).toBe("");
    expect(err.noCredentials).toBe(false);
  });

  test("a body with newlines and control characters prints one clean line", async () => {
    const text = await failWith("/control", {
      status: 502,
      body: "\r\n  first line\r\n\tsecond\u001b[2J line\u0000\u0007\u009b end\u2028after\n\n",
    });
    expect(text.message).toBe("HTTP 502: first line second[2J line end after");
    const named = await failWith("/control-json", {
      status: 400,
      body: JSON.stringify({ error: "bad\nthing\u001b\u0007" }),
    });
    expect(named.message).toBe("HTTP 400: bad thing");
    for (const message of [text.message, named.message]) {
      expect(message).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/);
    }
  });

  test("FLAIR_DEBUG prints the full body to stderr; unset, no body line is written", async () => {
    const body = `${"x".repeat(5_000)}\nsecond line`;
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const saved = process.env.FLAIR_DEBUG;
    try {
      delete process.env.FLAIR_DEBUG;
      await failWith("/debug-off", { status: 500, body });
      process.env.FLAIR_DEBUG = "1";
      const err = await failWith("/debug-on", { status: 500, body });
      expect(err.message).toBe(`HTTP 500: ${"x".repeat(200)}...`);
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.FLAIR_DEBUG;
      else process.env.FLAIR_DEBUG = saved;
    }
    expect(written.filter((w) => w.startsWith("[flair] GET /debug-"))).toEqual([
      `[flair] GET /debug-on answered HTTP 500; response body: ${JSON.stringify(body)}\n`,
    ]);
  });

  test("the no-credentials 403 keeps main's hint text byte for byte, with a JSON body and a zero-length body", async () => {
    const cases: Array<[string, { isLocal: boolean; signedOnly?: { keysDir: string } }, string]> = [
      ["local", { isLocal: true }, "HTTP 403: no credentials sent. Set FLAIR_ADMIN_PASS, or run `flair init` to provision ~/.flair/admin-pass or an agent key."],
      ["remote", { isLocal: false }, "HTTP 403: no credentials sent. Set FLAIR_ADMIN_PASS (remote targets have no local admin-pass fallback)."],
      [
        "signed-only",
        { isLocal: true, signedOnly: { keysDir: "/fixture/keys" } },
        "HTTP 403: no credentials sent. This request can send only an Ed25519 agent signature; the admin password is not sent on this path. Provide the key of an agent registered on the target instance at /fixture/keys/<agent-id>.key.",
      ],
    ];
    for (const [shape, body] of [["json", JSON.stringify({ error: "forbidden" })], ["empty", ""]] as const) {
      for (const [name, opts, expected] of cases) {
        const err = await failWith(`/no-creds-${name}-${shape}`, { status: 403, body }, opts);
        expect(err.message, `${name}, ${shape} body`).toBe(expected);
        expect(err.status).toBe(403);
        expect(err.noCredentials).toBe(true);
      }
    }
  });
});

describe("flair#2764 — code that classifies a failure reads the full body", () => {
  test("a 503 rem pause and a 503 missing backend still classify", async () => {
    const paused = await failWith("/reflect-paused", { status: 503, body: JSON.stringify({ error: "rem_aborted", detail: "paused" }) });
    expect(isRemAbortedFailure(paused)).toBe(true);
    const noBackend = await failWith("/reflect-no-backend", {
      status: 503,
      body: JSON.stringify({ error: "No generative backend configured. See the models configuration docs." }),
    });
    expect(isNoBackendConfigured(noBackend)).toBe(true);
  });

  test("a 502 distillation_failed still reads as distillation-failed with its detail", async () => {
    const err = await failWith("/reflect-failed", {
      status: 502,
      body: JSON.stringify({ error: "distillation_failed", detail: "model output did not validate after one retry" }),
    });
    expect(describeReflectError(err)).toEqual({
      kind: "distillation-failed",
      text: "model output did not validate after one retry",
    });
  });

  test("an AccessViolation 403 whose named error is forbidden still becomes the named pair error", async () => {
    const err = await failWith("/FederationInstance", {
      status: 403,
      body: '{"type":"error:AccessViolation","error":"forbidden","instance":"/FederationInstance"}',
    });
    expect(err.message).toBe("HTTP 403: forbidden");
    const rewritten = rewriteFederationPairLocalAccessError(err, { url: "http://127.0.0.1:9926", agentId: "agent-a" });
    expect(rewritten).toBeInstanceOf(FederationPairLocalAccessError);
  });

  for (const [detail, expected] of [
    ["model output did not validate after one retry", "distillation: distillation_failed: model output did not validate after one retry"],
    [{ reason: "nested" }, "distillation: distillation_failed"],
  ] as const) {
    test(`rem's distillation error names the body's error${typeof detail === "string" ? " and string detail" : ", leaving out an object detail"}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "flair-2764-runner-"));
      const routes: Record<string, Reply> = {
        "GET /Memory": { status: 200, body: JSON.stringify([{ id: "m1", agentId: AGENT_ID, content: "first memory" }]) },
        "GET /Soul": { status: 200, body: "[]" },
        "POST /MemoryMaintenance": { status: 200, body: JSON.stringify({ expired: 0, archived: 0, total: 0, errors: 0 }) },
        "POST /ReflectMemories": { status: 502, body: JSON.stringify({ error: "distillation_failed", detail }) },
        "POST /MemoryDedupStats": {
          status: 200,
          body: JSON.stringify({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
        },
      };
      const own = await startListener((line) => routes[line.split("?")[0]] ?? { status: 404, body: `no route for ${line}` });
      try {
        const apiCall = (method: string, path: string, body?: unknown) =>
          sendJsonRequest(new URL(path, `http://127.0.0.1:${own.port}`), method, body, "Basic fixture", true);
        const r = await runNightlyCycle({
          agentId: AGENT_ID,
          flairVersion: "0.0.0-test",
          apiCall,
          snapshotRoot: join(root, "snapshots"),
          logPath: join(root, "rem-nightly.jsonl"),
          pauseFlagPath: join(root, "rem.paused"),
          envPaused: false,
          healthProbe: async () => ({ ok: true, elapsedMs: 1 }),
        });
        expect(r.logRow.errors, own.seen.join("\n")).toEqual([expected]);
      } finally {
        await own.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("describeReflectError leaves out an object detail of a distillation_failed body", async () => {
    const err = await failWith("/reflect-failed-object-detail", {
      status: 502,
      body: JSON.stringify({ error: "distillation_failed", detail: { reason: "nested" } }),
    });
    expect(describeReflectError(err)).toEqual({ kind: "distillation-failed", text: "distillation_failed" });
  });

  test("federation status still reads an auth marker outside the named error", async () => {
    const err = await failWith("/federation-status", {
      status: 400,
      body: JSON.stringify({ error: "bad_request", detail: "missing_or_invalid_authorization" }),
    });
    expect(err.message).toBe("HTTP 400: bad_request");
    expect(isFederationStatusAuthFailure(err)).toBe(true);
    expect(isFederationStatusAuthRemedy(err)).toBe(true);
  });

  test("the admin-password probe names a non-auth HTTP failure once, with the bounded reason", async () => {
    const routes: Record<string, Reply> = {};
    const own = await startListener((line) => routes[line] ?? { status: 404, body: `no route for ${line}` });
    try {
      for (const [reply, expected] of [
        [{ status: 500, body: JSON.stringify({ error: "boom" }) }, "admin credential verification could not be completed (HTTP 500: boom)"],
        [{ status: 503, body: "store down\n" }, "admin credential verification could not be completed (HTTP 503: store down)"],
      ] as const) {
        routes["GET /FederationPeers"] = reply;
        expect(await proveAdminPassAgainstInstance(own.port, "fixture-password")).toBe(expected);
      }
      expect(own.seen).toEqual(["GET /FederationPeers", "GET /FederationPeers"]);
    } finally {
      await own.close();
    }
  });
});

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const AGENT_ID = "agent-a";

function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("FLAIR_") && !key.startsWith("HDB_")) childEnv[key] = value;
    }
    Object.assign(childEnv, env);
    const child = spawn(nodeBin({ env: childEnv, cwd: env.HOME }), [CLI_PATH, ...args], {
      cwd: env.HOME,
      env: childEnv,
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

describe("flair#2764 — built CLI: flair rem nightly run-once lists the bounded reason under Errors:", () => {
  const body = `store down\r\n${"z".repeat(5_000)}`;
  let cliListener: Awaited<ReturnType<typeof startListener>>;
  let home: string;

  beforeAll(async () => {
    ensureCliBuild();
    home = mkdtempSync(join(tmpdir(), "flair-2764-cli-"));
    const keysDir = join(home, ".flair", "keys");
    mkdirSync(keysDir, { recursive: true });
    const kp = nacl.sign.keyPair();
    writeFileSync(join(keysDir, `${AGENT_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)), { mode: 0o600 });
    cliListener = await startListener((line) => {
      if (line === "GET /Health") return { status: 200, body: "[]" };
      if (line === `GET /Memory?agentId=${AGENT_ID}`) return { status: 503, body };
      if (line === `GET /Soul?agentId=${AGENT_ID}`) return { status: 200, body: "[]" };
      return { status: 404, body: `no route for ${line}` };
    });
  }, 120_000);

  afterAll(async () => {
    if (cliListener) await cliListener.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  for (const debug of [false, true]) {
    test(debug ? "with FLAIR_DEBUG=1 stderr also carries the full body" : "the Errors: line is the bounded reason", async () => {
      cliListener.seen.length = 0;
      const env: Record<string, string> = { HOME: home, FLAIR_URL: `http://127.0.0.1:${cliListener.port}` };
      if (debug) env.FLAIR_DEBUG = "1";
      const result = await runCli(["rem", "nightly", "run-once", "--agent", AGENT_ID, "--dry-run"], env);
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(cliListener.seen, detail).toEqual(["GET /Health", `GET /Memory?agentId=${AGENT_ID}`, `GET /Soul?agentId=${AGENT_ID}`]);
      const lines = result.stdout.split("\n");
      const errorsAt = lines.indexOf("Errors:");
      expect(errorsAt, detail).toBeGreaterThan(-1);
      expect(lines, detail).toContain(`Memories:   unknown (HTTP 503: store down ${"z".repeat(189)}...)`);
      expect(lines[errorsAt + 1], detail).toBe(`  - memory-count: HTTP 503: store down ${"z".repeat(189)}...`);
      expect(result.stdout, detail).not.toContain("z".repeat(190));
      const debugLine = `[flair] GET /Memory answered HTTP 503; response body: ${JSON.stringify(body)}`;
      if (debug) expect(result.stderr.split("\n"), detail).toContain(debugLine);
      else expect(result.stderr, detail).not.toContain("z".repeat(190));
      expect(result.code, detail).toBe(1);
    }, 30_000);
  }
});

describe("flair#2764 — an ApiHttpError is never a connect failure", () => {
  test("an HTTP error whose body says fetch failed is not a connect failure", async () => {
    const err = await failWith("/upstream-fetch-failed", { status: 502, body: "upstream fetch failed" });
    expect(err.message).toBe("HTTP 502: upstream fetch failed");
    expect(isFederationStatusConnectFailure(err)).toBe(false);
  });

  test("HTTP 502, 503 and 504 errors are not connect failures", async () => {
    for (const [status, body] of [[502, "Bad Gateway"], [503, "Service Unavailable"], [504, "Gateway Timeout"]] as const) {
      const err = await failWith(`/gateway-${status}`, { status, body });
      expect(err.status).toBe(status);
      expect(isFederationStatusConnectFailure(err), `HTTP ${status}`).toBe(false);
    }
  });

  test("a raw fetch failure is still a connect failure: TypeError fetch failed, and a refused connection", async () => {
    expect(isFederationStatusConnectFailure(new TypeError("fetch failed"))).toBe(true);
    const closed = await startListener(() => ({ status: 200, body: "" }));
    const port = closed.port;
    await closed.close();
    let caught: unknown;
    try {
      await sendJsonRequest(new URL("/Health", `http://127.0.0.1:${port}`), "GET", undefined, "Basic fixture", true);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(ApiHttpError);
    expect(isFederationStatusConnectFailure(caught), String(caught)).toBe(true);
  });

  test("the built CLI does not retry an HTTP 502 on the configured alternate port, and keeps the HTTP error", async () => {
    ensureCliBuild();
    const recordedHome = mkdtempSync(join(tmpdir(), "flair-2764-altport-"));
    const recorded = await startListener((line) => {
      if (line === "GET /Health") return { status: 200, body: "[]" };
      if (line === `GET /Memory?agentId=${AGENT_ID}`) return { status: 502, body: "upstream fetch failed" };
      if (line === `GET /Soul?agentId=${AGENT_ID}`) return { status: 200, body: "[]" };
      return { status: 404, body: `no route for ${line}` };
    });
    const alternate = await startListener(() => ({ status: 200, body: "[]" }));
    try {
      const flairDir = join(recordedHome, ".flair");
      mkdirSync(join(flairDir, "data"), { recursive: true });
      mkdirSync(join(flairDir, "keys"), { recursive: true });
      const kp = nacl.sign.keyPair();
      writeFileSync(join(flairDir, "keys", `${AGENT_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)), { mode: 0o600 });
      // Harper's record names the listener that answers 502; ~/.flair/config.yaml names
      // a different port, which api() tries only after a connect failure.
      writeFileSync(join(flairDir, "data", "harper-config.yaml"), `http:\n  port: ${recorded.port}\n`);
      writeFileSync(join(flairDir, "config.yaml"), `port: ${alternate.port}\n`);
      const result = await runCli(["rem", "nightly", "run-once", "--agent", AGENT_ID, "--dry-run"], { HOME: recordedHome });
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(recorded.seen, detail).toEqual(["GET /Health", `GET /Memory?agentId=${AGENT_ID}`, `GET /Soul?agentId=${AGENT_ID}`]);
      expect(alternate.seen, detail).toEqual([]);
      const lines = result.stdout.split("\n");
      const errorsAt = lines.indexOf("Errors:");
      expect(errorsAt, detail).toBeGreaterThan(-1);
      expect(lines[errorsAt + 1], detail).toBe("  - memory-count: HTTP 502: upstream fetch failed");
      expect(result.stdout + result.stderr, detail).not.toContain("Cannot reach the Flair instance");
      expect(result.code, detail).toBe(1);
    } finally {
      await recorded.close();
      await alternate.close();
      rmSync(recordedHome, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("flair#2764 — the credential values read from the request's header are redacted from the server's text in each output, within the stated scope", () => {
  const PASSWORD = "s3cret-pass-2764-fixture";
  const BASIC_CREDENTIAL = Buffer.from(`admin:${PASSWORD}`).toString("base64");
  const BASIC = `Basic ${BASIC_CREDENTIAL}`;

  /** GET /echo from a listener that answers 500 with a body built from the request's Authorization header. */
  async function failEcho(authHeader: string, bodyOf: (sent: string) => string, debug: boolean, path = "/echo") {
    const echo = await startListener((_line, req) => ({ status: 500, body: bodyOf(String(req.headers.authorization ?? "")) }));
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const saved = process.env.FLAIR_DEBUG;
    let caught: unknown;
    try {
      if (debug) process.env.FLAIR_DEBUG = "1";
      else delete process.env.FLAIR_DEBUG;
      await sendJsonRequest(new URL(path, `http://127.0.0.1:${echo.port}`), "GET", undefined, authHeader, true);
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.FLAIR_DEBUG;
      else process.env.FLAIR_DEBUG = saved;
      await echo.close();
    }
    expect(caught).toBeInstanceOf(ApiHttpError);
    return { err: caught as ApiHttpError, stderr: written.filter((w) => w.startsWith("[flair] GET ")).join("") };
  }

  for (const debug of [false, true]) {
    test(`a body echoing the Basic header, its credential, user:password and password${debug ? ", with FLAIR_DEBUG" : ""}`, async () => {
      const { err, stderr } = await failEcho(
        BASIC,
        (sent) => JSON.stringify({ error: `bad credential ${sent}`, detail: `password ${PASSWORD}; basic ${BASIC_CREDENTIAL}; user admin:${PASSWORD}` }),
        debug,
      );
      const shown = JSON.stringify({ error: "bad credential [redacted]", detail: "password [redacted]; basic [redacted]; user [redacted]" });
      expect(err.message).toBe("HTTP 500: bad credential [redacted]");
      expect(err.body).toBe(shown);
      expect(apiErrorBody(err)).toBe(shown);
      expect(stderr).toBe(debug ? `[flair] GET /echo answered HTTP 500; response body: ${JSON.stringify(shown)}\n` : "");
      for (const text of [err.message, err.body!, stderr]) {
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(BASIC_CREDENTIAL);
      }
      // The unredacted text stays available to classifiers, which read it.
      expect(apiErrorRawBody(err)).toContain(PASSWORD);
    });
  }

  test("a body echoing a Bearer token and a TPS-Ed25519 signature", async () => {
    const token = `tok-2764-${"q".repeat(40)}`;
    const bearer = await failEcho(`Bearer ${token}`, (sent) => `rejected ${sent} (token ${token})`, true);
    expect(bearer.err.message).toBe("HTTP 500: rejected [redacted] (token [redacted])");
    expect(bearer.stderr).toBe(`[flair] GET /echo answered HTTP 500; response body: ${JSON.stringify("rejected [redacted] (token [redacted])")}\n`);
    const signature = Buffer.from("signature-2764-fixture").toString("base64");
    const signed = await failEcho(`TPS-Ed25519 agent-a:1760000000000:nonce-2764:${signature}`, () => `bad signature ${signature}`, true);
    expect(signed.err.message).toBe("HTTP 500: bad signature [redacted]");
    for (const text of [bearer.err.message, bearer.stderr, signed.err.message, signed.stderr]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(signature);
    }
  });

  test("a body that is only the credential is replaced before the message is bounded", async () => {
    const shortPass = await failEcho(`Basic ${Buffer.from("admin:pw2764").toString("base64")}`, () => "pw2764", false);
    expect(shortPass.err.message).toBe("HTTP 500: [redacted]");
    const longToken = `tok-${"k".repeat(296)}`;
    const long = await failEcho(`Bearer ${longToken}`, () => longToken, false);
    expect(long.err.message).toBe("HTTP 500: [redacted]");
    expect(long.err.message).not.toContain("kkkk");
  });

  test("a Basic password holding a quote and a backslash, echoed JSON-escaped, is redacted in the message, body and debug line", async () => {
    const password = 'p"ss\\w0rd-2764';
    const credential = Buffer.from(`admin:${password}`).toString("base64");
    const escaped = JSON.stringify(password).slice(1, -1);
    const { err, stderr } = await failEcho(
      `Basic ${credential}`,
      (sent) => JSON.stringify({ error: `bad password ${password}`, detail: `header ${sent}` }),
      true,
    );
    const shown = JSON.stringify({ error: "bad password [redacted]", detail: "header [redacted]" });
    expect(err.message).toBe("HTTP 500: bad password [redacted]");
    expect(err.body).toBe(shown);
    expect(stderr).toBe(`[flair] GET /echo answered HTTP 500; response body: ${JSON.stringify(shown)}\n`);
    for (const text of [err.message, err.body!, stderr]) {
      expect(text).not.toContain(password);
      expect(text).not.toContain(escaped);
      expect(text).not.toContain(credential);
      expect(text).toContain("[redacted]");
    }
  });

  test("a password equal to a JSON key: the reflect classifier's kind comes from the raw body, and its text is redacted", async () => {
    const { err } = await failEcho(
      `Basic ${Buffer.from("admin:error").toString("base64")}`,
      () => JSON.stringify({ error: "distillation_failed", detail: "model error" }),
      false,
    );
    expect(describeReflectError(err)).toEqual({ kind: "distillation-failed", text: "model [redacted]" });
    expect(err.message).toBe("HTTP 500: distillation_failed");
    expect(err.body).toBe('{"[redacted]":"distillation_failed","detail":"model [redacted]"}');
  });

  test("a request path holding the Bearer value: the debug line shows [redacted]", async () => {
    const token = `tok-2764-path-${"p".repeat(20)}`;
    const { err, stderr } = await failEcho(`Bearer ${token}`, () => "nope", true, `/echo/${token}`);
    expect(stderr).toBe(`[flair] GET /echo/[redacted] answered HTTP 500; response body: "nope"\n`);
    expect(err.message).toBe("HTTP 500: nope");
  });

  test("a credential across the 200-character bound leaves no fragment in the message, body or debug line", async () => {
    const token = "Zq7mK2vR9tX4wB6nL1pH8sD3fG5jC0yA";
    const { err, stderr } = await failEcho(`Bearer ${token}`, () => `${"x".repeat(190)}${token} tail`, true);
    expect(err.message).toBe(`HTTP 500: ${"x".repeat(190)}[redacted]...`);
    for (const text of [err.message, err.body!, stderr]) {
      for (let i = 0; i + 8 <= token.length; i++) expect(text).not.toContain(token.slice(i, i + 8));
    }
  });

  test("a credential repeated back to back: one merged [redacted], no run of 8 or more of its characters in any output", async () => {
    const token = "A".repeat(32);
    for (const [shape, body, message] of [
      ["JSON", JSON.stringify({ error: "A".repeat(63) }), "HTTP 500: [redacted]"],
      ["text", "A".repeat(63), "HTTP 500: [redacted]"],
    ] as const) {
      const { err, stderr } = await failEcho(`Bearer ${token}`, () => body, true);
      const display = describeReflectError(err).text;
      expect(err.message, shape).toBe(message);
      expect(err.body, shape).toBe(shape === "JSON" ? '{"error":"[redacted]"}' : "[redacted]");
      // describeReflectError shows the named error of a JSON body, else the message.
      expect(display, shape).toBe(shape === "JSON" ? "[redacted]" : message);
      for (const text of [err.message, err.body!, stderr, display]) expect(text, shape).not.toMatch(/A{8,}/);
    }
  });

  test("a Basic password a/b echoed in JSON as a\\/b, as a\\u002fb and as a/b is absent from every output", async () => {
    const bs = String.fromCharCode(92);
    const raw = `{"error":"bad a${bs}/b","detail":"a/b and a${bs}u002fb"}`;
    const { err, stderr } = await failEcho(`Basic ${Buffer.from("admin:a/b").toString("base64")}`, () => raw, true);
    // The fixture holds all three spellings.
    expect(apiErrorRawBody(err)).toBe(raw);
    expect(raw).toContain(`a${bs}u002fb`);
    const display = describeReflectError(err).text;
    expect(err.message).toBe("HTTP 500: bad [redacted]");
    expect(err.body).toBe('{"error":"bad [redacted]","detail":"[redacted] and [redacted]"}');
    expect(display).toBe("bad [redacted]");
    for (const text of [err.message, err.body!, stderr, display]) {
      for (const spelling of ["a/b", `a${bs}/b`, `a${bs}${bs}/b`, `a${bs}u002fb`, `a${bs}${bs}u002fb`]) expect(text).not.toContain(spelling);
    }
  });

  test("a malformed JSON body holding a\\/b: the escape is decoded for the search, so no output shows it", async () => {
    const bs = String.fromCharCode(92);
    const raw = `{"error":"a${bs}/b"`;
    const { err, stderr } = await failEcho(`Basic ${Buffer.from("admin:a/b").toString("base64")}`, () => raw, true);
    const display = describeReflectError(err).text;
    expect(err.body).toBe('{"error":"[redacted]"');
    expect(err.message).toBe('HTTP 500: {"error":"[redacted]"');
    expect(stderr).toBe(`[flair] GET /echo answered HTTP 500; response body: ${JSON.stringify('{"error":"[redacted]"')}\n`);
    expect(display).toBe(err.message);
    for (const text of [err.message, err.body!, stderr, display]) {
      for (const spelling of ["a/b", `a${bs}/b`, `a${bs}${bs}/b`]) expect(text).not.toContain(spelling);
    }
  });

  test("a valid JSON body nested too deep to redact is withheld from every output", async () => {
    const bs = String.fromCharCode(92);
    const depth = 1_000_000;
    const { err, stderr } = await failEcho(
      `Basic ${Buffer.from("admin:a/b").toString("base64")}`,
      () => `${"[".repeat(depth)}"a${bs}/b"${"]".repeat(depth)}`,
      true,
    );
    const display = describeReflectError(err).text;
    expect(err.body).toBe("[body withheld]");
    expect(err.message).toBe("HTTP 500: [body withheld]");
    expect(stderr).toBe('[flair] GET /echo answered HTTP 500; response body: "[body withheld]"\n');
    expect(display).toBe(err.message);
    for (const text of [err.message, err.body!, stderr, display]) {
      for (const spelling of ["a/b", `a${bs}/b`]) expect(text).not.toContain(spelling);
    }
  }, 30_000);

  test("the HTTP prefix and the cut marker are written as they are, never passed through redaction", async () => {
    const prefixPass = await failEcho(`Basic ${Buffer.from("admin:HTTP").toString("base64")}`, () => "HTTP gateway down", false);
    expect(prefixPass.err.message).toBe("HTTP 500: [redacted] gateway down");
    // A password that equals the marker, or that the marker completes, is CLI wording: out of scope.
    const dots = await failEcho(`Basic ${Buffer.from("admin:...").toString("base64")}`, () => "x".repeat(300), false);
    expect(dots.err.message).toBe(`HTTP 500: ${"x".repeat(200)}...`);
    const tail = await failEcho(`Basic ${Buffer.from("admin:x...").toString("base64")}`, () => `${"a".repeat(199)}xq${"b".repeat(50)}`, false);
    expect(tail.err.message).toBe(`HTTP 500: ${"a".repeat(199)}x...`);
    for (const { err } of [prefixPass, dots, tail]) expect(err.message.length).toBeLessThanOrEqual("HTTP 500: ".length + 200 + 3);
  });

  test("a decoded path holding control characters is withheld, and C1 controls in the body are escaped", async () => {
    const token = "tok-2764-control";
    const path = await failEcho(`Bearer ${token}`, () => "nope", true, "/echo/%0A%1B%5B2J");
    expect(path.stderr).toBe('[flair] GET [path withheld] answered HTTP 500; response body: "nope"\n');
    const csi = String.fromCharCode(0x9b);
    const body = await failEcho(`Bearer ${token}`, () => `bad${csi}[2Jthing`, true);
    expect(body.err.message).toBe("HTTP 500: bad[2Jthing");
    expect(body.stderr).toBe(`[flair] GET /echo answered HTTP 500; response body: "bad${String.fromCharCode(92)}u009b[2Jthing"\n`);
    for (const line of [path.stderr, body.stderr]) {
      expect(line.slice(0, -1)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    }
  });

  test("a request path holding the credential lower-case percent-encoded: the debug line shows it decoded and redacted", async () => {
    const token = "tok/2764+path";
    const { stderr } = await failEcho(`Bearer ${token}`, () => "nope", true, "/echo/tok%2f2764%2bpath");
    expect(stderr).toBe(`[flair] GET /echo/[redacted] answered HTTP 500; response body: "nope"\n`);
  });

  test("a request path holding the credential percent-encoded twice is decoded once and still redacted; an undecodable path is withheld", async () => {
    const token = "tok/2764+path";
    const twice = await failEcho(`Bearer ${token}`, () => "nope", true, "/echo/tok%252f2764%252bpath");
    expect(twice.stderr).toBe(`[flair] GET /echo/[redacted] answered HTTP 500; response body: "nope"\n`);
    const broken = await failEcho(`Bearer ${token}`, () => "nope", true, "/echo/%E0%A4%A");
    expect(broken.stderr).toBe(`[flair] GET [path withheld] answered HTTP 500; response body: "nope"\n`);
  });

  test("a response body holding the credential percent-encoded, in either hex case, is redacted", async () => {
    const token = "tok/2764+path";
    for (const encoded of ["tok%2f2764%2bpath", "tok%2F2764%2Bpath", "tok%2F2764+path"]) {
      const { err, stderr } = await failEcho(`Bearer ${token}`, () => `rejected ${encoded}`, true);
      expect(err.message, encoded).toBe("HTTP 500: rejected [redacted]");
      expect(err.body, encoded).toBe("rejected [redacted]");
      expect(stderr, encoded).toBe(`[flair] GET /echo answered HTTP 500; response body: "rejected [redacted]"\n`);
    }
  });

  test("a password equal to the marker: the server's echo is replaced, and the marker the CLI writes is not altered", async () => {
    const { err, stderr } = await failEcho(
      `Basic ${Buffer.from("admin:[redacted]").toString("base64")}`,
      () => JSON.stringify({ error: "bad [redacted]", detail: "[redacted]" }),
      true,
    );
    expect(err.message).toBe("HTTP 500: bad [redacted]");
    expect(err.body).toBe("[body withheld]");
    expect(stderr).toBe('[flair] GET /echo answered HTTP 500; response body: "[body withheld]"\n');
    expect(describeReflectError(err).text).toBe("bad [redacted]");
  });

  test("a password inside the withheld text: the withheld text is written as it is", async () => {
    const depth = 1_000_000;
    const { err, stderr } = await failEcho(
      `Basic ${Buffer.from("admin:withheld").toString("base64")}`,
      () => `${"[".repeat(depth)}1${"]".repeat(depth)}`,
      true,
    );
    expect(err.body).toBe("[body withheld]");
    expect(err.message).toBe("HTTP 500: [body withheld]");
    expect(stderr).toBe('[flair] GET /echo answered HTTP 500; response body: "[body withheld]"\n');
  }, 30_000);

  test("a credential that matches only once the marker is joined to the server's text is not redacted again", async () => {
    const { err, stderr } = await failEcho("Bearer x[red", () => "xx[red", true);
    expect(err.body).toBe("x[redacted]");
    expect(err.message).toBe("HTTP 500: x[redacted]");
    expect(stderr).toBe('[flair] GET /echo answered HTTP 500; response body: "x[redacted]"\n');
  });

  test("a Basic password of a quote: a JSON body whose re-serialization would hold it is withheld", async () => {
    const { err, stderr } = await failEcho(
      `Basic ${Buffer.from('admin:"').toString("base64")}`,
      () => JSON.stringify({ error: 'bad "', detail: "x" }),
      true,
    );
    expect(err.message).toBe("HTTP 500: bad [redacted]");
    expect(err.body).toBe("[body withheld]");
    expect(stderr).toBe('[flair] GET /echo answered HTTP 500; response body: "[body withheld]"\n');
    expect(describeReflectError(err).text).toBe("bad [redacted]");
  });

  test("the cut does not fall inside an escape the search decodes", async () => {
    const bs = String.fromCharCode(92);
    const { err } = await failEcho(`Bearer A${bs}u`, () => `${"x".repeat(195)}%41${bs}u0042zzzz`, false);
    expect(err.message).toBe(`HTTP 500: ${"x".repeat(195)}%41...`);
  });

  test("a Bearer header with surrounding whitespace: the values come from the header Fetch sends", async () => {
    for (const header of ["Bearer secret-2764-tail ", "Bearer  secret-2764-tail", "Bearer secret-2764-tail\t"]) {
      const { err, stderr } = await failEcho(header, (sent) => JSON.stringify({ error: `bad ${sent}`, detail: "secret-2764-tail" }), true);
      // The listener saw the header as Fetch sent it, surrounding whitespace removed.
      expect(apiErrorRawBody(err), JSON.stringify(header)).toContain(`"bad ${header.trim()}"`);
      const display = describeReflectError(err).text;
      expect(err.message, JSON.stringify(header)).toBe("HTTP 500: bad [redacted]");
      expect(err.body, JSON.stringify(header)).toBe('{"error":"bad [redacted]","detail":"[redacted]"}');
      for (const text of [err.message, err.body!, stderr, display]) expect(text, JSON.stringify(header)).not.toContain("secret-2764-tail");
    }
  });

  test("a scheme in another case or followed by a tab is read as the server reads it", async () => {
    const password = "pw-2764-lower-case";
    const basic = await failEcho(
      `basic ${Buffer.from(`admin:${password}`).toString("base64")}`,
      () => JSON.stringify({ error: `bad ${password}`, detail: password }),
      true,
    );
    const signature = Buffer.from("signature-2764-tab").toString("base64");
    const signed = await failEcho(
      `TPS-Ed25519\tagent-a:1760000000000:nonce-2764:${signature}`,
      () => JSON.stringify({ error: `bad ${signature}`, detail: signature }),
      true,
    );
    for (const [{ err, stderr }, secret] of [[basic, password], [signed, signature]] as const) {
      const display = describeReflectError(err).text;
      expect(err.message).toBe("HTTP 500: bad [redacted]");
      expect(err.body).toBe('{"error":"bad [redacted]","detail":"[redacted]"}');
      expect(display).toBe("bad [redacted]");
      for (const text of [err.message, err.body!, stderr, display]) expect(text).not.toContain(secret);
    }
  });

  test("a no-break space after the scheme: the signature and token are redacted from the message, body, debug line and rem text", async () => {
    const nbsp = String.fromCharCode(0xa0);
    const signature = Buffer.from("signature-2764-nbsp").toString("base64");
    const header = `TPS-Ed25519${nbsp}agent-a:1760000000000:nonce-2764:${signature}`;
    // Flair's server parser accepts this header and reads this signature.
    expect(parseTpsEd25519Header(header)?.signatureB64).toBe(signature);
    const signed = await failEcho(header, () => JSON.stringify({ error: `bad ${signature}`, detail: signature }), true);
    const token = "tok-2764-no-break-space";
    const bearer = await failEcho(`Bearer${nbsp}${token}`, () => JSON.stringify({ error: `bad ${token}`, detail: token }), true);
    for (const [{ err, stderr }, secret] of [[signed, signature], [bearer, token]] as const) {
      const display = describeReflectError(err).text;
      expect(err.message, secret).toBe("HTTP 500: bad [redacted]");
      expect(err.body, secret).toBe('{"error":"bad [redacted]","detail":"[redacted]"}');
      expect(stderr, secret).toBe(`[flair] GET /echo answered HTTP 500; response body: ${JSON.stringify('{"error":"bad [redacted]","detail":"[redacted]"}')}\n`);
      expect(display, secret).toBe("bad [redacted]");
      for (const text of [err.message, err.body!, stderr, display]) expect(text, secret).not.toContain(secret);
    }
  });

  test("a known scheme whose credential cannot be extracted: the server's text is withheld", async () => {
    for (const header of ["TPS-Ed25519 not-the-signed-form", "Bearer"]) {
      const { err, stderr } = await failEcho(header, () => JSON.stringify({ error: "bad not-the-signed-form", detail: "x" }), true);
      expect(credentialsInHeader(header).withhold, header).toBe(true);
      expect(err.message, header).toBe("HTTP 500: [body withheld]");
      expect(err.body, header).toBe("[body withheld]");
      expect(stderr, header).toBe('[flair] GET /echo answered HTTP 500; response body: "[body withheld]"\n');
      expect(describeReflectError(err).text, header).toBe("[body withheld]");
    }
  });

  test("a non-empty body whose error string is empty, with an unreadable credential: describeReflectError shows the marker", async () => {
    const { err } = await failEcho("Bearer", () => JSON.stringify({ error: "" }), false);
    expect(err.message).toBe("HTTP 500: [body withheld]");
    expect(err.body).toBe("[body withheld]");
    expect(describeReflectError(err)).toEqual({ kind: "other", text: "[body withheld]" });
  });

  test("a non-empty body whose error string is empty, with an unreadable credential: rem's run error shows the marker", async () => {
    const body = JSON.stringify({ error: "" });
    const root = mkdtempSync(join(tmpdir(), "flair-2764-runner-"));
    const routes: Record<string, Reply> = {
      "GET /Memory": { status: 200, body: JSON.stringify([{ id: "m1", agentId: AGENT_ID, content: "first memory" }]) },
      "GET /Soul": { status: 200, body: "[]" },
      "POST /MemoryMaintenance": { status: 200, body: JSON.stringify({ expired: 0, archived: 0, total: 0, errors: 0 }) },
      "POST /ReflectMemories": { status: 502, body },
      "POST /MemoryDedupStats": {
        status: 200,
        body: JSON.stringify({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      },
    };
    const own = await startListener((line) => routes[line.split("?")[0]] ?? { status: 404, body: `no route for ${line}` });
    try {
      const apiCall = (method: string, path: string, sent?: unknown) =>
        sendJsonRequest(new URL(path, `http://127.0.0.1:${own.port}`), method, sent, "Bearer", true);
      const r = await runNightlyCycle({
        agentId: AGENT_ID,
        flairVersion: "0.0.0-test",
        apiCall,
        snapshotRoot: join(root, "snapshots"),
        logPath: join(root, "rem-nightly.jsonl"),
        pauseFlagPath: join(root, "rem.paused"),
        envPaused: false,
        healthProbe: async () => ({ ok: true, elapsedMs: 1 }),
      });
      expect(r.logRow.errors, own.seen.join("\n")).toEqual(["distillation: [body withheld]"]);
    } finally {
      await own.close();
      rmSync(root, { recursive: true, force: true });
    }
    // An empty response is not withheld: there is no server text to hide, and
    // describeReflectError shows the message.
    const empty = ApiHttpError.fromResponse(500, "", ["Bearer"], true);
    expect(empty.message).toBe("HTTP 500");
    expect(empty.body).toBe("");
    expect(boundErrorText(empty, "")).toBe("");
    expect(describeReflectError(empty)).toEqual({ kind: "other", text: "HTTP 500" });
  });

  test("a body that carries no credential value is unchanged", async () => {
    const { err, stderr } = await failEcho(BASIC, () => "upstream unavailable", true);
    expect(err.message).toBe("HTTP 500: upstream unavailable");
    expect(err.body).toBe("upstream unavailable");
    expect(apiErrorRawBody(err)).toBe("upstream unavailable");
    expect(stderr).toBe(`[flair] GET /echo answered HTTP 500; response body: "upstream unavailable"\n`);
  });
});

describe("flair#2764 — the CLI reads a sent header with the server's own grammar", () => {
  test("the CLI's grammar copies equal the server's", () => {
    expect(TPS_ED25519_HEADER_GRAMMAR.source).toBe(TPS_ED25519_HEADER_RE.source);
    expect(TPS_ED25519_HEADER_GRAMMAR.flags).toBe(TPS_ED25519_HEADER_RE.flags);
    expect(BASIC_HEADER_GRAMMAR.source).toBe(BASIC_AUTH_HEADER_RE.source);
    expect(BASIC_HEADER_GRAMMAR.flags).toBe(BASIC_AUTH_HEADER_RE.flags);
  });

  test("on each header form the server accepts, the CLI extracts the signature or password the server reads", () => {
    const nbsp = String.fromCharCode(0xa0);
    const signature = Buffer.from("signature-2764-parity").toString("base64");
    for (const [scheme, separator] of [
      ["TPS-Ed25519", " "],
      ["TPS-Ed25519", "\t"],
      ["TPS-Ed25519", nbsp],
      ["TPS-Ed25519", "   "],
      ["tps-ed25519", " "],
      ["TPS-ED25519", "\t "],
    ] as const) {
      const header = `${scheme}${separator}agent-a:1760000000000:nonce-2764:${signature}`;
      const server = parseTpsEd25519Header(header);
      expect(server?.signatureB64, JSON.stringify(header)).toBe(signature);
      const cli = credentialsInHeader(header);
      expect(cli.values, JSON.stringify(header)).toContain(server!.signatureB64);
      expect(cli.withhold, JSON.stringify(header)).toBe(false);
    }
    const encoded = Buffer.from("admin:pw-2764-parity").toString("base64");
    for (const header of [`Basic ${encoded}`, `basic ${encoded}`, `BASIC ${encoded}`, `Basic  ${encoded}`, `Basic \t${encoded}`]) {
      const server = parseBasicAuthHeader(header);
      expect(server?.pass, header).toBe("pw-2764-parity");
      const cli = credentialsInHeader(header);
      expect(cli.values, header).toContain(server!.pass);
      expect(cli.withhold, header).toBe(false);
    }
    // A scheme followed by a tab or no-break space is not the server's Basic
    // form; the CLI still reads the password from the part after the scheme.
    for (const separator of ["\t", nbsp]) {
      const header = `Basic${separator}${encoded}`;
      expect(parseBasicAuthHeader(header), JSON.stringify(header)).toBeNull();
      expect(credentialsInHeader(header).values, JSON.stringify(header)).toContain("pw-2764-parity");
    }
  });
});

describe("flair#2764 — under Node, a no-break-space TPS-Ed25519 header a node:http server accepts", () => {
  test("the built CLI's request redacts the signature the server read from the message, body, debug line and rem text", async () => {
    ensureCliBuild();
    const dir = mkdtempSync(join(tmpdir(), "flair-2764-node-"));
    try {
      const script = join(dir, "echo.mjs");
      writeFileSync(script, [
        'import { createServer } from "node:http";',
        "const { sendJsonRequest } = await import(process.env.AUTH_RESOLVE_URL);",
        "const { describeReflectError } = await import(process.env.REM_URL);",
        "let received = \"\";",
        "const server = createServer((req, res) => {",
        "  received = String(req.headers.authorization ?? \"\");",
        "  const echoed = received.slice(received.lastIndexOf(\":\") + 1);",
        "  res.writeHead(500, { \"content-type\": \"application/json\" });",
        "  res.end(JSON.stringify({ error: \"bad \" + echoed, detail: echoed }));",
        "});",
        "await new Promise((r) => server.listen(0, \"127.0.0.1\", r));",
        "const written = [];",
        "const write = process.stderr.write.bind(process.stderr);",
        "process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };",
        "let out;",
        "try {",
        "  await sendJsonRequest(new URL(\"/echo\", \"http://127.0.0.1:\" + server.address().port), \"GET\", undefined, process.env.SENT_HEADER, true);",
        "  out = { thrown: false };",
        "} catch (err) {",
        "  out = { thrown: true, name: err.name, message: err.message, body: err.body, display: describeReflectError(err).text };",
        "} finally {",
        "  process.stderr.write = write;",
        "  server.close();",
        "}",
        "out.received = received;",
        "out.stderr = written.filter((w) => w.startsWith(\"[flair] GET \")).join(\"\");",
        "process.stdout.write(JSON.stringify(out));",
      ].join("\n"));
      const signature = Buffer.from("signature-2764-node").toString("base64");
      const header = `TPS-Ed25519${String.fromCharCode(0xa0)}agent-a:1760000000000:nonce-2764:${signature}`;
      const dist = join(import.meta.dirname ?? __dirname, "..", "..", "dist");
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        FLAIR_DEBUG: "1",
        SENT_HEADER: header,
        AUTH_RESOLVE_URL: `file://${join(dist, "lib", "auth-resolve.js")}`,
        REM_URL: `file://${join(dist, "commands", "rem.js")}`,
      };
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const startedAt = Date.now();
        const child = spawn(nodeBin({ env, cwd: dir }), [script], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], timeout: CHILD_DEADLINE_MS });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code, signal) => {
          if (signal !== null || code !== 0) {
            reject(new Error(childOverranDeadline("node echo script", "no-break space", CHILD_DEADLINE_MS, { status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr })));
            return;
          }
          resolve({ stdout, stderr });
        });
      });
      const out = JSON.parse(result.stdout);
      // The node:http server received the header as sent, and Flair's server parser reads its signature.
      expect(out.received).toBe(header);
      expect(parseTpsEd25519Header(out.received)?.signatureB64).toBe(signature);
      const shown = '{"error":"bad [redacted]","detail":"[redacted]"}';
      expect(out).toMatchObject({ thrown: true, name: "ApiHttpError", message: "HTTP 500: bad [redacted]", body: shown, display: "bad [redacted]" });
      expect(out.stderr).toBe(`[flair] GET /echo answered HTTP 500; response body: ${JSON.stringify(shown)}\n`);
      for (const text of [out.message, out.body, out.stderr, out.display]) expect(text).not.toContain(signature);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
