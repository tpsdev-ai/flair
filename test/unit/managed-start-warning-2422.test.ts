// flair#2422 — the managed-start warning reports what the confirmation probe saw.
//
// When a CLI-managed launchd start is not confirmed, the warning used to say
// "Flair is running on port <port>" whatever the confirmation probe saw, and
// the probe can get a response that is not a Flair health answer, get a
// refused connection, or fail to reach the port. The warning now names the
// reachability wait that passed, the probe's result, and the failed check.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSidecar, recordManagedStartSidecar } from "../../src/cli.ts";
import { managedStartUnconfirmedLines } from "../../src/commands/service.ts";
import { renderManagedStartUnconfirmed } from "../../src/lib/launchd-management.ts";

const PORT = 19927;
const LABEL = "ai.tpsdev.flair.00002422";

function detailFor(kind: string): string {
  return `the instance for launchd job ${LABEL} did not return Flair health (${kind}), so its identity sidecar was not written`;
}

describe("flair#2422 — renderManagedStartUnconfirmed names what was observed", () => {
  test("a Flair-shaped answer: Flair is running, not launchd-managed", () => {
    const detail = `the process answering on port ${PORT} is 5252, not launchd's process 4242 for job ${LABEL}, so its identity sidecar was not written`;
    expect(
      renderManagedStartUnconfirmed({ port: PORT, confirmation: "flair", detail, remedy: ["flair doctor --fix"] }),
    ).toEqual([
      `⚠️  Flair is running on port ${PORT}, but it is NOT verified as launchd-managed`,
      `   ${detail}`,
      `   Fix: flair doctor --fix`,
    ]);
  });

  test("a response that was not a Flair health answer", () => {
    const lines = renderManagedStartUnconfirmed({ port: PORT, confirmation: "foreign", detail: detailFor("foreign") });
    expect(lines).toEqual([
      `⚠️  The initial reachability wait on port ${PORT} passed, but the confirmation probe got a response that was not a Flair health answer (non-2xx or not Flair-shaped), so Flair is NOT verified as launchd-managed`,
      `   ${detailFor("foreign")}`,
    ]);
    expect(lines[0]).not.toContain("Flair is running");
  });

  test("a refused connection", () => {
    const lines = renderManagedStartUnconfirmed({ port: PORT, confirmation: "refused", detail: detailFor("refused") });
    expect(lines).toEqual([
      `⚠️  The initial reachability wait on port ${PORT} passed, but the confirmation probe's connection was refused (nothing was listening), so Flair is NOT verified as launchd-managed`,
      `   ${detailFor("refused")}`,
    ]);
    expect(lines[0]).not.toContain("Flair is running");
  });

  test("the port could not be reached", () => {
    const lines = renderManagedStartUnconfirmed({ port: PORT, confirmation: "unreachable", detail: detailFor("unreachable") });
    expect(lines).toEqual([
      `⚠️  The initial reachability wait on port ${PORT} passed, but the confirmation probe could not reach the port (timeout or network error), so Flair is NOT verified as launchd-managed`,
      `   ${detailFor("unreachable")}`,
    ]);
    expect(lines[0]).not.toContain("Flair is running");
  });

  test("the legacy-migration line, the launchd observer's detail and the remedy follow the detail", () => {
    const lines = renderManagedStartUnconfirmed({
      port: PORT,
      confirmation: "flair",
      detail: "launchd did not report a running pid, so its identity sidecar was not written",
      moved: `The launchd service was moved off the legacy label (ai.tpsdev.flair.legacy) → ${LABEL}.`,
      launchdDetail: `the launchd job ${LABEL} is loaded but not running`,
      remedy: ["flair restart", "launchctl bootstrap gui/501"],
    });
    expect(lines).toEqual([
      `⚠️  Flair is running on port ${PORT}, but it is NOT verified as launchd-managed`,
      "   launchd did not report a running pid, so its identity sidecar was not written",
      `   The launchd service was moved off the legacy label (ai.tpsdev.flair.legacy) → ${LABEL}.`,
      `   the launchd job ${LABEL} is loaded but not running`,
      "   Fix: flair restart && launchctl bootstrap gui/501",
    ]);
  });
});

