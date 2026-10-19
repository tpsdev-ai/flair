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
 * The pure tests cover the target resolver and the remote pair check with
 * injected seams.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSnapshot } from "../../src/rem/snapshot.ts";
import { establishRestorePair, resolveRestoreTarget, type RestoreTarget } from "../../src/commands/rem.ts";
import { resolveOpsUrlFromTarget } from "../../src/cli.ts";
import { startStubInstance, type StubInstance, type StubRequest } from "../helpers/rem-restore-stub-instance.ts";

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

async function startInstance(seed = driftedSeed()): Promise<StubInstance> {
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

  test("FLAIR_OPS_TARGET is checked, never used: the same endpoint passes, any other refuses", () => {
    const deps = { resolvePair: recordingPair([]), deriveOpsUrl: resolveOpsUrlFromTarget };
    const same = resolveRestoreTarget({ flairUrl: "https://flair.example:9926", opsTarget: "https://flair.example:9925/" }, deps);
    expect(same.opsUrl).toBe("https://flair.example:9925");
    for (const opsTarget of ["https://other.example:9925", "https://flair.example:9000", "http://flair.example:9925", "not a url"]) {
      expect(() => resolveRestoreTarget({ flairUrl: "https://flair.example:9926", opsTarget }, deps)).toThrow(/FLAIR_OPS_TARGET names the operations endpoint/);
    }
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

// ─── establishRestorePair: a remote target ──────────────────────────────────

interface SentRequest {
  url: string;
  method: string;
  redirect?: RequestRedirect;
  body?: any;
}

function remoteFetch(answers: { config: unknown; configStatus?: number; httpInstances?: unknown[]; opsInstances?: unknown[] }, sent: SentRequest[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ url, method: init?.method ?? "GET", redirect: init?.redirect, body });
    if (new URL(url).pathname === "/Instance/") return Response.json(answers.httpInstances ?? []);
    if (body?.operation === "get_configuration") {
      return answers.configStatus ? new Response("denied", { status: answers.configStatus }) : Response.json(answers.config);
    }
    if (body?.operation === "sql") return Response.json(answers.opsInstances ?? []);
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

const ADMIN = { user: "admin", pass: "test-admin-pass" };
const instanceRow = (id: string) => ({ id, role: "hub", publicKey: "pk", status: "active", createdAt: "2026-01-01T00:00:00.000Z" });

describe("flair#2708 — establishRestorePair (remote target)", () => {
  const portlessHttps: RestoreTarget = {
    baseUrl: "https://flair.example",
    opsUrl: "https://flair.example:8443",
    httpPort: 443,
    opsPort: 8443,
    loopback: false,
  };

  test("a portless https target with a custom operations port pairs when the configuration records both ports", async () => {
    const sent: SentRequest[] = [];
    await establishRestorePair(portlessHttps, ADMIN, {
      fetchImpl: remoteFetch({ config: { http: { securePort: 443 }, operationsApi: { network: { securePort: 8443 } } } }, sent),
    });
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(new URL(request.url).hostname).toBe("flair.example");
      expect(request.redirect).toBe("error");
    }
    expect(sent.some((r) => r.body?.operation === "search_by_conditions")).toBe(false);
  });

  test("a target behind a proxy pairs when both endpoints report the same single instance identity", async () => {
    await establishRestorePair(portlessHttps, ADMIN, {
      fetchImpl: remoteFetch(
        {
          config: { http: { port: 9926 }, operationsApi: { network: { port: 9925 } } },
          httpInstances: [instanceRow("instance-1")],
          opsInstances: [instanceRow("instance-1")],
        },
        [],
      ),
    });
  });

  test("ports the configuration does not record, with no instance identity to compare, are refused", async () => {
    await expect(
      establishRestorePair(portlessHttps, ADMIN, {
        fetchImpl: remoteFetch({ config: { http: { port: 9926 }, operationsApi: { network: { port: 9925 } } } }, []),
      }),
    ).rejects.toThrow(/records HTTP port 9926 and operations port 9925, not HTTP port 443 with operations port 8443.*nothing was listed, deleted or written/);
  });

  test("two different instance identities are refused even when the ports match", async () => {
    await expect(
      establishRestorePair(portlessHttps, ADMIN, {
        fetchImpl: remoteFetch(
          {
            config: { http: { securePort: 443 }, operationsApi: { network: { securePort: 8443 } } },
            httpInstances: [instanceRow("instance-1")],
            opsInstances: [instanceRow("instance-2")],
          },
          [],
        ),
      }),
    ).rejects.toThrow(/report different instance identities/);
  });

  test("a refused admin credential names the credential remedy", async () => {
    await expect(
      establishRestorePair(portlessHttps, ADMIN, { fetchImpl: remoteFetch({ config: {}, configStatus: 401 }, []) }),
    ).rejects.toThrow(/answered HTTP 401.*admin credential restore uses/);
  });
});
