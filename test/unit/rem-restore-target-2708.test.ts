/**
 * rem-restore-target-2708.test.ts — `flair rem restore` lists candidates on
 * the same instance it writes to (flair#2708).
 *
 * The CLI tests run the real CLI against stub instances, each its own process
 * serving an HTTP port and an operations port (test/helpers/
 * rem-restore-stub-instance.ts), so restore's loopback pair check reads the
 * real OS listener table. Instance A is the default config's instance when a
 * test writes one; instance B is the FLAIR_URL target. Every CLI run loads
 * test/helpers/fetch-request-log-preload.ts, which records each request the
 * CLI sends, so a refusal can be shown to have sent nothing at all.
 *
 * The resolver tests are pure. The non-loopback pair check and the REST transport's
 * redirect refusal run against real local HTTP servers with the real fetch:
 * the servers stand in for a non-loopback target's two endpoints and for a redirect
 * destination, and record every request they receive.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSnapshot } from "../../src/rem/snapshot.ts";
import { establishRestorePair, resolveRestoreTarget, type RestoreTarget } from "../../src/commands/rem.ts";
import { resolveOpsUrlFromTarget } from "../../src/cli.ts";
import { ApiHttpError, authedRequest } from "../../src/lib/auth-resolve.ts";
import { startStubInstance, type StubInstance, type StubRequest, type StubSeed } from "../helpers/rem-restore-stub-instance.ts";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
const fetchLogPreload = join(import.meta.dirname, "..", "helpers", "fetch-request-log-preload.ts");
const AGENT_ID = "agent-a";
const SECRET = "s3cr3t-value-2708";

const dirs: string[] = [];
const instances: StubInstance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The drifted state an instance holds before a restore: rows that differ from the snapshot, and a leftover candidate. */
function driftedSeed() {
  return {
    memories: [
      { id: "m1", agentId: AGENT_ID, content: "drifted memory" },
      { id: "m-extra", agentId: AGENT_ID, content: "not in the snapshot" },
    ],
    souls: [{ id: `soul-${AGENT_ID}`, agentId: AGENT_ID, instructions: "drifted" }],
    candidates: [{ id: "c-1", agentId: AGENT_ID, claim: "a leftover candidate" }],
  };
}

async function startInstance(seed: StubSeed = driftedSeed()): Promise<StubInstance> {
  const instance = await startStubInstance(seed);
  instances.push(instance);
  return instance;
}

/** A HOME with a snapshot for AGENT_ID and, when `configured` is given, that instance's complete pair in config.yaml. */
async function makeHome(configured?: StubInstance): Promise<{ home: string; date: string }> {
  const home = mkdtempSync(join(tmpdir(), "flair-2708-home-"));
  dirs.push(home);
  mkdirSync(join(home, ".flair"), { recursive: true });
  if (configured) {
    writeFileSync(join(home, ".flair", "config.yaml"), `port: ${configured.httpPort}\nopsPort: ${configured.opsPort}\n`);
  }
  const now = new Date();
  await createSnapshot({
    agentId: AGENT_ID,
    flairVersion: "0.0.0-test",
    memories: [{ id: "m1", agentId: AGENT_ID, content: "restored memory" }],
    soul: { id: `soul-${AGENT_ID}`, agentId: AGENT_ID, instructions: "be helpful" },
    pendingCandidateCount: null,
    rootOverride: join(home, ".flair", "snapshots"),
    nowOverride: now,
  });
  return { home, date: now.toISOString().slice(0, 10) };
}

interface FetchRecord {
  method: string;
  host: string;
  path: string;
}

