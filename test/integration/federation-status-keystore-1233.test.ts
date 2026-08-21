/**
 * federation-status-keystore-1233.test.ts — flair#1233 regression: a READ
 * path (GET /FederationInstance, and `flair federation status` on top of it)
 * must never require identity-CREATION capability.
 *
 * ─── What broke ────────────────────────────────────────────────────────────
 * FederationInstance.get() does find-or-create inline. On first authorized
 * GET with no Instance row, it generates a keypair and writes the seed to the
 * keystore — which is unconditionally homedir()-relative
 * (src/keystore.ts keysDir() = <HOME>/.flair/keys). On a deployment shape
 * where HOME isn't writable (Fabric-managed hub, the #812 class), that write
 * throws, the GET 500s ("Keystore unavailable"), and the hub's federation
 * state is unobservable by an operator at all — the 2026-08-16 tps.dtrt
 * incident in flair#1233.
 *
 * Post-fix: the identity row is still created, the keystore failure is logged
 * server-side, and the GET returns 200 with a RUNTIME-ONLY
 * `signingKeyAvailable: false` field. Signing (pair/sync) remains fail-closed
 * — the missing key fails there, its correct point of use.
 *
 * ─── Why a SIBLING FILE, not a describe in gate4-authgate.test.ts ──────────
 * gate4 boots ONE shared Harper for four resource-gate suites, and its admin
 * GET test creates the federation identity with a WORKING keystore. This
 * file's core scenario is keystore-broken-BEFORE-first-identity-creation:
 * <HOME>/.flair replaced by a regular file (the #812 ENOTDIR technique,
 * deterministic for any user including root). That needs its own boot
 * lifecycle, and mutating the shared instance's HOME would poison gate4's
 * other suites. MODEL: migrations-provisioned-datadir.test.ts (the ENOTDIR
 * blocker shape) + cli-local-admin-pass-fallback.test.ts (real-CLI
 * subprocess pattern).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
  // Merge onto a copy of the real env, but explicitly DELETE any key passed
  // as undefined — isolation even if the host shell has FLAIR_* set.
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const proc = Bun.spawn(["bun", cliPath, ...args], { env: merged, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function basicAuth(harper: HarperInstance): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

// Env base for CLI runs: isolated HOME, admin Basic auth, everything else
// that could change auth resolution or output mode explicitly cleared.
function cliEnv(harper: HarperInstance, home: string, extra: Record<string, string | undefined> = {}) {
  return {
    HOME: home,
    FLAIR_ADMIN_PASS: harper.admin.password,
    HDB_ADMIN_PASSWORD: undefined,
    FLAIR_AGENT_ID: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_TARGET: undefined,
    FLAIR_OUTPUT: undefined,
    ...extra,
  };
}

// ─── A. Keystore-blocked instance: <HOME>/.flair is a regular file ──────────

describe("flair#1233: GET /FederationInstance with an unusable keystore (HOME/.flair is a file)", () => {
  let harper: HarperInstance;
  let blockedFlairPath: string;
  let firstBody: any;

  beforeAll(async () => {
    harper = await startHarper();
    // Block AFTER boot, BEFORE the first authorized GET (which is what
    // find-or-creates the identity). startHarper sets the spawned Harper's
    // HOME (and ROOTPATH) to installDir, so keysDir() resolves under it. A
    // regular file at <HOME>/.flair makes mkdir -p of <HOME>/.flair/keys fail
    // with ENOTDIR for every user, root included — same technique as
    // migrations-provisioned-datadir.test.ts (flair#812).
    blockedFlairPath = join(harper.installDir, ".flair");
    rmSync(blockedFlairPath, { recursive: true, force: true });
    writeFileSync(blockedFlairPath, "flair#1233: this path is deliberately not a directory\n");
  }, 240_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("the blocker really is in place — <HOME>/.flair is a regular file", () => {
    expect(existsSync(blockedFlairPath)).toBe(true);
    expect(lstatSync(blockedFlairPath).isFile()).toBe(true);
  });

  test("RED-ON-MAIN: first admin GET → 200 with identity + signingKeyAvailable:false (main: 500 'Keystore unavailable')", async () => {
    const res = await fetch(`${harper.httpURL}/FederationInstance`, {
      headers: { Authorization: basicAuth(harper) },
    });
    const text = await res.text();
    expect(res.status, `GET /FederationInstance returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    firstBody = JSON.parse(text);
    expect(firstBody.id).toMatch(/^flair_/);
    expect(firstBody.publicKey).toBeTruthy();
    // The whole point of #1233: the read degrades VISIBLY instead of 500ing.
    expect(firstBody.signingKeyAvailable).toBe(false);
    // Runtime-only — must not repurpose the persisted status enum.
    expect(firstBody.status).toBe("active");
  }, 30_000);

  test("steady state: identity now exists, key still missing → 200 + signingKeyAvailable:false (existing-identity probe path)", async () => {
    const res = await fetch(`${harper.httpURL}/FederationInstance`, {
      headers: { Authorization: basicAuth(harper) },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    // Same identity as the create-branch GET — proves the row persisted and
    // this GET took the found-row path, whose signingKeyAvailable comes from
    // the keystore probe, not the create-branch flag.
    expect(body.id).toBe(firstBody.id);
    expect(body.signingKeyAvailable).toBe(false);
  }, 30_000);

  test("CLI human render: degraded marker with keystore path + remedy, exit 0", async () => {
    const tmpHome = makeTmpDir("flair-1233-cli-degraded");
    try {
      const { exitCode, stdout, stderr } = await runCli(
        ["federation", "status", "--target", harper.httpURL],
        cliEnv(harper, tmpHome, { FLAIR_OUTPUT: "human" }),
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      // Identity still renders...
      expect(stdout).toContain(firstBody.id);
      // ...with the actor+state+remedy degraded marker.
      expect(stdout).toContain("Signing key unavailable");
      expect(stdout).toContain(".flair/keys");
      expect(stdout).toMatch(/writable by the Harper process/);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("CLI JSON render: instance.signingKeyAvailable:false, peers verified, exit 0", async () => {
    const tmpHome = makeTmpDir("flair-1233-cli-json");
    try {
      const { exitCode, stdout, stderr } = await runCli(
        ["federation", "status", "--target", harper.httpURL, "--json"],
        cliEnv(harper, tmpHome),
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      const body = JSON.parse(stdout);
      expect(body.instance?.signingKeyAvailable).toBe(false);
      expect(Array.isArray(body.peers)).toBe(true);
      // Both reads succeeded — nothing is unverifiable.
      expect(body.unverifiable).toBeUndefined();
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);
});

// ─── B. First-boot control: normal writable HOME ────────────────────────────
//
// Kern's attack point on the spec: prove genuine first boot still works —
// the create branch fires, the key REALLY lands in the keystore (positive
// control that the blocker above targets the actual write path), and no
// degraded marker renders.

describe("flair#1233 control: genuine first boot with a writable HOME", () => {
  let harper: HarperInstance;
  let body: any;

  beforeAll(async () => {
    harper = await startHarper();
  }, 240_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("first admin GET → 200, identity created, signingKeyAvailable:true", async () => {
    const res = await fetch(`${harper.httpURL}/FederationInstance`, {
      headers: { Authorization: basicAuth(harper) },
    });
    const text = await res.text();
    expect(res.status, `GET /FederationInstance returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    body = JSON.parse(text);
    expect(body.id).toMatch(/^flair_/);
    expect(body.publicKey).toBeTruthy();
    expect(body.signingKeyAvailable).toBe(true);
  }, 30_000);

  test("the key file really exists where the keystore says it does (positive control for the ENOTDIR blocker)", () => {
    // keysDir() is <HOME>/.flair/keys and startHarper sets HOME=installDir.
    const keyFile = join(harper.installDir, ".flair", "keys", `${body.id}.key`);
    expect(existsSync(keyFile), `expected key file at ${keyFile}`).toBe(true);
  });

  test("second GET (found-row path) → signingKeyAvailable still true", async () => {
    const res = await fetch(`${harper.httpURL}/FederationInstance`, {
      headers: { Authorization: basicAuth(harper) },
    });
    expect(res.status).toBe(200);
    const second: any = await res.json();
    expect(second.id).toBe(body.id);
    expect(second.signingKeyAvailable).toBe(true);
  }, 30_000);

  test("CLI human render: NO degraded marker, exit 0", async () => {
    const tmpHome = makeTmpDir("flair-1233-cli-healthy");
    try {
      const { exitCode, stdout, stderr } = await runCli(
        ["federation", "status", "--target", harper.httpURL],
        cliEnv(harper, tmpHome, { FLAIR_OUTPUT: "human" }),
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      expect(stdout).toContain(body.id);
      expect(stdout).not.toContain("Signing key unavailable");
      expect(stdout).not.toContain("unverifiable");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);
});

// ─── C. CLI independence: one read failing must not abort the render ────────
//
// Mock servers, not Harper: forcing exactly ONE of the two endpoints to fail
// on a real instance would need server-side fault injection; a mock pins the
// contract precisely. mock A is byte-for-byte the flair#1233 field incident —
// an UNPATCHED hub whose /FederationInstance 500s "Keystore unavailable" —
// proving the CLI half of the fix helps against old servers too.

describe("flair#1233: CLI fetches instance and peers independently", () => {
  const mockPeer = {
    id: "peer-mock-1233",
    role: "spoke",
    status: "connected",
    lastSyncAt: new Date().toISOString(),
    lastMergeAt: new Date().toISOString(),
    relayOnly: false,
  };

  function mockServer(handlers: Record<string, () => Response>) {
    return Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        const h = handlers[path];
        return h ? h() : new Response("not found", { status: 404 });
      },
    });
  }

  // Dummy admin pass so api() sends Basic auth; the mocks ignore auth.
  const mockCliEnv = (home: string, extra: Record<string, string | undefined> = {}) => ({
    HOME: home,
    FLAIR_ADMIN_PASS: "mock-test-pass",
    HDB_ADMIN_PASSWORD: undefined,
    FLAIR_AGENT_ID: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_TARGET: undefined,
    FLAIR_OUTPUT: "human" as string | undefined,
    ...extra,
  });

  test("instance 500s (unpatched #1233 hub), peers OK → peers render, instance marked unverifiable, exit 0", async () => {
    const server = mockServer({
      "/FederationInstance": () =>
        new Response("Keystore unavailable — cannot create federation identity without secure key storage", { status: 500 }),
      "/FederationPeers": () =>
        Response.json({ peers: [mockPeer] }),
    });
    const tmpHome = makeTmpDir("flair-1233-mock-inst500");
    try {
      const { exitCode, stdout, stderr } = await runCli(
        ["federation", "status", "--target", `http://127.0.0.1:${server.port}`],
        mockCliEnv(tmpHome),
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      expect(stdout).toContain("unverifiable");
      expect(stdout).toContain("Keystore unavailable");
      // The peer table still rendered — the whole point.
      expect(stdout).toContain("peer-mock-1233");
    } finally {
      server.stop(true);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("instance OK, peers 500 → instance renders, peers marked unverifiable (not 'no peers'), exit 0", async () => {
    const server = mockServer({
      "/FederationInstance": () =>
        Response.json({ id: "flair_mock1233", publicKey: "pk", role: "hub", status: "active", signingKeyAvailable: true }),
      "/FederationPeers": () =>
        new Response("peer table read failed", { status: 500 }),
    });
    const tmpHome = makeTmpDir("flair-1233-mock-peers500");
    try {
      const { exitCode, stdout, stderr } = await runCli(
        ["federation", "status", "--target", `http://127.0.0.1:${server.port}`],
        mockCliEnv(tmpHome),
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      expect(stdout).toContain("flair_mock1233");
      expect(stdout).toContain("Peers unverifiable");
      // "read failed" must not be conflated with "verified empty".
      expect(stdout).not.toContain("No peers configured");
    } finally {
      server.stop(true);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("both reads fail → classic failure UX, exit 1 (nothing to render is still an error)", async () => {
    const server = mockServer({
      "/FederationInstance": () => new Response("boom-instance", { status: 500 }),
      "/FederationPeers": () => new Response("boom-peers", { status: 500 }),
    });
    const tmpHome = makeTmpDir("flair-1233-mock-both500");
    try {
      const { exitCode, stderr, stdout } = await runCli(
        ["federation", "status", "--target", `http://127.0.0.1:${server.port}`],
        mockCliEnv(tmpHome),
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).not.toBe(0);
      expect(stderr).toContain("boom-instance");
    } finally {
      server.stop(true);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("JSON mode carries the unverifiable map alongside what was read", async () => {
    const server = mockServer({
      "/FederationInstance": () =>
        new Response("Keystore unavailable — cannot create federation identity without secure key storage", { status: 500 }),
      "/FederationPeers": () =>
        Response.json({ peers: [mockPeer] }),
    });
    const tmpHome = makeTmpDir("flair-1233-mock-json");
    try {
      const { exitCode, stdout, stderr } = await runCli(
        ["federation", "status", "--target", `http://127.0.0.1:${server.port}`, "--json"],
        mockCliEnv(tmpHome, { FLAIR_OUTPUT: undefined }),
      );
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      const body = JSON.parse(stdout);
      expect(body.instance).toBeNull();
      expect(body.peers?.[0]?.id).toBe("peer-mock-1233");
      expect(String(body.unverifiable?.instance)).toContain("Keystore unavailable");
      expect(body.unverifiable?.peers).toBeUndefined();
    } finally {
      server.stop(true);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);
});
