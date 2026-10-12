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
 *     loopback or on all interfaces;
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
 * test/unit/agent-home-target-2474.test.ts); the configuration check is what
 * decides them.
 *
 * `proveLocalInstancePair` is exercised against a local HTTP server on an
 * OS-assigned loopback port that answers `get_configuration` with a fixed body.
 * The real two-instance seam, including that a refusal reports BOTH checks NOT
 * RUN and reads no Agent row, is
 * test/integration/doctor-roster-probed-instance-2483.test.ts.
 *
 * The file-reading cases use a NON-default data directory, so neither the
 * developer's nor the runner's `~/.flair` is read. `FLAIR_URL` and
 * `FLAIR_OPS_PORT` are cleared around each of them and restored afterwards.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import { proveLocalInstancePair } from "../../src/lib/local-instance-pair.js";

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

// ── The configuration check (shared with the local delete paths) ────────────

/** What the fixture server answers next: a status and a raw body. */
let answer: { status: number; body: string } = { status: 200, body: "{}" };
let lastOperation: unknown = null;
let server: Server;
let serverPort: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => { raw += d.toString(); });
    req.on("end", () => {
      try { lastOperation = JSON.parse(raw)?.operation; } catch { lastOperation = null; }
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Answer `get_configuration` with this configuration. */
function configure(config: unknown): void {
  answer = { status: 200, body: JSON.stringify(config) };
}

const AUTH = "Basic " + Buffer.from("admin:not-a-secret").toString("base64");

describe("proveLocalInstancePair — the ops endpoint's own configuration must pair it with an HTTP port configured to bind on loopback or all interfaces", () => {
  test("a configuration recording the asked ops port and a loopback HTTP port is proven, with that HTTP port", async () => {
    configure({ http: { port: "127.0.0.1:7926" }, operationsApi: { network: { port: `127.0.0.1:${serverPort}` } } });
    expect(await proveLocalInstancePair(serverPort, AUTH)).toEqual({ kind: "proven", httpPort: 7926 });
    expect(lastOperation).toBe("get_configuration");
  });

  test("a bare HTTP port and an all-interfaces bind are accepted", async () => {
    configure({ http: { port: 7926 }, operationsApi: { network: { port: serverPort } } });
    expect(await proveLocalInstancePair(serverPort, AUTH)).toEqual({ kind: "proven", httpPort: 7926 });
    configure({ http: { port: "0.0.0.0:7926" }, operationsApi: { network: { port: serverPort } } });
    expect(await proveLocalInstancePair(serverPort, AUTH)).toEqual({ kind: "proven", httpPort: 7926 });
  });

  test("a configuration recording a different ops port is unproven", async () => {
    configure({ http: { port: 7926 }, operationsApi: { network: { port: "127.0.0.1:7925" } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH);
    expect(proof).toEqual({ kind: "unproven", status: null, detail: `its configuration records ops port 7925, not ${serverPort}` });
  });

  test("an HTTP port bound to a specific non-loopback host is unproven", async () => {
    configure({ http: { port: "192.0.2.10:7926" }, operationsApi: { network: { port: serverPort } } });
    const proof = await proveLocalInstancePair(serverPort, AUTH);
    expect(proof.kind).toBe("unproven");
    if (proof.kind === "unproven") expect(proof.detail).toBe("its configuration binds HTTP to 192.0.2.10, not loopback or all interfaces");
  });

  test("a configuration with no usable HTTP port is unproven", async () => {
    configure({ http: {}, operationsApi: { network: { port: serverPort } } });
    expect((await proveLocalInstancePair(serverPort, AUTH)).kind).toBe("unproven");
  });

  test("a refused credential is unproven and carries the status", async () => {
    answer = { status: 401, body: JSON.stringify({ error: "Login failed" }) };
    expect(await proveLocalInstancePair(serverPort, AUTH)).toEqual({
      kind: "unproven",
      status: 401,
      detail: "the configuration request answered HTTP 401",
    });
  });

  test("an answer that is not JSON is unproven", async () => {
    answer = { status: 200, body: "not json" };
    expect((await proveLocalInstancePair(serverPort, AUTH)).kind).toBe("unproven");
  });

  test("an ops port with nothing listening is unproven", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await proveLocalInstancePair(deadPort, AUTH)).toEqual({
      kind: "unproven",
      status: null,
      detail: "the configuration request got no answer",
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
      reason: "the ops endpoint on port 8925 did not report a usable configured HTTP/ops pair (the configuration request got no answer), so this check cannot be established for the probed HTTP port 7926",
      remedy: DOCTOR_ROSTER_TARGET_REMEDY,
    });
  });

  test("a refused credential is NOT RUN with the credential remedy", () => {
    const decision = decideDoctorRosterPair(7925, 7926, { kind: "unproven", status: 401, detail: "the configuration request answered HTTP 401" });
    expect(decision.kind).toBe("not-run");
    if (decision.kind === "not-run") expect(decision.remedy).toBe(DOCTOR_ROSTER_CREDENTIAL_REMEDY);
  });
});

describe("decideDoctorRosterIdentity — the identity comparison added after the configuration check", () => {
  test("two different single Instance ids are NOT RUN", () => {
    const decision = decideDoctorRosterIdentity(7925, { kind: "different", httpId: "inst-a", opsId: "inst-b" });
    expect(decision.kind).toBe("not-run");
    if (decision.kind === "not-run") expect(decision.remedy).toBe(DOCTOR_ROSTER_TARGET_REMEDY);
  });

  test("equal ids run", () => {
    expect(decideDoctorRosterIdentity(7925, { kind: "same", id: "inst-a" })).toEqual({ kind: "run", opsPort: 7925 });
  });

  test("no Instance row on either side (a fresh install) leaves the configuration check's decision standing", () => {
    const pair = decideProbedPairIdentity({ kind: "none" }, { kind: "none" });
    expect(decideDoctorRosterIdentity(7925, pair)).toEqual({ kind: "run", opsPort: 7925 });
  });
});