async function runRestore(args: {
  home: string;
  date: string;
  env: Record<string, string | undefined>;
}): Promise<{ code: number | null; stdout: string; stderr: string; fetches: FetchRecord[] }> {
  const fetchLog = join(args.home, "fetch-log.jsonl");
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: args.home,
    FLAIR_URL: undefined,
    FLAIR_OPS_PORT: undefined,
    FLAIR_OPS_TARGET: undefined,
    FLAIR_TARGET: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_ADMIN_PASS: undefined,
    FLAIR_AGENT_ID: undefined,
    FLAIR_TEST_FETCH_LOG: fetchLog,
    NO_COLOR: "1",
    ...args.env,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const child = Bun.spawn(
    ["bun", "--preload", fetchLogPreload, cliPath, "rem", "restore", args.date, "--agent", AGENT_ID, "--apply", "--admin-pass", "test-admin-pass"],
    { env: env as Record<string, string>, timeout: 30_000, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  const fetches = existsSync(fetchLog)
    ? readFileSync(fetchLog, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FetchRecord)
    : [];
  return { code, stdout, stderr, fetches };
}

const writeMethods = new Set(["DELETE", "PUT", "POST", "PATCH"]);
const isListing = (r: StubRequest) => r.endpoint === "ops" && r.operation === "search_by_conditions";
const hostOf = (instance: StubInstance, endpoint: "http" | "ops") =>
  `127.0.0.1:${endpoint === "http" ? instance.httpPort : instance.opsPort}`;

describe("flair#2708 — rem restore target (CLI)", () => {
  test("lists candidates and writes on the FLAIR_URL instance, never the config instance", async () => {
    const a = await startInstance();
    const b = await startInstance();
    const { home, date } = await makeHome(a);

    const result = await runRestore({ home, date, env: { FLAIR_URL: b.httpUrl } });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Status:       completed");
    expect(result.stdout).toContain("Deleted:      2 memories, 1 souls, 1 candidates");

    const bRequests = b.requests();
    // The pair check read B's configuration on its operations port, then the
    // candidate listing ran there and found B's leftover candidate.
    const opsOps = bRequests.filter((r) => r.endpoint === "ops").map((r) => r.operation);
    expect(opsOps[0]).toBe("get_configuration");
    expect(bRequests.some((r) => isListing(r) && r.table === "MemoryCandidate")).toBe(true);
    expect(bRequests.some((r) => r.endpoint === "http" && r.method === "DELETE" && r.path === "/MemoryCandidate/c-1")).toBe(true);
    expect(bRequests.some((r) => r.endpoint === "http" && r.method === "PUT" && r.path.startsWith("/Soul/"))).toBe(true);
    expect(bRequests.some((r) => r.endpoint === "http" && r.method === "PUT" && r.path === "/Memory/m1")).toBe(true);
    expect(bRequests.some((r) => r.endpoint === "http" && r.method === "DELETE" && r.path === "/Memory/m-extra")).toBe(true);

    // Instance A, named by the default config, received nothing.
    expect(a.requests()).toEqual([]);

    // Every request the CLI sent addressed one of B's two ports (the request
    // log saw them, so an empty log elsewhere means nothing was sent).
    expect(result.fetches.length).toBeGreaterThan(0);
    expect([...new Set(result.fetches.map((f) => f.host))].sort()).toEqual([hostOf(b, "http"), hostOf(b, "ops")].sort());
  }, 60_000);

  test("refuses before any request when FLAIR_OPS_PORT conflicts with the configured pair", async () => {
    const a = await startInstance();
    const b = await startInstance();
    const { home, date } = await makeHome(a);

    const result = await runRestore({ home, date, env: { FLAIR_URL: b.httpUrl, FLAIR_OPS_PORT: String(a.opsPort) } });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("FLAIR_OPS_PORT");
    expect(result.stderr).toContain(b.httpUrl);
    expect(result.fetches).toEqual([]);
    expect(a.requests()).toEqual([]);
    expect(b.requests()).toEqual([]);
  }, 60_000);

  test("with no configured pair, refuses an operations port that belongs to another instance before any listing or write", async () => {
    const a = await startInstance();
    const b = await startInstance();
    // No config.yaml: the paired resolver has no configured pair to compare
    // the two named ports with, so only the live pair check can tell them apart.
    const { home, date } = await makeHome();

    const result = await runRestore({ home, date, env: { FLAIR_URL: b.httpUrl, FLAIR_OPS_PORT: String(a.opsPort) } });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `operations port ${a.opsPort} belongs to the instance serving HTTP port ${a.httpPort}, not restore target ${b.httpUrl}`,
    );
    expect(result.stderr).toContain("nothing was listed, deleted or written");

    // A answered one configuration read and nothing else: no listing there.
    expect(a.requests()).toEqual([{ endpoint: "ops", method: "POST", path: "/", operation: "get_configuration" }]);
    // B, the write target, received nothing at all.
    expect(b.requests()).toEqual([]);
    expect(result.fetches.map((f) => f.host)).toEqual([hostOf(a, "ops")]);
  }, 60_000);

  test("sends nothing to a FLAIR_OPS_TARGET that names another endpoint, and refuses before any request", async () => {
    const a = await startInstance();
    const b = await startInstance();
    const c = await startInstance();
    const { home, date } = await makeHome(a);

    const result = await runRestore({ home, date, env: { FLAIR_URL: b.httpUrl, FLAIR_OPS_TARGET: c.opsUrl } });

    // The endpoint FLAIR_OPS_TARGET names received nothing, and neither did anything else.
    expect(c.requests()).toEqual([]);
    expect(b.requests()).toEqual([]);
    expect(a.requests()).toEqual([]);
    expect(result.fetches).toEqual([]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("FLAIR_OPS_TARGET");
    expect(result.stderr).toContain(`Unset FLAIR_OPS_TARGET for this command, or set it to ${b.opsUrl}`);
  }, 60_000);

  test("a FLAIR_OPS_TARGET naming the target's own operations endpoint is accepted, and only the target is addressed", async () => {
    const a = await startInstance();
    const b = await startInstance();
    const { home, date } = await makeHome(a);

    const result = await runRestore({ home, date, env: { FLAIR_URL: b.httpUrl, FLAIR_OPS_TARGET: `${b.opsUrl}/` } });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Status:       completed");
    expect(b.requests().some(isListing)).toBe(true);
    expect(a.requests()).toEqual([]);
    expect([...new Set(result.fetches.map((f) => f.host))].sort()).toEqual([hostOf(b, "http"), hostOf(b, "ops")].sort());
  }, 60_000);

  test("refuses a credential-bearing target URL before any request, and prints none of its values", async () => {
    const a = await startInstance();
    const b = await startInstance();
    const c = await startInstance();
    const { home, date } = await makeHome(a);

    const cases: Array<{ env: Record<string, string>; shown: string; carries?: string }> = [
      { env: { FLAIR_URL: `http://restore-user:${SECRET}@127.0.0.1:${b.httpPort}` }, shown: b.httpUrl, carries: "carries user info" },
      { env: { FLAIR_URL: `http://127.0.0.1:${b.httpPort}/?token=${SECRET}` }, shown: b.httpUrl, carries: "carries a query" },
      { env: { FLAIR_URL: `http://127.0.0.1:${b.httpPort}/#${SECRET}` }, shown: b.httpUrl, carries: "carries a fragment" },
      {
        env: { FLAIR_URL: b.httpUrl, FLAIR_OPS_TARGET: `http://ops-user:${SECRET}@127.0.0.1:${c.opsPort}/?key=${SECRET}` },
        shown: c.opsUrl,
      },
      {
        // The same scheme, host and port as B's operations API, carrying user info and a query.
        env: { FLAIR_URL: b.httpUrl, FLAIR_OPS_TARGET: `http://ops-user:${SECRET}@127.0.0.1:${b.opsPort}/?key=${SECRET}` },
        shown: b.opsUrl,
        carries: "carries user info and a query",
      },
    ];
    for (const { env, shown, carries } of cases) {
      const result = await runRestore({ home, date, env });
      const output = result.stdout + result.stderr;
      expect(result.code).not.toBe(0);
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain("restore-user");
      expect(output).not.toContain("ops-user");
      expect(result.stderr).toContain(shown);
      if (carries) expect(result.stderr).toContain(carries);
      expect(result.fetches).toEqual([]);
    }
    expect(a.requests()).toEqual([]);
    expect(b.requests()).toEqual([]);
    expect(c.requests()).toEqual([]);
  }, 120_000);

  test("a restore write answered with a redirect is refused, and the redirect target receives no request", async () => {
    const elsewhere: string[] = [];
    const redirectTarget = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        elsewhere.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ ok: true });
      },
    });
    try {
      const a = await startInstance();
      const b = await startInstance({ ...driftedSeed(), redirectWritesTo: `http://127.0.0.1:${redirectTarget.port}` });
      const { home, date } = await makeHome(a);

      const result = await runRestore({ home, date, env: { FLAIR_URL: b.httpUrl } });

      // B answered every write with a 307; nothing followed one.
      expect(elsewhere).toEqual([]);
      expect(result.fetches.some((f) => f.host === `127.0.0.1:${redirectTarget.port}`)).toBe(false);
      expect(b.requests().some((r) => r.endpoint === "http" && r.method === "PUT")).toBe(true);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("Status:       failed");
      expect(result.stdout).toContain("HTTP 307: the instance answered with a redirect, which this request does not follow");
      expect(a.requests()).toEqual([]);
    } finally {
      redirectTarget.stop(true);
    }
  }, 60_000);

  test("a FLAIR_URL whose operations URL cannot be derived refuses with zero requests sent", async () => {
    const a = await startInstance();
    const { home, date } = await makeHome(a);

    // Port 1 derives operations port 0, which is out of range.
    const result = await runRestore({ home, date, env: { FLAIR_URL: "http://127.0.0.1:1" } });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("restore target http://127.0.0.1:1 has no derivable operations API URL");
    expect(result.stderr).toContain("Set FLAIR_OPS_PORT");
    expect(result.fetches).toEqual([]);
    expect(a.requests()).toEqual([]);
  }, 60_000);
});