describe("flair#2422 — recordManagedStartSidecar names the confirmation probe's result", () => {
  const dirs: string[] = [];
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "flair2422-warning-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const listRunning = () => ({ code: 0, stdout: `"Label" = "${LABEL}";\n"PID" = 4242;\n"LastExitStatus" = 0;\n` });
  const healthAnswers = async () => {};

  test("the probe's Flair-shaped answer, with launchd not owning the port -> `flair`", async () => {
    const outcome = await recordManagedStartSidecar(fixture(), PORT, LABEL, {
      list: listRunning,
      waitForHealth: healthAnswers,
      probeHealth: async () => ({ kind: "ok" }),
      servingPid: () => 9999,
      warn: () => {},
    });
    expect(outcome).toMatchObject({ recorded: false, confirmation: "flair" });
  });

  test("the probe's foreign answer -> `foreign`", async () => {
    const outcome = await recordManagedStartSidecar(fixture(), PORT, LABEL, {
      list: listRunning,
      waitForHealth: healthAnswers,
      probeHealth: async () => ({ kind: "foreign" }),
      servingPid: () => 4242,
      warn: () => {},
    });
    expect(outcome).toMatchObject({ recorded: false, confirmation: "foreign" });
  });

  test("the probe's refused answer -> `refused`", async () => {
    const outcome = await recordManagedStartSidecar(fixture(), PORT, LABEL, {
      list: listRunning,
      waitForHealth: healthAnswers,
      probeHealth: async () => ({ kind: "refused" }),
      servingPid: () => 4242,
      warn: () => {},
    });
    expect(outcome).toMatchObject({ recorded: false, confirmation: "refused" });
  });

  test("the probe's unreachable answer -> `unreachable`", async () => {
    const outcome = await recordManagedStartSidecar(fixture(), PORT, LABEL, {
      list: listRunning,
      waitForHealth: healthAnswers,
      probeHealth: async () => ({ kind: "unreachable" }),
      servingPid: () => 4242,
      warn: () => {},
    });
    expect(outcome).toMatchObject({ recorded: false, confirmation: "unreachable" });
  });
});

describe("flair#2422 — `flair start` forwards the sidecar outcome and the observer's detail to the warning", () => {
  const managed = {
    detail: `the launchd job ${LABEL} is loaded but not running, so whatever is serving this instance was not started by launchd.`,
    remedy: ["flair doctor --fix"],
  };

  test("a `foreign` outcome: its headline, its detail, the observer's detail, then the remedy", () => {
    expect(
      managedStartUnconfirmedLines({ port: PORT, recorded: { confirmation: "foreign", detail: detailFor("foreign") }, managed }),
    ).toEqual([
      `⚠️  The initial reachability wait on port ${PORT} passed, but the confirmation probe got a response that was not a Flair health answer (non-2xx or not Flair-shaped), so Flair is NOT verified as launchd-managed`,
      `   ${detailFor("foreign")}`,
      `   ${managed.detail}`,
      "   Fix: flair doctor --fix",
    ]);
  });

  for (const confirmation of ["flair", "foreign", "refused", "unreachable"] as const) {
    test(`a \`${confirmation}\` outcome selects the \`${confirmation}\` headline`, () => {
      const lines = managedStartUnconfirmedLines({ port: PORT, recorded: { confirmation, detail: detailFor(confirmation) }, managed });
      expect(lines[0]).toBe(renderManagedStartUnconfirmed({ port: PORT, confirmation, detail: detailFor(confirmation) })[0]);
    });
  }
});

