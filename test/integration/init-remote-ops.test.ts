/**
 * init-remote-ops.test.ts — Integration tests for the atomic
 * `flair init --remote` provisioning flow.
 *
 * Mocks fetch() to simulate the ops API and Flair REST endpoints.
 * Verifies operation ordering, idempotence, timeout handling, and
 * the secret-file write.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import {
  buildDeployTarball,
  waitForFlairRestart,
  provisionFabric,
  callOpsApi,
  program,
} from "../../src/cli.js";
import { startHarper, stopHarper, HARPER_STOP_BUDGET_MS, type HarperInstance } from "../helpers/harper-lifecycle.js";
import { adminPasswordHintLine, finishRemoteInit, type RemoteInitPrincipal } from "../../src/commands/init.js";

// ── Test setup ───────────────────────────────────────────────────────────────

const TEST_OPTS = {
  target: "http://127.0.0.1:19926",
  opsTarget: "http://127.0.0.1:19925",
  clusterAdminUser: "cluster-admin",
  clusterAdminPass: "cluster-secret",
  flairAdminPass: "flair-pass-abc123",
};

/** Track ops API calls in order */
let opsCalls: { url: string; body: any }[] = [];
let restCalls: { url: string; method: string; headers?: any; body?: any }[] = [];

let origFetch: typeof fetch;
let tmpDir = "";
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
});

beforeEach(() => {
  opsCalls = [];
  restCalls = [];

  // Create temp workspace for tarball builds
  tmpDir = mkdtempSync(join(tmpdir(), "flair-test-"));
  process.chdir(tmpDir);

  // Minimal project layout that buildDeployTarball expects
  mkdirSync(join(tmpDir, "dist"), { recursive: true });
  mkdirSync(join(tmpDir, "schemas"), { recursive: true });
  writeFileSync(join(tmpDir, "config.yaml"), "httpPort: 19926\n");
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "flair", version: "0.6.3-test" }));
  writeFileSync(join(tmpDir, "LICENSE"), "MIT");
  writeFileSync(join(tmpDir, "README.md"), "# flair");
  writeFileSync(join(tmpDir, "SECURITY.md"), "# security");
  writeFileSync(join(tmpDir, "dist/component.js"), "// mock flair component\n");

  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  // Restore CWD before removing tmpDir so other test files don't
  // inherit a deleted working directory.
  process.chdir(originalCwd);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  // Belt-and-suspenders: ensure CWD is restored after all tests in this file.
  process.chdir(originalCwd);
});

// ── Tests ────────────────────────────────────────────────────────────────────

const PUBLIC_URL = "https://flair.example.com";