// ─── resolveRestoreTarget ───────────────────────────────────────────────────

type PairCall = { port?: string | number; opsPort?: string | number };

function recordingPair(calls: PairCall[]) {
  return (opts: PairCall) => {
    calls.push(opts);
    return { httpPort: Number(opts.port), opsPort: Number(opts.opsPort) };
  };
}

describe("flair#2708 — resolveRestoreTarget", () => {
  test("a portless http target with an explicit operations port builds the operations URL on the target host", () => {
    const calls: PairCall[] = [];
    const target = resolveRestoreTarget(
      { flairUrl: "http://flair.example", opsPort: "7000" },
      { resolvePair: recordingPair(calls), deriveOpsUrl: resolveOpsUrlFromTarget },
    );
    expect(target).toEqual({
      baseUrl: "http://flair.example",
      opsUrl: "http://flair.example:7000",
      httpPort: 80,
      opsPort: 7000,
      loopback: false,
    });
    // This host's configured pair says nothing about another host.
    expect(calls).toEqual([]);
  });

  test("a portless https target with an explicit operations port builds the operations URL on the target host", () => {
    const target = resolveRestoreTarget(
      { flairUrl: "https://flair.example/", opsPort: "8443" },
      { resolvePair: recordingPair([]), deriveOpsUrl: resolveOpsUrlFromTarget },
    );
    expect(target).toEqual({
      baseUrl: "https://flair.example",
      opsUrl: "https://flair.example:8443",
      httpPort: 443,
      opsPort: 8443,
      loopback: false,
    });
  });

  test("a portless https target without FLAIR_OPS_PORT uses the conventional operations port", () => {
    const target = resolveRestoreTarget(
      { flairUrl: "https://flair.example" },
      { resolvePair: recordingPair([]), deriveOpsUrl: resolveOpsUrlFromTarget },
    );
    expect(target.opsUrl).toBe("https://flair.example:9925");
    expect(target.httpPort).toBe(443);
  });

  test("a portless loopback target passes its effective HTTP port and the explicit operations port through the paired resolver", () => {
    const calls: PairCall[] = [];
    const target = resolveRestoreTarget(
      { flairUrl: "http://127.0.0.1", opsPort: "7000" },
      { resolvePair: recordingPair(calls), deriveOpsUrl: resolveOpsUrlFromTarget },
    );
    expect(calls).toEqual([{ port: 80, opsPort: 7000 }]);
    expect(target).toEqual({ baseUrl: "http://127.0.0.1", opsUrl: "http://127.0.0.1:7000", httpPort: 80, opsPort: 7000, loopback: true });
  });

  test("a loopback pair the paired resolver refuses is refused with restore's own remedy", () => {
    expect(() =>
      resolveRestoreTarget(
        { flairUrl: "http://127.0.0.1:19926", opsPort: "18000" },
        {
          resolvePair: () => {
            throw new Error("ambiguous_instance_target: the target conflicts with the configured pair.");
          },
          deriveOpsUrl: resolveOpsUrlFromTarget,
        },
      ),
    ).toThrow(/could not be paired with operations port 18000 \(FLAIR_OPS_PORT\).*Set FLAIR_OPS_PORT to the operations port of the instance serving HTTP port 19926/);
  });

  test("FLAIR_OPS_TARGET is checked, never used: the same root URL passes, any other endpoint refuses", () => {
    const deps = { resolvePair: recordingPair([]), deriveOpsUrl: resolveOpsUrlFromTarget };
    for (const opsTarget of ["https://flair.example:9925", "https://flair.example:9925/", "https://FLAIR.example:9925/"]) {
      const same = resolveRestoreTarget({ flairUrl: "https://flair.example:9926", opsTarget }, deps);
      expect(same.opsUrl).toBe("https://flair.example:9925");
    }
    // A default port written out or left implicit is the same root URL.
    expect(resolveRestoreTarget({ flairUrl: "https://flair.example:9926", opsPort: "443", opsTarget: "https://flair.example/" }, deps).opsUrl)
      .toBe("https://flair.example");
    for (const opsTarget of ["https://other.example:9925", "https://flair.example:9000", "http://flair.example:9925"]) {
      expect(() => resolveRestoreTarget({ flairUrl: "https://flair.example:9926", opsTarget }, deps)).toThrow(/FLAIR_OPS_TARGET names the operations endpoint/);
    }
    expect(() => resolveRestoreTarget({ flairUrl: "https://flair.example:9926", opsTarget: "not a url" }, deps)).toThrow(/FLAIR_OPS_TARGET is not an http\(s\) URL/);
  });

  test("a FLAIR_OPS_TARGET on the same scheme, host and port is refused when it carries user info, a query, a fragment or a path, without printing them", () => {
    const deps = { resolvePair: recordingPair([]), deriveOpsUrl: resolveOpsUrlFromTarget };
    const cases: Array<[string, string]> = [
      [`https://ops-user:${SECRET}@flair.example:9925`, "carries user info"],
      [`https://flair.example:9925/?token=${SECRET}`, "carries a query"],
      ["https://flair.example:9925/?", "carries a query"],
      [`https://flair.example:9925/#${SECRET}`, "carries a fragment"],
      [`https://flair.example:9925/${SECRET}`, "carries a path other than /"],
      [`https://ops-user:${SECRET}@flair.example:9925/other?token=${SECRET}`, "carries user info and a query and a path other than /"],
    ];
    for (const [opsTarget, carries] of cases) {
      let message = "";
      try {
        resolveRestoreTarget({ flairUrl: "https://flair.example:9926", opsTarget }, deps);
      } catch (err: any) {
        message = err.message;
      }
      expect(message).toContain(`FLAIR_OPS_TARGET https://flair.example:9925 ${carries}`);
      expect(message).toContain("Unset FLAIR_OPS_TARGET for this command, or set it to https://flair.example:9925.");
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("ops-user");
      expect(message).not.toContain("/other");
    }
  });

  test("a FLAIR_OPS_TARGET of only whitespace is set, not unset, and is refused; an empty one counts as unset", () => {
    const deps = { resolvePair: recordingPair([]), deriveOpsUrl: resolveOpsUrlFromTarget };
    for (const opsTarget of [" ", "   ", "\t", " \n "]) {
      expect(() => resolveRestoreTarget({ flairUrl: "https://flair.example:9926", opsTarget }, deps)).toThrow(
        "FLAIR_OPS_TARGET is set but holds only whitespace, so it names no operations endpoint to compare with the one restore lists candidates on (https://flair.example:9925); nothing was sent. Unset FLAIR_OPS_TARGET for this command, or set it to https://flair.example:9925.",
      );
    }
    expect(resolveRestoreTarget({ flairUrl: "https://flair.example:9926", opsTarget: "" }, deps).opsUrl).toBe("https://flair.example:9925");
  });

  test("the check is chosen by the URL: 127.0.0.1, localhost and [::1] are loopback URLs; a LAN address is not", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const calls: PairCall[] = [];
      const target = resolveRestoreTarget(
        { flairUrl: `http://${host}:19926` },
        { resolvePair: recordingPair(calls), deriveOpsUrl: resolveOpsUrlFromTarget },
      );
      expect(target.loopback).toBe(true);
      expect(target.opsUrl).toBe("http://127.0.0.1:19925");
      expect(calls).toEqual([{ port: 19926, opsPort: 19925 }]);
    }
    const calls: PairCall[] = [];
    const lan = resolveRestoreTarget(
      { flairUrl: "http://192.168.1.10:19926" },
      { resolvePair: recordingPair(calls), deriveOpsUrl: resolveOpsUrlFromTarget },
    );
    expect(lan).toEqual({ baseUrl: "http://192.168.1.10:19926", opsUrl: "http://192.168.1.10:19925", httpPort: 19926, opsPort: 19925, loopback: false });
    expect(calls).toEqual([]);
  });

  test("an invalid FLAIR_OPS_PORT and a non-http FLAIR_URL are refused without printing the URL", () => {
    const deps = { resolvePair: recordingPair([]), deriveOpsUrl: resolveOpsUrlFromTarget };
    expect(() => resolveRestoreTarget({ flairUrl: "https://flair.example", opsPort: "0" }, deps)).toThrow(/invalid FLAIR_OPS_PORT/);
    let message = "";
    try {
      resolveRestoreTarget({ flairUrl: `user:${SECRET}@flair.example` }, deps);
    } catch (err: any) {
      message = err.message;
    }
    expect(message).toContain("FLAIR_URL is not an http:// or https:// URL");
    expect(message).not.toContain(SECRET);
  });
});

