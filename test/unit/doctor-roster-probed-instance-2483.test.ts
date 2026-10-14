/**
 * doctor-roster-probed-instance-2483.test.ts — flair#2483, the decisions behind
 * which ops endpoint `flair doctor` reads the Agent roster and home rows from.
 *
 * `resolveDoctorRosterTarget` PICKS the candidate ops endpoint with the pairing
 * rule `flair agent stamp-home` uses (flair#2474/#2491, `resolveAgentHomeTarget`):
 * the local configured pair (the data directory's Harper config, or the
 * per-user config) guides which ops port pairs with the probed HTTP port. That
 * rule works from local config and named ports and DELIBERATELY trusts two
 * ports the caller names, so doctor then checks the candidate's own
 * configuration separately, before either read:
 *   - `proveLocalInstancePair` (src/lib/local-instance-pair.ts, shared with the
 *     local delete paths) asks the candidate ops endpoint for its configuration
 *     and requires it to record that ops port and an HTTP port bound on
 *     loopback or on all interfaces, with the OS listener table showing one
 *     process listening on both, with a recognized Harper command line and the
 *     same pid and start time on two reads;
 *   - `decideDoctorRosterPair` runs only when that configured HTTP port is the
 *     probed one — no Instance row is needed, so a fresh install runs;
 *   - `decideDoctorRosterIdentity`, applied after that, refuses only when both
 *     endpoints report one Instance id and the two differ.
 *
 * The picking outcomes pinned here:
 *   - the probed HTTP port matches the configured pair → candidate from the
 *     pair's ops port;
 *   - it conflicts with the pair, or exactly one port is named with no complete
 *     pair to take the other from → a refusal (NOT RUN), with doctor's remedy.
 * Two named ports are accepted by the pairing rule as given (pinned in
 * test/unit/agent-home-target-2474.test.ts); the pair check is what
 * decides them.
 *
 * `proveLocalInstancePair` is exercised against an in-process ops endpoint and
 * a child process holding the configured HTTP port, which records every
 * request it receives: a mismatched pair read from the REAL listener table must
 * be refused without a single request (so no Authorization header) reaching
 * that port. Listener tables the host cannot produce are injected. The
 * real-Harper seam, including a stale configuration with a live, wrong PID
 * file and a refusal reporting BOTH checks NOT RUN with no Agent row read, is
 * test/integration/doctor-roster-probed-instance-2483.test.ts.
 *
 * The file-reading cases use a NON-default data directory, so neither the
 * developer's nor the runner's `~/.flair` is read. `FLAIR_URL` and
 * `FLAIR_OPS_PORT` are cleared around each of them and restored afterwards.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCTOR_ROSTER_CREDENTIAL_REMEDY,
  DOCTOR_ROSTER_TARGET_REMEDY,
  decideDoctorRosterIdentity,
  decideDoctorRosterPair,
  resolveDoctorRosterTarget,
} from "../../src/cli.js";
import { decideProbedPairIdentity } from "../../src/lib/agent-home.js";
import { proveLocalInstancePair, type LocalInstancePairDeps } from "../../src/lib/local-instance-pair.js";
import { LISTENER_VISIBILITY_REMEDY, readProcessBirth, readTcpListenerPids, type BirthRead, type ListenerRead } from "../../src/lib/listener-table.js";

const COMPLETE_PAIR = "http:\n  port: 7926\noperationsApi:\n  network:\n    port: 7925\n";
const HTTP_ONLY = "http:\n  port: 7926\n";

let dataDir: string;
let saved: { FLAIR_URL?: string; FLAIR_OPS_PORT?: string };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "flair-2483-doctor-target-"));
  saved = { FLAIR_URL: process.env.FLAIR_URL, FLAIR_OPS_PORT: process.env.FLAIR_OPS_PORT };
  delete process.env.FLAIR_URL;
  delete process.env.FLAIR_OPS_PORT;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("resolveDoctorRosterTarget — the probed HTTP port matches the configured pair: the pair's ops port is the candidate", () => {
  test("a probed HTTP port that matches the pair yields the pair's ops port", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), COMPLETE_PAIR);
    expect(resolveDoctorRosterTarget({ dataDir, port: "7926" })).toEqual({ kind: "run", opsPort: 7925 });
  });

  test("nothing named, with a complete pair, yields the pair's ops port", () => {
    // resolveHttpPort(opts) lands on the configured HTTP port, and the pair
    // supplies the matching ops port.
    writeFileSync(join(dataDir, "harper-config.yaml"), COMPLETE_PAIR);
    expect(resolveDoctorRosterTarget({ dataDir })).toEqual({ kind: "run", opsPort: 7925 });
  });
});

describe("resolveDoctorRosterTarget — a probed HTTP port that conflicts with the configured pair: refused", () => {
  test("the conflict is refused, naming the reason and doctor's remedy, and does not pick the other instance", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), COMPLETE_PAIR);
    const decision = resolveDoctorRosterTarget({ dataDir, port: "8926" });
    expect(decision.kind).toBe("not-run");
    if (decision.kind !== "not-run") return;
    expect(decision.reason).toContain("conflicts with the configured pair");
    // The stamp-home-shaped remedy in the resolver's message is dropped; doctor
    // has no --ops-port flag, so its own remedy is the one shown.
    expect(decision.reason).not.toContain("--ops-port");
    expect(decision.remedy).toBe(DOCTOR_ROSTER_TARGET_REMEDY);
  });
});

describe("resolveDoctorRosterTarget — one port named with no complete pair to complete it: refused", () => {
  test("only the HTTP port is configured; a probed HTTP port alone cannot establish the ops port", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), HTTP_ONLY);
    const decision = resolveDoctorRosterTarget({ dataDir, port: "7926" });
    expect(decision.kind).toBe("not-run");
    if (decision.kind !== "not-run") return;
    expect(decision.remedy).toBe(DOCTOR_ROSTER_TARGET_REMEDY);
  });

  test("only the ops port is configured; the probed HTTP port cannot be taken from a pair", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), "operationsApi:\n  network:\n    port: 7925\n");
    expect(resolveDoctorRosterTarget({ dataDir, port: "7926" }).kind).toBe("not-run");
  });

  test("the config cannot be read, so no pair is resolved", () => {
    mkdirSync(join(dataDir, "harper-config.yaml"));
    expect(resolveDoctorRosterTarget({ dataDir, port: "7926" }).kind).toBe("not-run");
  });
});

describe("decideProbedPairIdentity — the identities the probed HTTP port and the ops endpoint report", () => {
  test("two single, equal identities decide same", () => {
    expect(decideProbedPairIdentity({ kind: "one", id: "inst-a" }, { kind: "one", id: "inst-a" }))
      .toEqual({ kind: "same", id: "inst-a" });
  });

  test("two single, different identities are different instances", () => {
    expect(decideProbedPairIdentity({ kind: "one", id: "inst-a" }, { kind: "one", id: "inst-b" }))
      .toEqual({ kind: "different", httpId: "inst-a", opsId: "inst-b" });
  });

  test("a side with no single identity is unestablished, naming both sides", () => {
    expect(decideProbedPairIdentity({ kind: "none" }, { kind: "one", id: "inst-b" })).toEqual({
      kind: "unestablished",
      detail: "the probed HTTP port reports no instance identity, the ops endpoint reports one instance identity",
    });
    expect(decideProbedPairIdentity({ kind: "one", id: "inst-a" }, { kind: "multiple", count: 2 }).kind).toBe("unestablished");
    expect(decideProbedPairIdentity({ kind: "unreadable" }, { kind: "unreadable" }).kind).toBe("unestablished");
  });
});

// ── The pair check (shared with the local delete paths) ───────────────
//
// An in-process fixture stands in for the ops endpoint: it answers
// `get_configuration` with whatever `answer` holds and, as a real Harper does,
// `system_information` with a process id (the check must not ask). The HTTP
// port the configuration names is served by a CHILD process that records every
// request it receives, headers included, so a test can assert that nothing —
// above all no Authorization header — ever reaches it. Cases that need a
// listener table the host cannot produce (one process on both ports, several
// listeners, a forwarder, an unreadable table, a process replaced between
// reads) inject it through `osReads`; the
// rest read the REAL table (`/proc` on Linux, `lsof` elsewhere).

/** What the ops fixture answers `get_configuration` with next: a status and a raw body. */
let answer: { status: number; body: string } = { status: 200, body: "{}" };
/** Every ops operation the fixture saw, in order. */
let operations: string[] = [];
let server: Server;
let serverPort: number;
/** The child process serving the configured HTTP port. */
let capture: HeaderCapture;