// The real confirmation probe and classifyHealthProbe against a real HTTP
// server on a loopback port this file starts and stops. The launchctl read and
// the pid reads (serving pid, process start time) are injected; the
// reachability wait, the probe, hdb.pid and the sidecar write are real.
describe("flair#2422 — recordManagedStartSidecar through the real probe, against a local HTTP server", () => {
  type Reply = { status: number; body: string };
  const FLAIR_HEALTH = JSON.stringify({ ok: true, version: "0.0.0-test", searchReady: true, buildCommit: null });
  const servers: Server[] = [];
  const dirs: string[] = [];

  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "flair2422-probe-"));
    dirs.push(dir);
    writeFileSync(join(dir, "hdb.pid"), "4242\n");
    return dir;
  }

  /**
   * Requests carrying Authorization are the reachability wait's; the
   * confirmation probe sends none. `seen` records which arrived, in order.
   */
  async function startServer(reply: { wait: Reply; probe: Reply }) {
    const seen: Array<"wait" | "probe"> = [];
    const server = createServer((req, res) => {
      const which = req.headers.authorization ? "wait" : "probe";
      seen.push(which);
      res.writeHead(reply[which].status, { "content-type": "application/json", connection: "close" });
      res.end(reply[which].body);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return { server, port: (server.address() as AddressInfo).port, seen };
  }

  function stopServer(server: Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  afterEach(async () => {
    for (const server of servers.splice(0)) await stopServer(server);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const listRunning = () => ({ code: 0, stdout: `"Label" = "${LABEL}";\n"PID" = 4242;\n"LastExitStatus" = 0;\n` });
  const credentials = { adminUser: "admin-a", adminPass: "PLACEHOLDER-not-a-secret", timeoutMs: 5_000 };
  const startTime = Date.now() - 5_000;
  const pidReads = { servingPid: () => 4242, readStartTime: () => startTime };

  test("a 503 to the probe after the reachability wait passed -> `foreign`, no sidecar", async () => {
    const { port, seen } = await startServer({
      wait: { status: 200, body: FLAIR_HEALTH },
      probe: { status: 503, body: JSON.stringify({ error: "service unavailable" }) },
    });
    const dataDir = fixture();
    const outcome = await recordManagedStartSidecar(dataDir, port, LABEL, { ...credentials, list: listRunning, ...pidReads });
    expect(outcome).toEqual({ recorded: false, confirmation: "foreign", detail: detailFor("foreign") });
    expect(seen).toEqual(["wait", "probe"]);
    expect(readSidecar(dataDir)).toEqual({ kind: "absent" });
  }, 15_000);

  test("a 200 whose body is not Flair-shaped -> `foreign`, no sidecar", async () => {
    const decoy = { status: 200, body: JSON.stringify({ ok: true }) };
    const { port, seen } = await startServer({ wait: decoy, probe: decoy });
    const dataDir = fixture();
    const outcome = await recordManagedStartSidecar(dataDir, port, LABEL, { ...credentials, list: listRunning, ...pidReads });
    expect(outcome).toEqual({ recorded: false, confirmation: "foreign", detail: detailFor("foreign") });
    expect(seen).toEqual(["wait", "probe"]);
    expect(readSidecar(dataDir)).toEqual({ kind: "absent" });
  }, 15_000);

  test("the port closed after the reachability wait -> `refused`, no sidecar", async () => {
    const { server, port, seen } = await startServer({
      wait: { status: 200, body: FLAIR_HEALTH },
      probe: { status: 200, body: FLAIR_HEALTH },
    });
    const dataDir = fixture();
    // The launchctl read runs between the wait and the probe: close the
    // listener there, so the probe finds the port closed.
    const listThenClose = () => {
      server.close();
      server.closeAllConnections();
      return listRunning();
    };
    const outcome = await recordManagedStartSidecar(dataDir, port, LABEL, { ...credentials, list: listThenClose, ...pidReads });
    expect(outcome).toEqual({ recorded: false, confirmation: "refused", detail: detailFor("refused") });
    expect(seen).toEqual(["wait"]);
    expect(readSidecar(dataDir)).toEqual({ kind: "absent" });
  }, 15_000);

  test("a Flair-shaped /Health with the port served by another pid -> `flair`, no sidecar", async () => {
    const flair = { status: 200, body: FLAIR_HEALTH };
    const { port, seen } = await startServer({ wait: flair, probe: flair });
    const dataDir = fixture();
    const outcome = await recordManagedStartSidecar(dataDir, port, LABEL, {
      ...credentials,
      list: listRunning,
      ...pidReads,
      servingPid: () => 5252,
    });
    expect(outcome).toEqual({
      recorded: false,
      confirmation: "flair",
      detail: `the process answering on port ${port} is 5252, not launchd's process 4242 for job ${LABEL}, so its identity sidecar was not written`,
    });
    expect(seen).toEqual(["wait", "probe"]);
    expect(readSidecar(dataDir)).toEqual({ kind: "absent" });
  }, 15_000);

  test("a Flair-shaped /Health with every check passing -> recorded, and the sidecar is written", async () => {
    const flair = { status: 200, body: FLAIR_HEALTH };
    const { port, seen } = await startServer({ wait: flair, probe: flair });
    const dataDir = fixture();
    const outcome = await recordManagedStartSidecar(dataDir, port, LABEL, { ...credentials, list: listRunning, ...pidReads });
    expect(outcome).toEqual({ recorded: true, pid: 4242, detail: `launchd job ${LABEL} is running as process 4242` });
    expect(seen).toEqual(["wait", "probe"]);
    expect(readSidecar(dataDir)).toMatchObject({ kind: "present", pid: 4242, port, startTimeMs: startTime });
  }, 15_000);
});