// ─── establishRestorePair: a non-loopback target, against real local servers ─

/** How one endpoint answers its `flair.Instance` read. */
type IdentityAnswer =
  | { rows: unknown[] }
  | { status: number }
  | { redirect: 302 | 307 }
  | { body: string };

interface RecordedCall {
  method: string;
  path: string;
  operation?: string;
}

interface RemoteEndpoints {
  target: RestoreTarget;
  httpCalls: RecordedCall[];
  opsCalls: RecordedCall[];
  /** Requests that reached the redirect destination. */
  elsewhere: RecordedCall[];
  stop: () => void;
}

const instanceRow = (id: string) => ({ id, role: "hub", publicKey: "pk", status: "active", createdAt: "2026-01-01T00:00:00.000Z" });

function answer(a: IdentityAnswer, redirectTo: string): Response {
  if ("rows" in a) return Response.json(a.rows);
  if ("status" in a) return new Response("refused", { status: a.status });
  if ("redirect" in a) return new Response(null, { status: a.redirect, headers: { location: redirectTo } });
  return new Response(a.body, { headers: { "content-type": "application/json" } });
}

/**
 * Two real local HTTP servers acting as a non-loopback target's HTTP endpoint and
 * operations endpoint, plus a redirect destination that answers the identity
 * `destinationId` reports. The operations endpoint always reports, through
 * `get_configuration`, exactly the two ports the target names, so matching
 * port numbers are available to a check that would wrongly accept them.
 */
