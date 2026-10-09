// flair#2411 — a launchd-managed start records the identity sidecar for the
// instance it started.
//
// The direct start path writes a flair#1454 sidecar immediately after spawn.
// The managed launchd path never did, so after a launchd restart the data
// directory named no running pid until something else wrote one. These tests
// drive recordManagedStartSidecar with launchctl injected, and the write/read
// go through the real file (the same writeDaemonSidecar the direct path uses).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSidecar, recordManagedStartSidecar } from "../../src/cli.ts";

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair2411-start-sidecar-"));
  dirs.push(dir);
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

function recorder(warnings: string[]) {
  return (line: string) => warnings.push(line);
}

describe("flair#2411 — a managed launchd start records the identity sidecar", () => {
  test("a confirmed pid is recorded in the sidecar", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    const outcome = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      list: launchctlListing(4242),
      waitForHealth: healthAnswers,
      servingPid: () => 4242,
      warn: recorder(warnings),
    });
    expect(outcome).toEqual({
      recorded: true,
      pid: 4242,
      detail: `launchd job ${LABEL} is running as process 4242`,
    });
    expect(warnings).toEqual([]);
    expect(readSidecar(dataDir)).toMatchObject({ kind: "present", pid: 4242, port: PORT });
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
      waitForHealth: healthAnswers,
      servingPid: () => 9999,
      warn: recorder(warnings),
    });
    expect(unconfirmed.recorded).toBe(false);
    expect(readSidecar(dataDir)).toMatchObject({ kind: "present", pid: 1111 });

    // Confirmed: the sidecar now names the pid launchd reported.
    const confirmed = await recordManagedStartSidecar(dataDir, PORT, LABEL, {
      list: launchctlListing(4242),
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
      waitForHealth: healthAnswers,
      servingPid: () => 4242,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("did not report a running pid");
  });

  test("the instance does not answer health", async () => {
    const dataDir = fixture();
    const warnings: string[] = [];
    await expect(
      recordManagedStartSidecar(dataDir, PORT, LABEL, {
        list: launchctlListing(4242),
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
      waitForHealth: healthAnswers,
      servingPid: () => null,
      warn: recorder(warnings),
    });
    expect(outcome.recorded).toBe(false);
    expect(readSidecar(dataDir).kind).toBe("absent");
    expect(warnings.join("\n")).toContain("could not be identified");
  });
});
