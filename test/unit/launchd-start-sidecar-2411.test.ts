// flair#2411 — CLI-managed launchd start sidecar confirmation.
//
// The direct start path writes a flair#1454 sidecar immediately after spawn.
// A CLI-managed launchd start now writes one after confirmation. These tests
// drive recordManagedStartSidecar with launchctl injected, and the write/read
// go through the real file (the same writeDaemonSidecar the direct path uses).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSidecar, recordManagedStartSidecar } from "../../src/cli.ts";
import { classifyHealthProbe, verifyIdentity } from "../../src/lib/daemon-liveness.ts";

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair2411-start-sidecar-"));
  dirs.push(dir);
  writeFileSync(join(dir, "hdb.pid"), "4242\n");
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LABEL = "ai.tpsdev.flair.00002411";
const PORT = 19926;

/** A launchctl listing for LABEL: a running PID, or "loaded but no pid". */
function launchctlListing(pid: number | null) {
  return () => ({
    code: 0,
    stdout:
      pid === null
        ? `"Label" = "${LABEL}";\n"LastExitStatus" = 1;\n`
        : `"Label" = "${LABEL}";\n"PID" = ${pid};\n"LastExitStatus" = 0;\n`,
  });
}

const healthAnswers = () => Promise.resolve();
const healthTimesOut = () => Promise.reject(new Error("did not respond within 60000ms"));
const processStartMs = Date.now() - 5_000;
const confirmedDeps = {
  probeHealth: async () => classifyHealthProbe({ kind: "response" as const, status: 200, body: {
    ok: true, version: "test", searchReady: true, buildCommit: null,
  } }),
  readStartTime: () => processStartMs,
};

function recorder(warnings: string[]) {
  return (line: string) => warnings.push(line);
}

describe("flair#2411 — CLI-managed launchd start sidecar confirmation", () => {
  test("health delayed beyond the start-time tolerance records the process start", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      list: launchctlListing(4242),
      ...confirmedDeps,
      waitForHealth: async () => { expect(Date.now() - processStartMs).toBeGreaterThan(2_000); },
      servingPid: () => 4242,
      warn: recorder(warnings),
    });
    expect(outcome).toEqual({
      recorded: true,
      pid: 4242,
      detail: `launchd job ${LABEL} is running as process 4242`,
    });
    expect(warnings).toEqual([]);
    expect(readSidecar(dataDir)).toMatchObject({ kind: "present", pid: 4242, port: PORT, startTimeMs: processStartMs });
    expect(verifyIdentity({ pidfilePid: 4242, sidecar: readSidecar(dataDir), readStartTime: confirmedDeps.readStartTime }))
      .toEqual({ kind: "verified", pid: 4242 });
  });

  test("a stale sidecar naming another pid survives an unconfirmed start and is replaced after confirmation", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    writeFileSync(
      join(dataDir, "flair-daemon.json"),
      `${JSON.stringify({ pid: 1111, startTimeMs: Date.now(), port: PORT, flairVersion: "0.0.0" })}\n`,
    );
    // Unconfirmed: the process answering is not launchd's pid — the stale
    // sidecar is left exactly as it was.
    const unconfirmed = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      list: launchctlListing(4242),
      ...confirmedDeps,
      waitForHealth: healthAnswers,
      servingPid: () => 9999,
      warn: recorder(warnings),
    });
    expect(unconfirmed.recorded).toBe(false);
    expect(readSidecar(dataDir)).toMatchObject({ kind: "present", pid: 1111 });

    // Confirmed: the sidecar now names the pid launchd reported.
    const confirmed = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      list: launchctlListing(4242),
      ...confirmedDeps,
      waitForHealth: healthAnswers,
      servingPid: () => 4242,
      warn: recorder(warnings),
    });
    expect(confirmed.recorded).toBe(true);
    expect(readSidecar(dataDir)).toMatchObject({ kind: "present", pid: 4242 });
  });
});

describe("flair#2411 — an unconfirmed pid writes nothing and names the failed check", () => {
  test("launchctl reports no pid", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      list: launchctlListing(null),
      ...confirmedDeps,
      waitForHealth: healthAnswers,
      servingPid: () => 4242,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("did not report a running pid");
  });

  test("the launchctl read fails", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      list: () => ({ code: 1, stdout: "" }),
      ...confirmedDeps,
      waitForHealth: healthAnswers,
      servingPid: () => 4242,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("could not read launchd job");
  });

  test("the instance does not answer health", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    await expect(
      recordManagedStartSidecar(dataDir, PORT, LABEL, {
        list: launchctlListing(4242),
        ...confirmedDeps,
        waitForHealth: healthTimesOut,
        servingPid: () => 4242,
        warn: recorder(warnings),
      }),
    ).rejects.toThrow("did not respond within 60000ms");
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("did not answer health");
  });

  test("the pid that answers is not the one launchd reports", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      list: launchctlListing(4242),
      ...confirmedDeps,
      waitForHealth: healthAnswers,
      servingPid: () => 9999,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("not launchd's process 4242");
  });

  test("the process serving the instance cannot be identified", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      list: launchctlListing(4242),
      ...confirmedDeps,
      waitForHealth: healthAnswers,
      servingPid: () => null,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("could not be identified");
  });
});

describe("flair#2411 — pid checks around the health probe", () => {
  test("a 401 health response leaves no sidecar and names the failed fingerprint", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response("denied", { status: 401 }), { preconnect: originalFetch.preconnect });
    const outcome = await (async () => {
      try {
        return await recordManagedStartSidecar(dataDir, PORT, LABEL, {
          list: launchctlListing(4242),
          waitForHealth: healthAnswers,
          servingPid: () => 4242,
          warn: recorder(warnings),
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    })();
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("did not return Flair health (foreign)");
  });

  test("a serving pid replaced during the health probe leaves no sidecar", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    let serving = 4242;
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      ...confirmedDeps,
      list: launchctlListing(4242),
      waitForHealth: healthAnswers,
      probeHealth: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); serving = 5252; return { kind: "ok" }; },
      servingPid: () => serving,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("not launchd's process 4242");
  });

  test("a launchd pid replaced during the health probe leaves no sidecar", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    let launchd = 4242;
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      ...confirmedDeps,
      list: () => launchctlListing(launchd)(),
      waitForHealth: healthAnswers,
      probeHealth: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); launchd = 5252; return { kind: "ok" }; },
      servingPid: () => 4242,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("changed pid during health confirmation");
  });

  test("a pidfile naming another process leaves no sidecar", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    writeFileSync(join(dataDir, "hdb.pid"), "5252\n");
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      ...confirmedDeps,
      list: launchctlListing(4242),
      waitForHealth: healthAnswers,
      servingPid: () => 4242,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("hdb.pid does not confirm");
  });

  test("an unreadable process start time leaves no sidecar", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      ...confirmedDeps,
      list: launchctlListing(4242),
      waitForHealth: healthAnswers,
      servingPid: () => 4242,
      readStartTime: () => null,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("could not read the start time");
  });
});