function startRemoteEndpoints(httpIdentity: IdentityAnswer, opsIdentity: IdentityAnswer, destinationId = "instance-1"): RemoteEndpoints {
  const httpCalls: RecordedCall[] = [];
  const opsCalls: RecordedCall[] = [];
  const elsewhere: RecordedCall[] = [];
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined;
      elsewhere.push({ method: req.method, path: new URL(req.url).pathname, operation: body?.operation });
      return Response.json([instanceRow(destinationId)]);
    },
  });
  const destinationUrl = `http://127.0.0.1:${destination.port}`;
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      httpCalls.push({ method: req.method, path });
      if (req.method === "GET" && path === "/Instance/") return answer(httpIdentity, `${destinationUrl}/Instance/`);
      return new Response("not found", { status: 404 });
    },
  });
  const ops = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const body = await req.json().catch(() => undefined);
      opsCalls.push({ method: req.method, path: new URL(req.url).pathname, operation: body?.operation });
      if (body?.operation === "get_configuration") {
        return Response.json({ http: { port: http.port }, operationsApi: { network: { port: ops.port } } });
      }
      if (body?.operation === "sql") return answer(opsIdentity, `${destinationUrl}/`);
      return Response.json([]);
    },
  });
  return {
    target: {
      baseUrl: `http://127.0.0.1:${http.port}`,
      opsUrl: `http://127.0.0.1:${ops.port}`,
      httpPort: http.port!,
      opsPort: ops.port!,
      loopback: false,
    },
    httpCalls,
    opsCalls,
    elsewhere,
    stop: () => {
      http.stop(true);
      ops.stop(true);
      destination.stop(true);
    },
  };
}

