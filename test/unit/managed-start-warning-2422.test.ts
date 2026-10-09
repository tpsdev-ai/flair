// flair#2422 — the managed-start warning reports what the confirmation probe saw.
//
// When a CLI-managed launchd start is not confirmed, the warning used to say
// "Flair is running on port <port>" whatever the confirmation probe saw, and
// the probe can find a foreign listener, a refused connection or an
// unreachable port. The warning now names the reachability wait that passed,
// the probe's result, and the failed check.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordManagedStartSidecar } from "../../src/cli.ts";
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

  test("a foreign listener", () => {
    const lines = renderManagedStartUnconfirmed({ port: PORT, confirmation: "foreign", detail: detailFor("foreign") });
    expect(lines).toEqual([
      `⚠️  The initial reachability wait on port ${PORT} passed, but the confirmation probe found a foreign listener, so Flair is NOT verified as launchd-managed`,
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

  test("an unreachable port", () => {
    const lines = renderManagedStartUnconfirmed({ port: PORT, confirmation: "unreachable", detail: detailFor("unreachable") });
    expect(lines).toEqual([
      `⚠️  The initial reachability wait on port ${PORT} passed, but the confirmation probe could not reach the port, so Flair is NOT verified as launchd-managed`,
      `   ${detailFor("unreachable")}`,
    ]);
    expect(lines[0]).not.toContain("Flair is running");
  });

  test("the legacy-migration line and the remedy follow the detail", () => {
    const lines = renderManagedStartUnconfirmed({
      port: PORT,
      confirmation: "flair",
      detail: "launchd did not report a running pid, so its identity sidecar was not written",
      moved: `The launchd service was moved off the legacy label (ai.tpsdev.flair.legacy) → ${LABEL}.`,
      remedy: ["flair restart", "launchctl bootstrap gui/501"],
    });
    expect(lines).toEqual([
      `⚠️  Flair is running on port ${PORT}, but it is NOT verified as launchd-managed`,
      "   launchd did not report a running pid, so its identity sidecar was not written",
      `   The launchd service was moved off the legacy label (ai.tpsdev.flair.legacy) → ${LABEL}.`,
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