interface HeaderCapture {
  port: number;
  pid: number;
  /** Every request the child received: its URL and headers. */
  requests: () => Array<{ url: string; headers: Record<string, string> }>;
  stop: () => Promise<void>;
}

/** Start a child process that listens on a loopback port and records each request's headers. */
async function startHeaderCapture(): Promise<HeaderCapture> {
  const script = `
    const http = require("node:http");
    const srv = http.createServer((req, res) => {
      process.stdout.write(JSON.stringify({ url: req.url, headers: req.headers }) + "\\n");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pid: process.pid }));
    });
    srv.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ listening: srv.address().port }) + "\\n"));
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const lines: string[] = [];
  let buffered = "";
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`header-capture child exited ${code} before listening`)));
    child.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        const parsed = JSON.parse(line);
        if (typeof parsed.listening === "number") resolve(parsed.listening);
        else lines.push(line);
      }
    });
  });
  child.removeAllListeners("exit");
  return {
    port,
    pid: child.pid!,
    requests: () => lines.map((l) => JSON.parse(l)),
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    }),
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => { raw += d.toString(); });
    req.on("end", () => {
      let operation: string | null = null;
      try { operation = JSON.parse(raw)?.operation ?? null; } catch { operation = null; }
      if (operation !== null) operations.push(operation);
      if (operation === "system_information") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ harperdb_processes: { core: [{ pid: process.pid }] } }));
        return;
      }
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as AddressInfo).port;
  capture = await startHeaderCapture();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await capture?.stop();
});

beforeEach(() => {
  answer = { status: 200, body: "{}" };
  operations = [];
});

/** Answer `get_configuration` with this configuration. */
function configure(config: unknown): void {
  answer = { status: 200, body: JSON.stringify(config) };
}

const AUTH = "Basic " + Buffer.from("admin:not-a-secret").toString("base64");
const HARPER_CMDLINE = "node\u0000/opt/flair/node_modules/@harperfast/harper/dist/bin/harper.js\u0000run\u0000.\u0000";
const ONE_HARPER = 4242;

/** A birth identity that never changes: every pid started at "t0". */
const STABLE_BIRTH = (pid: number): BirthRead => ({ kind: "birth", id: `${pid}@t0` });

/** OS reads in which these ports have these listeners and every pid runs `cmdline`. */
function osReads(listeners: Record<number, ListenerRead>, cmdline: string | null = HARPER_CMDLINE): LocalInstancePairDeps {
  return {
    osReads: {
      listeners: (port) => listeners[port] ?? { kind: "listeners", pids: [] },
      birth: STABLE_BIRTH,
      commandLine: () => cmdline,
    },
  };
}

/** One Harper process listening on the fixture ops port and the capture child's port. */
const oneHarperOnBoth = (): LocalInstancePairDeps =>
  osReads({ [serverPort]: { kind: "listeners", pids: [ONE_HARPER] }, [capture.port]: { kind: "listeners", pids: [ONE_HARPER] } });

/** A free loopback port that nothing is listening on (for the dead-HTTP-port case). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe("proveLocalInstancePair — the configuration must pair the ops port with a loopback HTTP port", () => {
  test("a configuration recording the asked ops port and a loopback HTTP port, with one process with a recognized Harper command line listening on both, is proven", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: `127.0.0.1:${serverPort}` } } });
    expect(await proveLocalInstancePair(serverPort, AUTH, oneHarperOnBoth())).toEqual({ kind: "proven", httpPort: capture.port });
    // Only the configuration is asked for; no process id an endpoint reports is evidence.
    expect(operations).toEqual(["get_configuration"]);
  });

  test("a bare HTTP port and an all-interfaces bind are accepted", async () => {
    configure({ http: { port: capture.port }, operationsApi: { network: { port: serverPort } } });
    expect(await proveLocalInstancePair(serverPort, AUTH, oneHarperOnBoth())).toEqual({ kind: "proven", httpPort: capture.port });
    configure({ http: { port: `0.0.0.0:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    expect(await proveLocalInstancePair(serverPort, AUTH, oneHarperOnBoth())).toEqual({ kind: "proven", httpPort: capture.port });
  });

  test("a configuration recording a different ops port is unproven", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: "127.0.0.1:7925" } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH, oneHarperOnBoth());
    expect(proof).toEqual({ kind: "unproven", status: null, detail: `its configuration records ops port 7925, not ${serverPort}` });
  });

  test("an HTTP port bound to a specific non-loopback host is unproven", async () => {
    configure({ http: { port: "192.0.2.10:7926" }, operationsApi: { network: { port: serverPort } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH, oneHarperOnBoth());
    expect(proof.kind).toBe("unproven");
    if (proof.kind === "unproven") expect(proof.detail).toBe("its configuration binds HTTP to 192.0.2.10, not loopback or all interfaces");
  });

  test("a configuration with no usable HTTP port is unproven", async () => {
    configure({ http: {}, operationsApi: { network: { port: serverPort } } });
    expect((await proveLocalInstancePair(serverPort, AUTH, oneHarperOnBoth())).kind).toBe("unproven");
  });

  test("a refused credential is unproven and carries the status", async () => {
    answer = { status: 401, body: JSON.stringify({ error: "Login failed" }) };
    expect(await proveLocalInstancePair(serverPort, AUTH, oneHarperOnBoth())).toEqual({
      kind: "unproven",
      status: 401,
      detail: "the configuration request answered HTTP 401",
    });
  });

  test("an answer that is not JSON is unproven", async () => {
    answer = { status: 200, body: "not json" };
    expect((await proveLocalInstancePair(serverPort, AUTH, oneHarperOnBoth())).kind).toBe("unproven");
  });

  test("an ops port with nothing listening is unproven", async () => {
    const deadPort = await freePort();
    expect(await proveLocalInstancePair(deadPort, AUTH)).toEqual({
      kind: "unproven",
      status: null,
      detail: "the configuration request got no answer",
    });
  });
});