const ADMIN = { user: "admin", pass: "test-admin-pass" };

async function remoteCheck(httpIdentity: IdentityAnswer, opsIdentity: IdentityAnswer): Promise<{ error: string | null; endpoints: RemoteEndpoints }> {
  const endpoints = startRemoteEndpoints(httpIdentity, opsIdentity);
  try {
    await establishRestorePair(endpoints.target, ADMIN);
    return { error: null, endpoints };
  } catch (err: any) {
    return { error: String(err?.message ?? err), endpoints };
  } finally {
    endpoints.stop();
  }
}

/** No listing, delete or write reached either endpoint. */
function expectNoRestoreTraffic(endpoints: RemoteEndpoints): void {
  expect(endpoints.opsCalls.some((c) => c.operation === "search_by_conditions")).toBe(false);
  expect(endpoints.httpCalls.every((c) => c.method === "GET" && c.path === "/Instance/")).toBe(true);
}

describe("flair#2708 — establishRestorePair for a non-loopback target (real local servers)", () => {
  test("passes when both endpoints report the same single instance identity", async () => {
    const { error, endpoints } = await remoteCheck({ rows: [instanceRow("instance-1")] }, { rows: [instanceRow("instance-1")] });
    expect(error).toBeNull();
    expect(endpoints.httpCalls).toEqual([{ method: "GET", path: "/Instance/" }]);
    expect(endpoints.opsCalls).toEqual([{ method: "POST", path: "/", operation: "sql" }]);
    expect(endpoints.elsewhere).toEqual([]);
  });

  test("refuses two different instance identities", async () => {
    const { error, endpoints } = await remoteCheck({ rows: [instanceRow("instance-1")] }, { rows: [instanceRow("instance-2")] });
    expect(error).toContain("report different flair.Instance ids");
    expect(error).toContain("nothing was listed, deleted or written");
    expectNoRestoreTraffic(endpoints);
  });

  test("refuses when both identity reads are empty, though the configuration reports matching ports", async () => {
    const { error, endpoints } = await remoteCheck({ rows: [] }, { rows: [] });
    expect(error).toContain("the HTTP endpoint's GET /Instance/ reports no flair.Instance row");
    expect(error).toContain("the operations endpoint's Instance read reports no flair.Instance row");
    expect(error).toContain("restore requires both endpoints to report exactly one flair.Instance row with the same id");
    expect(error).toContain("flair federation status --target <its URL>");
    expectNoRestoreTraffic(endpoints);
  });

  test("refuses when one side's identity read is empty or unreadable", async () => {
    const one = { rows: [instanceRow("instance-1")] };
    const cases: Array<[IdentityAnswer, IdentityAnswer, string]> = [
      [{ rows: [] }, one, "the HTTP endpoint's GET /Instance/ reports no flair.Instance row"],
      [one, { rows: [] }, "the operations endpoint's Instance read reports no flair.Instance row"],
      [{ status: 500 }, one, "the HTTP endpoint's GET /Instance/ answered HTTP 500"],
      [one, { body: "not json" }, "the operations endpoint's Instance read answered a body that is not JSON"],
      [one, { body: JSON.stringify({ rows: "no" }) }, "the operations endpoint's Instance read answered a body that is not a row list"],
      [{ rows: [{ role: "hub" }] }, one, "the HTTP endpoint's GET /Instance/ answered a row without a usable id"],
      [one, { rows: [instanceRow("instance-1"), instanceRow("instance-3")] }, "the operations endpoint's Instance read reports 2 flair.Instance rows, not one"],
    ];
    for (const [httpIdentity, opsIdentity, detail] of cases) {
      const { error, endpoints } = await remoteCheck(httpIdentity, opsIdentity);
      expect(error).toContain(detail);
      expect(error).toContain("nothing was listed, deleted or written");
      expectNoRestoreTraffic(endpoints);
    }
  });

  test("a redirected identity read fails the check, and the redirect destination receives no request", async () => {
    const one = { rows: [instanceRow("instance-1")] };
    // The destination would answer the same identity as the other side, so
    // following the redirect, or skipping the redirected side, would pass.
    for (const [httpIdentity, opsIdentity, detail] of [
      [{ redirect: 302 }, one, "the HTTP endpoint's GET /Instance/ answered with a redirect (HTTP 302), which restore does not follow"],
      [{ redirect: 307 }, one, "the HTTP endpoint's GET /Instance/ answered with a redirect (HTTP 307), which restore does not follow"],
      [one, { redirect: 307 }, "the operations endpoint's Instance read answered with a redirect (HTTP 307), which restore does not follow"],
    ] as Array<[IdentityAnswer, IdentityAnswer, string]>) {
      const { error, endpoints } = await remoteCheck(httpIdentity, opsIdentity);
      expect(endpoints.elsewhere).toEqual([]);
      expect(error).toContain(detail);
      expectNoRestoreTraffic(endpoints);
    }
  });

  test("a refused admin credential names the credential remedy", async () => {
    const { error } = await remoteCheck({ status: 401 }, { rows: [instanceRow("instance-1")] });
    expect(error).toContain("answered HTTP 401");
    expect(error).toContain("Check that the admin credential restore uses");
  });
});