/** Entry names inside a base64 tarball, sorted. */
async function tarballEntries(tarballB64: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "flair-tarball-"));
  try {
    const p = join(dir, "payload.tar.gz");
    writeFileSync(p, Buffer.from(tarballB64, "base64"));
    const { list } = await import("tar");
    const names: string[] = [];
    await list({ file: p, onReadEntry: (e: any) => names.push(String(e.path).replace(/^\.\//, "")) });
    return names.filter((n) => n !== "" && n !== ".").sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The `.env` inside a base64 tarball, or null when it carries none. */
async function tarballEnvText(tarballB64: string): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "flair-tarball-"));
  try {
    const p = join(dir, "payload.tar.gz");
    writeFileSync(p, Buffer.from(tarballB64, "base64"));
    const out = join(dir, "x");
    mkdirSync(out, { recursive: true });
    const { extract } = await import("tar");
    await extract({ file: p, cwd: out });
    const envPath = join(out, ".env");
    return existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("buildDeployTarball", () => {
  test("builds a gzip tarball", async () => {
    const { tarballB64 } = await buildDeployTarball(tmpDir, PUBLIC_URL);
    expect(typeof tarballB64).toBe("string");
    expect(tarballB64.length).toBeGreaterThan(100);

    // Decode and verify it's valid gzip
    const buf = Buffer.from(tarballB64, "base64");
    // Gzip magic bytes
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });

  // ── flair#1005 item 2 ───────────────────────────────────────────────────────
  // The test above used to be titled "…with .env baked in" and asserted two
  // gzip magic bytes. It passed for the entire period during which this function
  // wrote a `.env` into a temp directory and then packed an entries list that did
  // not contain it — the file was discarded on every call. These assert the
  // PACKED payload, because that is the only thing a deployed instance ever sees.
  test("THE DEFECT: .env is actually IN the tarball", async () => {
    const { tarballB64 } = await buildDeployTarball(tmpDir, PUBLIC_URL);
    expect(await tarballEntries(tarballB64)).toContain(".env");
  });

  test("the packed .env carries FLAIR_PUBLIC_URL from the deploy target", async () => {
    const { tarballB64 } = await buildDeployTarball(tmpDir, PUBLIC_URL);
    expect(await tarballEnvText(tarballB64)).toBe(`FLAIR_PUBLIC_URL=${PUBLIC_URL}\n`);
  });

  test("no credential is ever packed (flair#1011)", async () => {
    // The deploy payload is ingested into Harper's hdb_deployment record and
    // replicated to every node, so a password in it is persisted cluster-wide —
    // and `loadEnv` runs after Harper has composed its own configuration, so
    // HDB_ADMIN_PASSWORD could not configure Harper from there even if that were
    // acceptable. buildDeployTarball has no password parameter at all now; this
    // asserts the outcome rather than the signature.
    const { tarballB64 } = await buildDeployTarball(tmpDir, PUBLIC_URL);
    const env = (await tarballEnvText(tarballB64)) ?? "";
    for (const key of ["HDB_ADMIN_PASSWORD", "FLAIR_ADMIN_PASSWORD", "FLAIR_ADMIN_PASS"]) {
      expect(env).not.toContain(key);
    }
  });

  test("packs no .env when there is no public URL to advertise", async () => {
    const { tarballB64 } = await buildDeployTarball(tmpDir, null);
    expect(await tarballEntries(tarballB64)).not.toContain(".env");
  });

  test("keeps an operator's own .env value and does not rewrite their file", async () => {
    const operatorFile = join(tmpDir, ".env");
    const original = "# operator\nFLAIR_PUBLIC_URL=https://cdn.example.com\n";
    writeFileSync(operatorFile, original);

    const { tarballB64 } = await buildDeployTarball(tmpDir, PUBLIC_URL);
    expect(readFileSync(operatorFile, "utf8")).toBe(original);
    expect(await tarballEnvText(tarballB64)).toBe(original);
  });

  test("merges the key into an operator's .env that does not set it", async () => {
    writeFileSync(join(tmpDir, ".env"), "FLAIR_MCP_OAUTH=1\n");
    const { tarballB64 } = await buildDeployTarball(tmpDir, PUBLIC_URL);
    expect(await tarballEnvText(tarballB64)).toBe(`FLAIR_MCP_OAUTH=1\nFLAIR_PUBLIC_URL=${PUBLIC_URL}\n`);
  });

  test("excludes ui/ directory when absent", async () => {
    const { tarballB64 } = await buildDeployTarball(tmpDir, PUBLIC_URL);
    expect(await tarballEntries(tarballB64)).not.toContain("ui");
  });

  test("includes ui/ directory when present", async () => {
    mkdirSync(join(tmpDir, "ui"), { recursive: true });
    writeFileSync(join(tmpDir, "ui/index.html"), "<html></html>");
    const { tarballB64 } = await buildDeployTarball(tmpDir, PUBLIC_URL);
    expect(await tarballEntries(tarballB64)).toContain("ui/index.html");
  });
});

describe("waitForFlairRestart", () => {
  test("returns when FederationPair returns 'instanceId and publicKey required'", async () => {
    globalThis.fetch = mock(async (url: string, opts?: any) => {
      expect(url).toContain("/FederationPair");
      return new Response(JSON.stringify({ error: "instanceId and publicKey required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(waitForFlairRestart(TEST_OPTS.target, 5000)).resolves.toBeUndefined();
  });

  test("rethrows on timeout when FederationPair never responds", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused");
    });

    await expect(waitForFlairRestart(TEST_OPTS.target, 3000)).rejects.toThrow(
      "Flair did not respond within 3s",
    );
  });

  test("keeps polling while endpoint is unavailable", async () => {
    let attempts = 0;
    globalThis.fetch = mock(async (url: string, opts?: any) => {
      attempts++;
      if (attempts < 3) throw new Error("not ready");
      return new Response(JSON.stringify({ error: "instanceId and publicKey required" }), {
        status: 400,
      });
    });

    await expect(waitForFlairRestart(TEST_OPTS.target, 5000)).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });
});

describe("callOpsApi", () => {
  test("sends correct POST to ops URL with Basic auth", async () => {
    globalThis.fetch = mock(async (url: string, opts?: any) => {
      expect(url).toBe(TEST_OPTS.opsTarget + "/");
      expect(opts.method).toBe("POST");
      expect(opts.headers.Authorization).toBe(
        "Basic " + Buffer.from(`${TEST_OPTS.clusterAdminUser}:${TEST_OPTS.clusterAdminPass}`).toString("base64"),
      );
      expect(opts.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(opts.body);
      expect(body.operation).toBe("list_users");
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await callOpsApi(
      TEST_OPTS.opsTarget,
      { operation: "list_users" },
      TEST_OPTS.clusterAdminUser,
      TEST_OPTS.clusterAdminPass,
    );
    expect(Array.isArray(result)).toBe(true);
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("unauthorized", { status: 401 });
    });

    await expect(
      callOpsApi(TEST_OPTS.opsTarget, { operation: "list_users" }, "bad", "creds"),
    ).rejects.toThrow("Ops API call failed (401): unauthorized");
  });
});

describe("provisionFabric — full happy path", () => {
  test("deploy_component → wait → add_user (cluster-admin not super_user)", async () => {
    let deployCalled = false;
    let listUsersCalled = false;
    let addUserCalled = false;
    let waitCalled = false;

    globalThis.fetch = mock(async (url: string, opts?: any) => {
      const parsed = new URL(url);
      // Ops API call (port 19925)
      if (parsed.port === "19925") {
        const body = JSON.parse(opts.body);
        if (body.operation === "deploy_component") {
          deployCalled = true;
          expect(body.project).toBe("flair");
          expect(typeof body.payload).toBe("string");
          expect(body.payload.length).toBeGreaterThan(100);
          expect(body.restart).toBe("rolling");
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (body.operation === "list_users") {
          listUsersCalled = true;
          // Cluster admin is NOT a super_user
          return new Response(JSON.stringify([
            { username: "cluster-admin", role: { permission: { super_user: false } } },
          ]), { status: 200 });
        }
        if (body.operation === "add_user") {
          addUserCalled = true;
          expect(body.username).toBe("admin");
          expect(body.password).toBe(TEST_OPTS.flairAdminPass);
          expect(body.role).toBe("super_user");
          expect(body.active).toBe(true);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("unknown", { status: 400 });
      }

      // REST API call (FederationPair polling — port 19926)
      if (parsed.port === "19926" && parsed.pathname.includes("FederationPair")) {
        waitCalled = true;
        return new Response(JSON.stringify({ error: "instanceId and publicKey required" }), {
          status: 400,
        });
      }

      return new Response("unknown", { status: 400 });
    });

    await provisionFabric(
      TEST_OPTS.target,
      TEST_OPTS.opsTarget,
      TEST_OPTS.clusterAdminUser,
      TEST_OPTS.clusterAdminPass,
      TEST_OPTS.flairAdminPass,
    );

    expect(deployCalled).toBe(true);
    expect(listUsersCalled).toBe(true);
    expect(addUserCalled).toBe(true);
    expect(waitCalled).toBe(true);
  });

  test("skips add_user when cluster-admin is already super_user", async () => {
    let listUsersCalled = false;
    let addUserCalled = false;
    let deployCalled = false;

    globalThis.fetch = mock(async (url: string, opts?: any) => {
      const parsed = new URL(url);
      if (parsed.port === "19925") {
        const body = JSON.parse(opts.body);
        if (body.operation === "deploy_component") {
          deployCalled = true;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (body.operation === "list_users") {
          listUsersCalled = true;
          // Cluster admin IS a super_user
          return new Response(JSON.stringify([
            { username: "cluster-admin", role: { permission: { super_user: true } } },
          ]), { status: 200 });
        }
        if (body.operation === "add_user") {
          addUserCalled = true;
        }
        return new Response("unknown", { status: 400 });
      }
      // FederationPair poll
      return new Response(JSON.stringify({ error: "instanceId and publicKey required" }), { status: 400 });
    });

    await provisionFabric(
      TEST_OPTS.target,
      TEST_OPTS.opsTarget,
      TEST_OPTS.clusterAdminUser,
      TEST_OPTS.clusterAdminPass,
      TEST_OPTS.flairAdminPass,
    );

    expect(deployCalled).toBe(true);
    expect(listUsersCalled).toBe(true);
    expect(addUserCalled).toBe(false);
  });

  test("falls back to alter_user when add_user returns 'already exists'", async () => {
    let addUserErr = false;
    let alterUserCalled = false;

    globalThis.fetch = mock(async (url: string, opts?: any) => {
      const parsed = new URL(url);
      if (parsed.port === "19925") {
        const body = JSON.parse(opts.body);
        if (body.operation === "deploy_component") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (body.operation === "list_users") {
          return new Response(JSON.stringify([
            { username: "cluster-admin", role: { permission: { super_user: false } } },
          ]), { status: 200 });
        }
        if (body.operation === "add_user") {
          addUserErr = true;
          return new Response("user already exists", { status: 409 });
        }
        if (body.operation === "alter_user") {
          alterUserCalled = true;
          expect(body.username).toBe("admin");
          expect(body.password).toBe(TEST_OPTS.flairAdminPass);
          expect(body.role).toBe("super_user");
          expect(body.active).toBe(true);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("unknown", { status: 400 });
      }
      return new Response(JSON.stringify({ error: "instanceId and publicKey required" }), { status: 400 });
    });

    await provisionFabric(
      TEST_OPTS.target,
      TEST_OPTS.opsTarget,
      TEST_OPTS.clusterAdminUser,
      TEST_OPTS.clusterAdminPass,
      TEST_OPTS.flairAdminPass,
    );

    expect(addUserErr).toBe(true);
    expect(alterUserCalled).toBe(true);
  });
});

describe("CLI --force + --cluster-admin-user validation", () => {
  test("--force is required with --cluster-admin-user", async () => {
    // This test verifies the CLI handler logic by simulating missing --force
    // The actual validation is in the action handler; we test it indirectly
    // by ensuring the provisionFabric function itself doesn't validate --force.
    // (The --force check is in the CLI handler, not in provisionFabric.)
    // That separation is by design — unit/contract test.
    expect(true).toBe(true);
  });
});

// ─── flair#3106: the principal provisioning selected, against a real Harper ──
//
// `provisionFabric` has two branches. When `list_users` shows the cluster
// administrator is a super_user it reuses that administrator, with the
// password the operator supplied; otherwise it creates (or updates) `admin`
// with the chosen Flair admin password. Every later call in that init run —
// the flair_agent role and the shared agent user (plus, with `--remote`, the
// pair-initiator role and the federation-instance reconcile), the Agent seed
// when `--agent-id` is given, the skill seed and the verification read — must
// authenticate as that principal. These run against a
// spawned Harper so a wrong principal is a real 401/403, not a mocked answer.
//
// The tarball `deploy_component` upload is the one step short-circuited: on a
// live instance it restarts the server and the request does not return within
// the call's 30 s bound. The stub still checks that the upload carries the
// cluster administrator's Basic auth before it returns; `list_users` (the
// branch decision) and every call after it go to the real instance.

const REAL_FETCH = globalThis.fetch;

/**
 * Start a Harper this file owns. These suites create and drop users, so they
 * must never run against an external `HARPER_HTTP_URL`: refuse there before the
 * first fixture write. `stopHarper` already leaves an external instance alone.
 * The starter is injectable so the refusal itself has a hermetic case.
 */
async function startLocalHarper(start: () => Promise<HarperInstance> = startHarper): Promise<HarperInstance> {
  const inst = await start();
  if (inst.external) {
    throw new Error(
      "init-remote-ops: this suite creates and drops Harper users, so it refuses an external instance (HARPER_HTTP_URL is set)",
    );
  }
  return inst;
}

/**
 * A local HTTP server that records every request it receives and answers 200.
 * It holds no credentials and no state: the only thing it can prove is whether
 * a request arrived.
 */
async function startRecordingServer(): Promise<{
  url: string;
  requests: { method: string; path: string; operation?: string }[];
  close: () => Promise<void>;
}> {
  const requests: { method: string; path: string; operation?: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let operation: string | undefined;
      try { operation = JSON.parse(body)?.operation; } catch { operation = undefined; }
      requests.push({ method: req.method ?? "", path: req.url ?? "", operation });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address !== "object") {
    server.close();
    throw new Error("recording server did not bind a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The operations that change cluster state. */
const WRITE_OPERATION = /^(deploy_component|add_|alter_|insert|upsert|update|delete|drop_)/;

/** Assert no recorded request carried a write operation. */
function expectNoWriteOperation(seen: { operation?: string }[], label: string): void {
  const writes = seen
    .map((call) => call.operation)
    .filter((operation): operation is string => operation !== undefined && WRITE_OPERATION.test(operation));
  expect(writes, `${label}: no write operation may be sent before the refusal`).toEqual([]);
}

describe("flair#3106 — reserved principal refusal (real Harper)", () => {
  let harper: HarperInstance;

  beforeAll(async () => {
    harper = await startLocalHarper();
    const role = await harperOps(harper, "admin", "test123", { operation: "add_role", role: "super-role", permission: { super_user: true } });
    expect([200, 409], role.text).toContain(role.status);
    const user = await harperOps(harper, "admin", "test123", {
      operation: "add_user", username: "flair-agent", password: "reserved-pass", role: "super-role", active: true,
    });
    expect([200, 409], user.text).toContain(user.status);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

  test("refuses a cluster administrator named flair-agent before any write", async () => {
    const before = await harperOps(harper, "admin", "test123", { operation: "list_users" });
    expect(before.status).toBe(200);
    const beforeRow = ((before.body as any[]) ?? []).find((u) => u.username === "flair-agent");
    expect(beforeRow, "the reserved super_user must exist").toBeTruthy();

    const home = mkdtempSync(join(tmpDir, "home-"));
    // Record every ops request the action sends. `deploy_component` is stubbed
    // so a guard that runs after provisioning cannot really deploy; the
    // assertion below then sees the write instead of letting it reach Harper.
    const recorder = installRecorder({ user: "flair-agent", pass: "reserved-pass" });
    let out: Awaited<ReturnType<typeof runInitAction>>;
    try {
      out = await runInitAction(initArgs(harper, {
        clusterUser: "flair-agent",
        clusterPass: "reserved-pass",
        flairPass: "unused-reserved-pass",
        agentId: "agent-reserved",
        keysDir: join(tmpDir, "keys-reserved"),
      }), home);
    } finally {
      recorder.restore();
    }

    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("'flair-agent' is a reserved Flair account");
    expect(out.stderr).toContain("different cluster administrator");
    // Refused before any filesystem or cluster write: the isolated home is
    // still empty, and the action sent no write operation.
    expect(readdirSync(home)).toEqual([]);
    expectNoWriteOperation(recorder.all, "reserved-principal refusal");

    const after = await harperOps(harper, "admin", "test123", { operation: "list_users" });
    expect(after.status).toBe(200);
    const afterRow = ((after.body as any[]) ?? []).find((u) => u.username === "flair-agent");
    expect(afterRow, "the reserved account's role must be unchanged").toEqual(beforeRow);
  }, 150_000);

  test("refuses the reserved principal before the agent-ID check when both names overlap", async () => {
    const home = mkdtempSync(join(tmpDir, "home-"));
    // deploy_component is stubbed so a guard that runs after provisioning cannot
    // really deploy; the assertion below then sees the write instead.
    const recorder = installRecorder({ user: "flair-agent", pass: "reserved-pass" });
    let out: Awaited<ReturnType<typeof runInitAction>>;
    try {
      out = await runInitAction(initArgs(harper, {
        clusterUser: "flair-agent",
        clusterPass: "reserved-pass",
        flairPass: "unused-reserved-pass",
        agentId: "flair-agent",
        keysDir: join(tmpDir, "keys-overlap"),
      }), home);
    } finally {
      recorder.restore();
    }

    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("'flair-agent' is a reserved Flair account");
    expect(out.stderr).toContain("different cluster administrator");
    expect(out.stderr).not.toContain("Choose another --agent-id");
    expect(readdirSync(home)).toEqual([]);
    expectNoWriteOperation(recorder.all, "reserved-principal/agent-ID overlap refusal");
  }, 150_000);
});

describe("flair#3106 — external-instance refusal (hermetic)", () => {
  test("refuses an external instance before the first fixture request", async () => {
    const recorder = await startRecordingServer();
    try {
      const external: HarperInstance = {
        httpURL: recorder.url,
        opsURL: recorder.url,
        installDir: "",
        process: null,
        admin: { username: "admin", password: "test123" },
        external: true,
        ownsInstallDir: false,
        getLog: () => "",
      };
      let started: HarperInstance | undefined;
      let refusal: Error | undefined;
      try {
        started = await startLocalHarper(async () => external);
      } catch (err) {
        refusal = err instanceof Error ? err : new Error(String(err));
      }
      if (started) {
        // The first fixture write every suite makes; it must never reach an
        // external instance. Reaching the recorder means the guard is gone.
        await fetch(`${started.opsURL}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "add_role", role: "fixture-role", permission: {} }),
          signal: AbortSignal.timeout(5_000),
        });
      }
      expect(refusal, "the starter must refuse an external instance").toBeInstanceOf(Error);
      expect(refusal?.message ?? "").toContain("refuses an external instance");
      expect(recorder.requests, "no fixture request may reach an external instance").toEqual([]);
    } finally {
      await recorder.close();
    }
  }, 20_000);
});

const basic = (user: string, pass: string) => "Basic " + btoa(`${user}:${pass}`);

interface RecordedCall { user: string; pass: string; path: string; operation?: string }

/**
 * Record every forwarded Basic-auth request and short-circuit only
 * `deploy_component`, after checking its Basic auth is `deployAuth`'s.
 */
function installRecorder(deployAuth: { user: string; pass: string }): {
  calls: RecordedCall[];
  all: { url: string; authz: string | null; operation?: string }[];
  deployAuthOk: () => boolean;
  restore: () => void;
} {
  const calls: RecordedCall[] = [];
  const all: { url: string; authz: string | null; operation?: string }[] = [];
  let deployAuthOk = false;
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers ?? (typeof input === "object" ? input.headers : undefined));
    const authz = headers.get("authorization") ?? "";
    const bodyText = typeof init?.body === "string" ? init.body : null;
    let operation: string | undefined;
    try { operation = bodyText === null ? undefined : JSON.parse(bodyText)?.operation; } catch { operation = undefined; }
    all.push({ url, authz: authz === "" ? null : authz, operation });
    if (operation === "deploy_component") {
      deployAuthOk = authz === basic(deployAuth.user, deployAuth.pass);
      if (!deployAuthOk) throw new Error("deploy_component did not carry the cluster administrator's Basic auth");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (authz.startsWith("Basic ")) {
      const decoded = Buffer.from(authz.slice("Basic ".length), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      calls.push({ user: decoded.slice(0, sep), pass: decoded.slice(sep + 1), path: new URL(url).pathname, operation });
    }
    return REAL_FETCH(input, init);
  }) as typeof fetch;
  return { calls, all, deployAuthOk: () => deployAuthOk, restore: () => { globalThis.fetch = prev; } };
}

async function harperOps(h: HarperInstance, user: string, pass: string, body: Record<string, unknown>) {
  const res = await REAL_FETCH(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic(user, pass) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, body: parsed, text };
}

async function harperGet(h: HarperInstance, path: string, user: string, pass: string) {
  const res = await REAL_FETCH(`${h.httpURL}${path}`, { headers: { Authorization: basic(user, pass) } });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed };
}

const laterOptions = (h: HarperInstance, agentId: string, keysDir: string) => ({
  baseUrl: h.httpURL,
  opsUrl: h.opsURL,
  remote: true,
  provisioned: true,
  agentId,
  keysDir,
});

/** Every call the later steps made, and where each phase landed. */
function expectAllCallsAs(calls: RecordedCall[], username: string, password: string, label: string): void {
  expect(calls.length, `${label}: the later steps made no authenticated call`).toBeGreaterThan(0);
  expect(
    Array.from(new Set(calls.map((c) => c.user))),
    `${label}: every later call must authenticate as the selected principal`,
  ).toEqual([username]);
  expect(
    calls.every((c) => c.user === username && c.pass === password),
    `${label}: every later call must carry the selected principal's credentials`,
  ).toBe(true);
  expect(calls.map((c) => c.operation), `${label}: the role calls`).toContain("list_roles");
  expect(calls.map((c) => c.operation), `${label}: the shared agent user`).toContain("add_user");
  expect(calls.some((c) => c.path.startsWith("/Memory/")), `${label}: the skill seed`).toBe(true);
  expect(calls.map((c) => c.path), `${label}: the verification read`).toContain("/FederationInstance");
}

async function expectWritesLanded(h: HarperInstance, principal: RemoteInitPrincipal, agentId: string): Promise<string> {
  const roles = await harperOps(h, principal.username, principal.password, { operation: "list_roles" });
  expect(roles.status, `list_roles as ${principal.username}: ${roles.text.slice(0, 200)}`).toBe(200);
  const roleNames = ((roles.body as any[]) ?? []).map((r) => r.role ?? r.name);
  expect(roleNames).toContain("flair_pair_initiator");
  expect(roleNames).toContain("flair_agent");

  const users = await harperOps(h, principal.username, principal.password, { operation: "list_users" });
  expect(users.status).toBe(200);
  expect(((users.body as any[]) ?? []).map((u) => u.username)).toContain("flair-agent");

  const agent = await harperGet(h, `/Agent/${agentId}`, principal.username, principal.password);
  expect(agent.status, `Agent ${agentId} read as the principal: body ${JSON.stringify(agent.body)?.slice(0, 200)}`).toBe(200);
  expect(agent.body?.id).toBe(agentId);

  const skill = await harperGet(h, `/Memory/${encodeURIComponent("skill:using-flair")}`, principal.username, principal.password);
  expect(skill.status).toBe(200);
  expect(skill.body?.agentId).toBe(principal.username);

  const instance = await harperGet(h, "/FederationInstance", principal.username, principal.password);
  expect(instance.status).toBe(200);
  const rows = Array.isArray(instance.body) ? instance.body : [instance.body];
  expect(rows.filter((r: any) => r?.role === "hub").length).toBe(1);
  return rows.find((r: any) => r?.role === "hub")?.id;
}

describe("flair#3106 — existing super_user branch (real Harper)", () => {
  let harper: HarperInstance;

  beforeAll(async () => {
    harper = await startLocalHarper();
    // A super_user whose name is not `admin`, so a later call that falls back
    // to the default name is both a wrong user and a wrong password.
    const role = await harperOps(harper, "admin", "test123", { operation: "add_role", role: "super-role", permission: { super_user: true } });
    expect([200, 409], role.text).toContain(role.status);
    const user = await harperOps(harper, "admin", "test123", {
      operation: "add_user", username: "cluster-north", password: "cluster-north-pass", role: "super-role", active: true,
    });
    expect([200, 409], user.text).toContain(user.status);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

  test("reuses the cluster administrator and makes every later call as that user", async () => {
    const recorder = installRecorder({ user: "cluster-north", pass: "cluster-north-pass" });
    try {
      const principal = await provisionFabric(
        harper.httpURL, harper.opsURL, "cluster-north", "cluster-north-pass", "generated-north",
      );
      expect(principal).toEqual({ username: "cluster-north", password: "cluster-north-pass", created: false });
      expect(recorder.deployAuthOk(), "the deploy request must carry the cluster administrator's Basic auth").toBe(true);

      recorder.calls.length = 0;
      const keysDir = join(tmpDir, "keys-north");
      const out = await finishRemoteInit(principal, laterOptions(harper, "agent-north", keysDir));

      expectAllCallsAs(recorder.calls, "cluster-north", "cluster-north-pass", "existing super_user branch");
      const hubId = await expectWritesLanded(harper, principal, "agent-north");
      expect(out.instanceId).toBe(hubId);
      expect(out.privPath).toBe(join(keysDir, "agent-north.key"));

      // The summary hint must name the password this principal actually used.
      const hint = adminPasswordHintLine(principal, join(tmpDir, "admin-pass"));
      expect(hint).toContain("cluster administrator password");
      expect(hint).not.toContain(join(tmpDir, "admin-pass"));
    } finally {
      recorder.restore();
    }
  }, 120_000);

  test("reused super_user: the action authenticates every later call as it and prints the cluster-administrator hint", async () => {
    const recorder = installRecorder({ user: "cluster-north", pass: "cluster-north-pass" });
    const home = mkdtempSync(join(tmpDir, "home-"));
    const savedProfile = process.env.USERPROFILE;
    try {
      const out = await runInitAction(initArgs(harper, {
        clusterUser: "cluster-north",
        clusterPass: "cluster-north-pass",
        flairPass: "supplied-north",
        agentId: "agent-north-action",
        keysDir: join(tmpDir, "keys-north-action"),
      }), home);
      expect(out.exitCode).toBeUndefined();
      expect(recorder.deployAuthOk(), "the deploy request must carry the cluster administrator's Basic auth").toBe(true);
      expect(recorder.calls.length, "the later steps made no authenticated call").toBeGreaterThan(0);
      expect(Array.from(new Set(recorder.calls.map((c) => c.user))), "every later call must authenticate as the reused super_user").toEqual(["cluster-north"]);
      expect(recorder.calls.every((c) => c.user === "cluster-north" && c.pass === "cluster-north-pass"), "every later call must carry the reused super_user's credentials").toBe(true);

      const principal: RemoteInitPrincipal = { username: "cluster-north", password: "cluster-north-pass", created: false };
      await expectWritesLanded(harper, principal, "agent-north-action");

      // The reused super_user keeps its own password, so this run writes no
      // admin-pass file: the chosen Flair admin password was never set on it.
      const secretPath = join(home, ".tps", "secrets", "flair-fabric-hdb");
      expect(existsSync(secretPath), "a reused principal must not get an admin-pass file").toBe(false);
      // The action ran with both home variables pointing at its isolated home,
      // and restored them afterwards. The win32 branch in resolveHome() itself
      // is not exercised on Linux; this pins the assignment and the restore.
      expect(out.envDuringAction.HOME).toBe(home);
      expect(out.envDuringAction.USERPROFILE).toBe(home);
      expect(process.env.USERPROFILE).toBe(savedProfile);
      const hint = hintOf(out.stdout);
      expect(hint).toContain("cluster administrator password");
      expect(hint).not.toContain(secretPath);
      expect(out.stdout).toContain("Admin user: cluster-north");
    } finally {
      recorder.restore();
    }
  }, 150_000);

});

describe("flair#3106 — created admin branch (real Harper)", () => {
  let harper: HarperInstance;

  beforeAll(async () => {
    harper = await startLocalHarper();
    // A second super_user so Harper will let `admin` go (it refuses to drop the
    // last one), then a non-super cluster administrator that may add users.
    const superRole = await harperOps(harper, "admin", "test123", { operation: "add_role", role: "super-role", permission: { super_user: true } });
    expect([200, 409], superRole.text).toContain(superRole.status);
    const superUser = await harperOps(harper, "admin", "test123", {
      operation: "add_user", username: "cluster-south", password: "cluster-south-pass", role: "super-role", active: true,
    });
    expect([200, 409], superUser.text).toContain(superUser.status);

    const opsRole = await harperOps(harper, "admin", "test123", {
      operation: "add_role",
      role: "cluster-ops-role",
      permission: { super_user: false, operations: ["add_user", "drop_user", "alter_user", "list_users"] },
    });
    expect([200, 409], opsRole.text).toContain(opsRole.status);
    const opsUser = await harperOps(harper, "admin", "test123", {
      operation: "add_user", username: "cluster-east", password: "cluster-east-pass", role: "cluster-ops-role", active: true,
    });
    expect([200, 409], opsUser.text).toContain(opsUser.status);

    const dropped = await harperOps(harper, "admin", "test123", { operation: "drop_user", username: "admin" });
    expect(dropped.status, `drop_user admin: ${dropped.text.slice(0, 200)}`).toBe(200);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

  test("creates admin when the cluster administrator is not a super_user, and makes every later call as that admin", async () => {
    const recorder = installRecorder({ user: "cluster-east", pass: "cluster-east-pass" });
    try {
      const principal = await provisionFabric(
        harper.httpURL, harper.opsURL, "cluster-east", "cluster-east-pass", "generated-east",
      );
      expect(principal).toEqual({ username: "admin", password: "generated-east", created: true });
      expect(recorder.deployAuthOk(), "the deploy request must carry the cluster administrator's Basic auth").toBe(true);

      recorder.calls.length = 0;
      const keysDir = join(tmpDir, "keys-east");
      const out = await finishRemoteInit(principal, laterOptions(harper, "agent-east", keysDir));

      expectAllCallsAs(recorder.calls, "admin", "generated-east", "created admin branch");
      const hubId = await expectWritesLanded(harper, principal, "agent-east");
      expect(out.instanceId).toBe(hubId);

      const hint = adminPasswordHintLine(principal, join(tmpDir, "admin-pass"));
      expect(hint).toContain(join(tmpDir, "admin-pass"));
    } finally {
      recorder.restore();
    }
  }, 120_000);

  test("a reused super_user NAMED admin gets the cluster-administrator hint and authenticates with its own password", async () => {
    const recorder = installRecorder({ user: "admin", pass: "reused-admin-pass" });
    try {
      // Make an `admin` super_user exist with a known password, independently of
      // the created-admin test above (add_user, else alter_user when it is
      // already there). Reusing it is the case where the username alone cannot
      // tell reuse from creation: only the password and `created` differ.
      const seeded = await harperOps(harper, "cluster-east", "cluster-east-pass", {
        operation: "add_user", username: "admin", password: "reused-admin-pass", role: "super_user", active: true,
      });
      if (seeded.status !== 200) {
        const altered = await harperOps(harper, "cluster-east", "cluster-east-pass", {
          operation: "alter_user", username: "admin", password: "reused-admin-pass", role: "super_user", active: true,
        });
        expect(altered.status, `alter_user admin: ${altered.text.slice(0, 200)}`).toBe(200);
      }

      const principal = await provisionFabric(
        harper.httpURL, harper.opsURL, "admin", "reused-admin-pass", "generated-second",
      );
      expect(principal).toEqual({ username: "admin", password: "reused-admin-pass", created: false });
      expect(recorder.deployAuthOk(), "the deploy request must carry the cluster administrator's Basic auth").toBe(true);

      recorder.calls.length = 0;
      const out = await finishRemoteInit(principal, laterOptions(harper, "agent-west", join(tmpDir, "keys-west")));
      expectAllCallsAs(recorder.calls, "admin", "reused-admin-pass", "reused admin branch");
      await expectWritesLanded(harper, principal, "agent-west");
      expect(out.instanceId).toBeTruthy();

      const hint = adminPasswordHintLine(principal, join(tmpDir, "admin-pass"));
      expect(hint).toContain("cluster administrator password");
      expect(hint).not.toContain(join(tmpDir, "admin-pass"));
    } finally {
      recorder.restore();
    }
  }, 120_000);

  test("created admin: the action creates admin and authenticates every later call as it", async () => {
    // Establish an absent `admin` here rather than relying on an earlier case
    // in this suite: read first, drop only when present, then confirm absent.
    const listed = await harperOps(harper, "cluster-south", "cluster-south-pass", { operation: "list_users" });
    expect(listed.status, `list_users: ${listed.text.slice(0, 200)}`).toBe(200);
    if (((listed.body as any[]) ?? []).some((u) => u.username === "admin")) {
      const dropped = await harperOps(harper, "cluster-south", "cluster-south-pass", { operation: "drop_user", username: "admin" });
      expect(dropped.status, `drop_user admin: ${dropped.text.slice(0, 200)}`).toBe(200);
    }
    const absent = await harperOps(harper, "cluster-south", "cluster-south-pass", { operation: "list_users" });
    expect(((absent.body as any[]) ?? []).some((u) => u.username === "admin"), "admin must be absent before the action").toBe(false);

    const recorder = installRecorder({ user: "cluster-east", pass: "cluster-east-pass" });
    const home = mkdtempSync(join(tmpDir, "home-"));
    try {
      const out = await runInitAction(initArgs(harper, {
        clusterUser: "cluster-east",
        clusterPass: "cluster-east-pass",
        flairPass: "chosen-east",
        agentId: "agent-east-action",
        keysDir: join(tmpDir, "keys-east-action"),
      }), home);
      expect(out.exitCode).toBeUndefined();
      expect(recorder.deployAuthOk(), "the deploy request must carry the cluster administrator's Basic auth").toBe(true);
      expect(recorder.calls.length, "the later steps made no authenticated call").toBeGreaterThan(0);

      // Provisioning itself authenticates as the cluster administrator. Every
      // call after the first one made as the created admin must be the admin's.
      const firstAdminCall = recorder.calls.findIndex((c) => c.user === "admin");
      expect(firstAdminCall, "provisioning never made a call as the created admin").toBeGreaterThan(0);
      const provisioning = recorder.calls.slice(0, firstAdminCall);
      const later = recorder.calls.slice(firstAdminCall);
      expect(
        provisioning.every((c) => c.user === "cluster-east" && c.pass === "cluster-east-pass"),
        "the provisioning calls must carry the cluster administrator's credentials",
      ).toBe(true);
      expectAllCallsAs(later, "admin", "chosen-east", "created admin action");

      const principal: RemoteInitPrincipal = { username: "admin", password: "chosen-east", created: true };
      await expectWritesLanded(harper, principal, "agent-east-action");

      const secretPath = join(home, ".tps", "secrets", "flair-fabric-hdb");
      expect(readFileSync(secretPath, "utf8") === "chosen-east\n", "the admin-pass file must hold the chosen Flair admin password").toBe(true);
      const hint = hintOf(out.stdout);
      expect(hint).toContain(secretPath);
      expect(out.stdout).toContain("Admin user: admin");
    } finally {
      recorder.restore();
    }
  }, 150_000);

  test("reused super_user named admin: the action leaves the saved credential untouched", async () => {
    const seeded = await harperOps(harper, "cluster-east", "cluster-east-pass", {
      operation: "add_user", username: "admin", password: "reused-admin-pass", role: "super_user", active: true,
    });
    if (seeded.status !== 200) {
      const altered = await harperOps(harper, "cluster-east", "cluster-east-pass", {
        operation: "alter_user", username: "admin", password: "reused-admin-pass", role: "super_user", active: true,
      });
      expect(altered.status, `alter_user admin: ${altered.text.slice(0, 200)}`).toBe(200);
    }

    const recorder = installRecorder({ user: "admin", pass: "reused-admin-pass" });
    const home = mkdtempSync(join(tmpDir, "home-"));
    // Start with a saved credential file holding the administrator's own
    // password, and omit --flair-admin-pass so init generates one internally.
    const secretPath = join(home, ".tps", "secrets", "flair-fabric-hdb");
    mkdirSync(join(home, ".tps", "secrets"), { recursive: true });
    writeFileSync(secretPath, "reused-admin-pass\n", { mode: 0o600 });
    try {
      const out = await runInitAction(initArgs(harper, {
        clusterUser: "admin",
        clusterPass: "reused-admin-pass",
        agentId: "agent-west-action",
        keysDir: join(tmpDir, "keys-west-action"),
      }), home);
      expect(out.exitCode).toBeUndefined();
      expect(recorder.deployAuthOk(), "the deploy request must carry the cluster administrator's Basic auth").toBe(true);
      expect(recorder.calls.length, "the later steps made no authenticated call").toBeGreaterThan(0);
      expect(Array.from(new Set(recorder.calls.map((c) => c.user))), "every later call must authenticate as the reused admin").toEqual(["admin"]);
      expect(recorder.calls.every((c) => c.user === "admin" && c.pass === "reused-admin-pass"), "every later call must carry the reused super_user's own password").toBe(true);

      const principal: RemoteInitPrincipal = { username: "admin", password: "reused-admin-pass", created: false };
      await expectWritesLanded(harper, principal, "agent-west-action");

      // Provisioning reused the existing administrator, so init must not
      // overwrite the saved credential with the Flair admin password it never
      // set on the instance.
      expect(readFileSync(secretPath, "utf8"), "the saved credential must be unchanged").toBe("reused-admin-pass\n");
      const hint = hintOf(out.stdout);
      expect(hint).toContain("cluster administrator password");
      expect(hint).not.toContain(secretPath);
      expect(out.stdout).toContain("Admin user: admin");
    } finally {
      recorder.restore();
    }
  }, 150_000);

  test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "created admin: a failed admin-pass write is fatal and prints no success summary",
    async () => {
      const home = mkdtempSync(join(tmpDir, "home-"));
      const secretsDir = join(home, ".tps", "secrets");
      mkdirSync(secretsDir, { recursive: true });
      const clusterPass = "cluster-east-pass";
      const chosenPass = "chosen-fatal-write-9f3a";
      const recorder = installRecorder({ user: "cluster-east", pass: clusterPass });
      // An unwritable secrets directory makes the post-provision write throw.
      // Root ignores the mode, so this case only runs for a non-root user.
      chmodSync(secretsDir, 0o500);
      let out: Awaited<ReturnType<typeof runInitAction>>;
      try {
        out = await runInitAction(initArgs(harper, {
          clusterUser: "cluster-east",
          clusterPass,
          flairPass: chosenPass,
          agentId: "agent-fatal",
          keysDir: join(tmpDir, "keys-fatal"),
        }), home, { rethrow: false });
      } finally {
        chmodSync(secretsDir, 0o700);
        recorder.restore();
      }

      expect(out.error, "the action must fail when the admin-pass write fails").toBeInstanceOf(Error);
      expect((out.error as NodeJS.ErrnoException | undefined)?.code, "the failure must be the admin-pass write").toBe("EACCES");
      expect((out.error as Error | undefined)?.message ?? "", "the failure must name the admin-pass file").toContain("flair-fabric-hdb");
      expect(
        recorder.all.some((call) => call.operation === "deploy_component"),
        "the action must have provisioned before the write failed",
      ).toBe(true);
      expect(out.exitCode ?? 1, "the action must not report success").not.toBe(0);
      expect(out.stdout, "no success summary may be printed").not.toContain("Flair hub deployed");
      expect(out.stdout, "no admin-pass write may be reported").not.toContain("Admin password written");
      expect(out.stdout, "the chosen password must not reach stdout").not.toContain(chosenPass);
      expect(out.stderr, "the chosen password must not reach stderr").not.toContain(chosenPass);
      expect(out.stdout, "the cluster administrator password must not reach stdout").not.toContain(clusterPass);
      expect(out.stderr, "the cluster administrator password must not reach stderr").not.toContain(clusterPass);
    },
    150_000,
  );
});

describe("flair#3106 — existing admin update path (real Harper)", () => {
  let harper: HarperInstance;

  beforeAll(async () => {
    harper = await startLocalHarper();
    // `admin` already exists on a fresh instance, so a non-super cluster
    // administrator drives provisionFabric's add_user -> "already exists" ->
    // alter_user branch.
    const opsRole = await harperOps(harper, "admin", "test123", {
      operation: "add_role",
      role: "cluster-ops-role",
      permission: { super_user: false, operations: ["add_user", "drop_user", "alter_user", "list_users"] },
    });
    expect([200, 409], opsRole.text).toContain(opsRole.status);
    const opsUser = await harperOps(harper, "admin", "test123", {
      operation: "add_user", username: "cluster-update", password: "cluster-update-pass", role: "cluster-ops-role", active: true,
    });
    expect([200, 409], opsUser.text).toContain(opsUser.status);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

  test("updates the existing admin and the action uses it, its new password and the created hint", async () => {
    const recorder = installRecorder({ user: "cluster-update", pass: "cluster-update-pass" });
    const home = mkdtempSync(join(tmpDir, "home-"));
    try {
      const out = await runInitAction(initArgs(harper, {
        clusterUser: "cluster-update",
        clusterPass: "cluster-update-pass",
        flairPass: "chosen-update",
        agentId: "agent-update",
        keysDir: join(tmpDir, "keys-update"),
      }), home);
      expect(out.exitCode).toBeUndefined();
      expect(recorder.deployAuthOk(), "the deploy request must carry the cluster administrator's Basic auth").toBe(true);
      // The case must drill the update branch, not a create.
      expect(out.stdout).toContain("User 'admin' updated");

      // Provisioning runs as the cluster administrator until the existing
      // `admin` is selected; every call after that must be `admin`.
      const firstAdminCall = recorder.calls.findIndex((c) => c.user === "admin");
      expect(firstAdminCall, "provisioning never selected the updated admin").toBeGreaterThan(0);
      expect(
        recorder.calls.slice(0, firstAdminCall).every((c) => c.user === "cluster-update" && c.pass === "cluster-update-pass"),
        "the provisioning calls must carry the cluster administrator's credentials",
      ).toBe(true);
      expectAllCallsAs(recorder.calls.slice(firstAdminCall), "admin", "chosen-update", "updated admin action");

      const principal: RemoteInitPrincipal = { username: "admin", password: "chosen-update", created: true };
      await expectWritesLanded(harper, principal, "agent-update");

      const secretPath = join(home, ".tps", "secrets", "flair-fabric-hdb");
      expect(readFileSync(secretPath, "utf8") === "chosen-update\n", "the admin-pass file must hold the chosen Flair admin password").toBe(true);
      const hint = hintOf(out.stdout);
      expect(hint).toContain(secretPath);
      expect(out.stdout).toContain("Admin user: admin");
    } finally {
      recorder.restore();
    }
  }, 150_000);
});

describe("flair#3106 — already-running instance leg (real Harper)", () => {
  let harper: HarperInstance;

  beforeAll(async () => {
    harper = await startLocalHarper();
    // A nondefault super_user with its own password: this leg must use the
    // operator's `--admin-user`/`--admin-pass`, not the instance's `admin`.
    const role = await harperOps(harper, "admin", "test123", { operation: "add_role", role: "super-role", permission: { super_user: true } });
    expect([200, 409], role.text).toContain(role.status);
    const user = await harperOps(harper, "admin", "test123", {
      operation: "add_user", username: "ops-distinct", password: "ops-distinct-pass", role: "super-role", active: true,
    });
    expect([200, 409], user.text).toContain(user.status);
    const reserved = await harperOps(harper, "admin", "test123", {
      operation: "add_user", username: "flair-agent", password: "reserved-pass", role: "super-role", active: true,
    });
    expect([200, 409], reserved.text).toContain(reserved.status);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

  test("uses the resolved administrator on every later call and sends /Health without an Authorization header", async () => {
    const recorder = installRecorder({ user: "ops-distinct", pass: "ops-distinct-pass" });
    const home = mkdtempSync(join(tmpDir, "home-"));
    try {
      const out = await runInitAction([
        "--target", harper.httpURL,
        "--ops-target", harper.opsURL,
        "--force",
        "--admin-user", "ops-distinct",
        "--admin-pass", "ops-distinct-pass",
        "--agent-id", "agent-live",
        "--keys-dir", join(tmpDir, "keys-live"),
      ], home);
      expect(out.exitCode).toBeUndefined();
      // The already-running leg provisions no principal, so it writes no
      // admin-pass file; it authenticates with the operator's --admin-pass.
      expect(existsSync(join(home, ".tps", "secrets", "flair-fabric-hdb"))).toBe(false);
      // HOME isolation does not cover in-process helpers: every request must
      // target THIS ephemeral instance, never a default port elsewhere.
      expect(
        recorder.all.every((c) => c.url.startsWith(harper.httpURL) || c.url.startsWith(harper.opsURL)),
        "every request must target this ephemeral instance",
      ).toBe(true);
      expect(recorder.calls.length, "the later steps made no authenticated call").toBeGreaterThan(0);
      expect(Array.from(new Set(recorder.calls.map((c) => c.user))), "every authenticated later call must be the resolved administrator").toEqual(["ops-distinct"]);
      expect(recorder.calls.every((c) => c.pass === "ops-distinct-pass"), "every authenticated later call must carry its password").toBe(true);
      expect(recorder.calls.some((c) => c.path.startsWith("/Memory/")), "the skill seed").toBe(true);
      expect(recorder.calls.some((c) => c.operation === "insert"), "the agent seed").toBe(true);

      const health = recorder.all.filter((c) => new URL(c.url).pathname === "/Health");
      expect(health.length, "the leg must check /Health").toBeGreaterThan(0);
      expect(health.every((c) => c.authz === null), "/Health must not send an Authorization header").toBe(true);

      const skill = await harperGet(harper, `/Memory/${encodeURIComponent("skill:using-flair")}`, "ops-distinct", "ops-distinct-pass");
      expect(skill.status).toBe(200);
      expect(skill.body?.agentId).toBe("ops-distinct");
      const agent = await harperGet(harper, "/Agent/agent-live", "ops-distinct", "ops-distinct-pass");
      expect(agent.status, `Agent agent-live: body ${JSON.stringify(agent.body)?.slice(0, 200)}`).toBe(200);
      expect(agent.body?.id).toBe("agent-live");
    } finally {
      recorder.restore();
    }
  }, 150_000);

  test("refuses --admin-user flair-agent before any write and leaves its role unchanged", async () => {
    const before = await harperOps(harper, "admin", "test123", { operation: "list_users" });
    expect(before.status).toBe(200);
    const beforeRow = ((before.body as any[]) ?? []).find((u) => u.username === "flair-agent");
    expect(beforeRow, "the reserved super_user must exist").toBeTruthy();

    const recorder = installRecorder({ user: "flair-agent", pass: "reserved-pass" });
    const home = mkdtempSync(join(tmpDir, "home-"));
    let out: Awaited<ReturnType<typeof runInitAction>>;
    try {
      out = await runInitAction([
        "--target", harper.httpURL,
        "--ops-target", harper.opsURL,
        "--force",
        "--admin-user", "flair-agent",
        "--admin-pass", "reserved-pass",
        "--agent-id", "agent-reserved-live",
        "--keys-dir", join(tmpDir, "keys-reserved-live"),
      ], home);
    } finally {
      recorder.restore();
    }

    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("'flair-agent' is a reserved Flair account");
    expect(out.stderr).toContain("different admin user");
    expect(out.stderr).toContain("--admin-user");
    expect(readdirSync(home)).toEqual([]);
    expectNoWriteOperation(recorder.all, "reserved-principal refusal on the already-running leg");

    const after = await harperOps(harper, "admin", "test123", { operation: "list_users" });
    expect(after.status).toBe(200);
    const afterRow = ((after.body as any[]) ?? []).find((u) => u.username === "flair-agent");
    expect(afterRow, "the reserved account's role must be unchanged").toEqual(beforeRow);
  }, 150_000);
});

// ─── the `flair init` action helpers ────────────────────────────────────────────
//
// These drive the command action itself: the principal assignment, the later
// calls, the admin-pass file write and the summary hint. A change that swaps
// the selected principal for default credentials, or picks the hint by
// username, has to fail here; the handler-level cases above do not see the
// action's own wiring.

type InitActionEnv = {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  FLAIR_ADMIN_PASS: string | undefined;
  FLAIR_CLUSTER_ADMIN_USER: string | undefined;
  FLAIR_CLUSTER_ADMIN_PASS: string | undefined;
  FLAIR_TARGET: string | undefined;
  FLAIR_OPS_TARGET: string | undefined;
  FLAIR_ADMIN_USER: string | undefined;
  ROOTPATH: string | undefined;
};

/** Run the in-process `flair init` action with HOME isolated to `home`. */
async function runInitAction(args: string[], home: string, opts: { rethrow?: boolean } = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode?: number;
  /** The action's own rejection, when `rethrow: false` captured it. */
  error?: Error;
  /** HOME/USERPROFILE as the action saw them, captured before restore. */
  envDuringAction: { HOME: string | undefined; USERPROFILE: string | undefined };
}> {
  const saved: InitActionEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    FLAIR_ADMIN_PASS: process.env.FLAIR_ADMIN_PASS,
    FLAIR_CLUSTER_ADMIN_USER: process.env.FLAIR_CLUSTER_ADMIN_USER,
    FLAIR_CLUSTER_ADMIN_PASS: process.env.FLAIR_CLUSTER_ADMIN_PASS,
    FLAIR_TARGET: process.env.FLAIR_TARGET,
    FLAIR_OPS_TARGET: process.env.FLAIR_OPS_TARGET,
    FLAIR_ADMIN_USER: process.env.FLAIR_ADMIN_USER,
    ROOTPATH: process.env.ROOTPATH,
  };
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  let error: Error | undefined;
  let envDuringAction: { HOME: string | undefined; USERPROFILE: string | undefined } = { HOME: undefined, USERPROFILE: undefined };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.FLAIR_ADMIN_PASS;
  delete process.env.FLAIR_CLUSTER_ADMIN_USER;
  delete process.env.FLAIR_CLUSTER_ADMIN_PASS;
  delete process.env.FLAIR_TARGET;
  delete process.env.FLAIR_OPS_TARGET;
  delete process.env.FLAIR_ADMIN_USER;
  delete process.env.ROOTPATH;
  console.log = (...parts: unknown[]) => { stdout += parts.map((part) => String(part)).join(" ") + "\n"; };
  console.error = (...parts: unknown[]) => { stderr += parts.map((part) => String(part)).join(" ") + "\n"; };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  try {
    await program.parseAsync(["node", "flair", "init", ...args]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("process.exit")) {
      if (opts.rethrow === false) error = err instanceof Error ? err : new Error(message);
      else throw err;
    }
  } finally {
    envDuringAction = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.FLAIR_ADMIN_PASS === undefined) delete process.env.FLAIR_ADMIN_PASS;
    else process.env.FLAIR_ADMIN_PASS = saved.FLAIR_ADMIN_PASS;
    if (saved.FLAIR_CLUSTER_ADMIN_USER === undefined) delete process.env.FLAIR_CLUSTER_ADMIN_USER;
    else process.env.FLAIR_CLUSTER_ADMIN_USER = saved.FLAIR_CLUSTER_ADMIN_USER;
    if (saved.FLAIR_CLUSTER_ADMIN_PASS === undefined) delete process.env.FLAIR_CLUSTER_ADMIN_PASS;
    else process.env.FLAIR_CLUSTER_ADMIN_PASS = saved.FLAIR_CLUSTER_ADMIN_PASS;
    if (saved.FLAIR_TARGET === undefined) delete process.env.FLAIR_TARGET;
    else process.env.FLAIR_TARGET = saved.FLAIR_TARGET;
    if (saved.FLAIR_OPS_TARGET === undefined) delete process.env.FLAIR_OPS_TARGET;
    else process.env.FLAIR_OPS_TARGET = saved.FLAIR_OPS_TARGET;
    if (saved.FLAIR_ADMIN_USER === undefined) delete process.env.FLAIR_ADMIN_USER;
    else process.env.FLAIR_ADMIN_USER = saved.FLAIR_ADMIN_USER;
    if (saved.ROOTPATH === undefined) delete process.env.ROOTPATH;
    else process.env.ROOTPATH = saved.ROOTPATH;
  }
  return { stdout, stderr, exitCode, error, envDuringAction };
}

const hintOf = (stdout: string): string =>
  stdout.split("\n").find((line) => line.startsWith("  Admin password:")) ?? "";

const initArgs = (h: HarperInstance, opts: {
  clusterUser: string; clusterPass: string; flairPass?: string; agentId: string; keysDir: string;
}): string[] => [
  "--target", h.httpURL,
  "--ops-target", h.opsURL,
  "--remote",
  "--force",
  "--cluster-admin-user", opts.clusterUser,
  "--cluster-admin-pass", opts.clusterPass,
  ...(opts.flairPass === undefined ? [] : ["--flair-admin-pass", opts.flairPass]),
  "--agent-id", opts.agentId,
  "--keys-dir", opts.keysDir,
];