describe("proveLocalInstancePair — the OS listener table must show one process with a recognized Harper command line on both ports (flair#2526)", () => {
  test("a configuration naming another process's HTTP port (REAL listener table): unproven, and no request — so no credential — ever reaches that port", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const before = capture.requests().length;
    // The REAL table names this test process on the ops port and the child on
    // the HTTP port; only the command lines are simulated as Harper's.
    const proof = await proveLocalInstancePair(serverPort, AUTH, { osReads: { commandLine: () => HARPER_CMDLINE } });
    const reached = capture.requests().slice(before);
    expect(reached.filter((r) => "authorization" in r.headers), "the admin credential reached the mismatched port").toEqual([]);
    expect(reached, "the pair check sent a request to the mismatched port").toEqual([]);
    expect(proof).toEqual({
      kind: "unproven",
      status: null,
      detail: `the process listening on ops port ${serverPort} is ${process.pid} and the process listening on HTTP port ${capture.port} is ${capture.pid}, so they are not the same running instance`,
    });
  });

  test("a proven pair sends nothing to the HTTP port either", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const before = capture.requests().length;
    expect((await proveLocalInstancePair(serverPort, AUTH, oneHarperOnBoth())).kind).toBe("proven");
    expect(capture.requests().slice(before)).toEqual([]);
  });

  test("two different listeners are unproven, naming both pids", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH, osReads({
      [serverPort]: { kind: "listeners", pids: [1001] },
      [capture.port]: { kind: "listeners", pids: [2002] },
    }));
    expect(proof).toEqual({
      kind: "unproven",
      status: null,
      detail: `the process listening on ops port ${serverPort} is 1001 and the process listening on HTTP port ${capture.port} is 2002, so they are not the same running instance`,
    });
  });

  test("several processes listening on the ops port, or on the HTTP port, are unproven", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const opsShared = await proveLocalInstancePair(serverPort, AUTH, osReads({
      [serverPort]: { kind: "listeners", pids: [ONE_HARPER, 5005] },
      [capture.port]: { kind: "listeners", pids: [ONE_HARPER] },
    }));
    expect(opsShared).toEqual({
      kind: "unproven",
      status: null,
      detail: `processes ${ONE_HARPER}, 5005 all listen on ops port ${serverPort}, so the one serving it cannot be named`,
      remedy: `Stop every listener on ops port ${serverPort} but Harper's own, then re-run this command.`,
    });
    const httpShared = await proveLocalInstancePair(serverPort, AUTH, osReads({
      [serverPort]: { kind: "listeners", pids: [ONE_HARPER] },
      [capture.port]: { kind: "listeners", pids: [ONE_HARPER, 5005] },
    }));
    expect(httpShared.kind === "unproven" && httpShared.detail).toBe(`processes ${ONE_HARPER}, 5005 all listen on HTTP port ${capture.port}, so the one serving it cannot be named`);
    expect(httpShared.kind === "unproven" && httpShared.remedy).toBe(`Stop every listener on HTTP port ${capture.port} but Harper's own, then re-run this command.`);
  });

  test("a configured HTTP port nothing listens on (REAL listener table) is unproven, with a remedy", async () => {
    const dead = await freePort();
    configure({ http: { port: `127.0.0.1:${dead}` }, operationsApi: { network: { port: serverPort } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH, {
      osReads: {
        commandLine: () => HARPER_CMDLINE,
        birth: STABLE_BIRTH,
        listeners: (port) => (port === serverPort ? { kind: "listeners", pids: [ONE_HARPER] } : readTcpListenerPids(port)),
      },
    });
    expect(proof.kind).toBe("unproven");
    if (proof.kind !== "unproven") return;
    expect(proof.detail).toBe(`the listener table shows no process this CLI can see listening on HTTP port ${dead}`);
    expect(proof.remedy).toContain(`Start the instance that should serve HTTP port ${dead}`);
  });

  test("an ops port the listener table does not show this CLI is unproven", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH, osReads({ [capture.port]: { kind: "listeners", pids: [ONE_HARPER] } }));
    expect(proof).toEqual({
      kind: "unproven",
      status: null,
      detail: `the listener table shows no process this CLI can see listening on ops port ${serverPort}`,
      remedy: LISTENER_VISIBILITY_REMEDY,
    });
  });

  test("an unreadable listener table (lsof missing) is refused by name, with its remedy", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const noLsof = (port: number) => readTcpListenerPids(port, {
      platform: "darwin",
      runLsof: () => { throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }); },
    });
    const proof = await proveLocalInstancePair(serverPort, AUTH, { osReads: { listeners: noLsof, birth: STABLE_BIRTH, commandLine: () => HARPER_CMDLINE } });
    expect(proof).toEqual({
      kind: "unproven",
      status: null,
      detail: `the listener table for ops port ${serverPort} cannot be read: lsof is not installed or not on PATH, and this check reads the listener table with \`lsof -nP -iTCP:${serverPort} -sTCP:LISTEN -Fp\``,
      remedy: "Install lsof or put it on PATH (macOS ships it as /usr/sbin/lsof), then re-run this command on the host where Harper runs.",
    });
  });

  test("one process on both ports that is not Harper (one ssh -L holding both) is unproven, naming only its program", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const forwarder = { [serverPort]: { kind: "listeners", pids: [7007] }, [capture.port]: { kind: "listeners", pids: [7007] } } as Record<number, ListenerRead>;
    const proof = await proveLocalInstancePair(serverPort, AUTH, osReads(forwarder, "/usr/bin/ssh -N -L 9926:hostA:9926 -L 9925:hostB:9925 -i /home/me/.ssh/key"));
    expect(proof).toEqual({
      kind: "unproven",
      status: null,
      detail: `process 7007 (ssh), listening on ops port ${serverPort}, does not have a recognized Harper command line, as when a port forwarder (docker-proxy, ssh -L) holds that port`,
      remedy: LISTENER_VISIBILITY_REMEDY,
    });
  });

  test("a forwarder holding only the HTTP port (docker-proxy) is unproven, naming that port", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH, {
      osReads: {
        listeners: (port) => ({ kind: "listeners", pids: [port === serverPort ? ONE_HARPER : 8008] }),
        birth: STABLE_BIRTH,
        commandLine: (pid) => (pid === ONE_HARPER ? HARPER_CMDLINE : "/usr/bin/docker-proxy -proto tcp -host-port 9926"),
      },
    });
    expect(proof.kind === "unproven" && proof.detail).toBe(
      `process 8008 (docker-proxy), listening on HTTP port ${capture.port}, does not have a recognized Harper command line, as when a port forwarder (docker-proxy, ssh -L) holds that port`,
    );
  });

  test("a listener whose command line cannot be read is unproven", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const both = { [serverPort]: { kind: "listeners", pids: [ONE_HARPER] }, [capture.port]: { kind: "listeners", pids: [ONE_HARPER] } } as Record<number, ListenerRead>;
    const proof = await proveLocalInstancePair(serverPort, AUTH, osReads(both, null));
    expect(proof.kind === "unproven" && proof.detail).toBe(`the command line of process ${ONE_HARPER}, listening on ops port ${serverPort}, cannot be read`);
  });
});