// ─── The REST transport's per-call redirect refusal ─────────────────────────

describe("flair#2708 — authedRequest refuseRedirects (real local servers)", () => {
  function redirectPair() {
    const reached: string[] = [];
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        reached.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ followed: true });
      },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${destination.port}${new URL(req.url).pathname}` } });
      },
    });
    return {
      baseUrl: `http://127.0.0.1:${source.port}`,
      reached,
      stop: () => {
        source.stop(true);
        destination.stop(true);
      },
    };
  }

  test("with refuseRedirects, a 307 is refused and its destination receives no request", async () => {
    const pair = redirectPair();
    try {
      let caught: unknown;
      try {
        await authedRequest("PUT", "/Memory/m1", { id: "m1" }, { baseUrl: pair.baseUrl, explicitAdminPass: "test-admin-pass", refuseRedirects: true });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiHttpError);
      expect((caught as ApiHttpError).status).toBe(307);
      expect(pair.reached).toEqual([]);
    } finally {
      pair.stop();
    }
  });

  test("without the option, a caller's request follows the redirect as before", async () => {
    const pair = redirectPair();
    try {
      const result = await authedRequest("PUT", "/Memory/m1", { id: "m1" }, { baseUrl: pair.baseUrl, explicitAdminPass: "test-admin-pass" });
      expect(result).toEqual({ followed: true });
      expect(pair.reached).toEqual(["PUT /Memory/m1"]);
    } finally {
      pair.stop();
    }
  });
});