describe("proveLocalInstancePair — each listener is bound to its birth identity and read twice (flair#2526)", () => {
  /** One Harper pid on both ports whose start time is `births[n]` on the n-th birth read. */
  function replacedAfter(reads: number): { deps: LocalInstancePairDeps; birthReads: () => number } {
    let n = 0;
    return {
      deps: {
        osReads: {
          listeners: () => ({ kind: "listeners", pids: [ONE_HARPER] }),
          birth: (pid) => ({ kind: "birth", id: `${pid}@${n++ < reads ? "t0" : "t1"}` }),
          commandLine: () => HARPER_CMDLINE,
        },
      },
      birthReads: () => n,
    };
  }

  test("a listener that keeps its pid and start time across both reads is proven, after four birth reads", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const run = replacedAfter(Number.POSITIVE_INFINITY);
    expect(await proveLocalInstancePair(serverPort, AUTH, run.deps)).toEqual({ kind: "proven", httpPort: capture.port });
    expect(run.birthReads()).toBe(4);
  });

  test("the process is replaced under the same pid after the command-line check: unproven, naming both births", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH, replacedAfter(2).deps);
    expect(proof).toEqual({
      kind: "unproven",
      status: null,
      detail: `the process listening on ops port ${serverPort} changed between two reads (${ONE_HARPER}@t0, then ${ONE_HARPER}@t1), so it is not proven to be the process whose command line was checked`,
      remedy: "Re-run this command once the instance is running and not restarting.",
    });
  });

  test("only the HTTP-side process is replaced: unproven, naming the HTTP port", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH, replacedAfter(3).deps);
    expect(proof.kind === "unproven" && proof.detail).toStartWith(`the process listening on HTTP port ${capture.port} changed between two reads`);
  });

  test("a different pid holds the port on the second read: unproven", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    let listenerReads = 0;
    const proof = await proveLocalInstancePair(serverPort, AUTH, {
      osReads: {
        listeners: () => ({ kind: "listeners", pids: [listenerReads++ < 2 ? ONE_HARPER : 5151] }),
        birth: STABLE_BIRTH,
        commandLine: () => HARPER_CMDLINE,
      },
    });
    expect(proof.kind === "unproven" && proof.detail).toBe(
      `the process listening on ops port ${serverPort} changed between two reads (${ONE_HARPER}@t0, then 5151@t0), so it is not proven to be the process whose command line was checked`,
    );
  });

  test("a listener whose start time cannot be read is unproven by name, never proven", async () => {
    configure({ http: { port: `127.0.0.1:${capture.port}` }, operationsApi: { network: { port: serverPort } } });
    const noPs = (pid: number) => readProcessBirth(pid, { platform: "darwin", runPs: () => { throw Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" }); } });
    const proof = await proveLocalInstancePair(serverPort, AUTH, {
      osReads: { listeners: () => ({ kind: "listeners", pids: [ONE_HARPER] }), birth: noPs, commandLine: () => HARPER_CMDLINE },
    });
    expect(proof).toEqual({
      kind: "unproven",
      status: null,
      detail: `the process listening on ops port ${serverPort} has no readable birth identity: ps is not installed or not on PATH, and this check reads a process's start time with \`ps -o lstart= -p ${ONE_HARPER}\``,
      remedy: "Put ps on PATH (macOS ships it as /bin/ps), then re-run this command.",
    });
  });
});

describe("decideDoctorRosterPair — run only when the ops endpoint's configured HTTP port is the probed port", () => {
  test("a proven pair naming the probed HTTP port runs on that ops port", () => {
    expect(decideDoctorRosterPair(7925, 7926, { kind: "proven", httpPort: 7926 })).toEqual({ kind: "run", opsPort: 7925 });
  });

  test("a proven pair naming another HTTP port is NOT RUN, naming both ports", () => {
    const decision = decideDoctorRosterPair(8925, 7926, { kind: "proven", httpPort: 8926 });
    expect(decision).toEqual({
      kind: "not-run",
      reason: "the configured HTTP/ops pair does not match: the ops endpoint on port 8925 is configured with HTTP port 8926, not the probed HTTP port 7926, so this check cannot be established",
      remedy: DOCTOR_ROSTER_TARGET_REMEDY,
    });
  });

  test("a check that could not complete is NOT RUN with the target remedy", () => {
    const decision = decideDoctorRosterPair(8925, 7926, { kind: "unproven", status: null, detail: "the configuration request got no answer" });
    expect(decision).toEqual({
      kind: "not-run",
      reason: "the ops endpoint on port 8925 did not prove a live HTTP/ops pair (the configuration request got no answer), so this check cannot be established for the probed HTTP port 7926",
      remedy: DOCTOR_ROSTER_TARGET_REMEDY,
    });
  });

  test("an unproven pair carrying its own remedy is NOT RUN with that remedy", () => {
    const decision = decideDoctorRosterPair(8925, 7926, { kind: "unproven", status: null, detail: "the listener table for ops port 8925 cannot be read: x", remedy: "Install lsof." });
    expect(decision.kind === "not-run" && decision.remedy).toBe("Install lsof.");
  });

  test("a refused credential is NOT RUN with the credential remedy", () => {
    const decision = decideDoctorRosterPair(7925, 7926, { kind: "unproven", status: 401, detail: "the configuration request answered HTTP 401" });
    expect(decision.kind).toBe("not-run");
    if (decision.kind === "not-run") expect(decision.remedy).toBe(DOCTOR_ROSTER_CREDENTIAL_REMEDY);
  });
});

describe("decideDoctorRosterIdentity — the identity comparison applied after the pair check", () => {
  test("two different single Instance ids are NOT RUN", () => {
    const decision = decideDoctorRosterIdentity(7925, { kind: "different", httpId: "inst-a", opsId: "inst-b" });
    expect(decision.kind).toBe("not-run");
    if (decision.kind === "not-run") expect(decision.remedy).toBe(DOCTOR_ROSTER_TARGET_REMEDY);
  });

  test("equal ids run", () => {
    expect(decideDoctorRosterIdentity(7925, { kind: "same", id: "inst-a" })).toEqual({ kind: "run", opsPort: 7925 });
  });

  test("no Instance row on either side (a fresh install) leaves the pair check's decision standing", () => {
    const pair = decideProbedPairIdentity({ kind: "none" }, { kind: "none" });
    expect(decideDoctorRosterIdentity(7925, pair)).toEqual({ kind: "run", opsPort: 7925 });
  });
});
