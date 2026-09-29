/**
 * install-tree-commands-2034.test.ts — flair#2034 §2: what `flair status`,
 * `flair restart` and `flair doctor` SAY and COUNT for each install-tree state.
 *
 * The decisions are extracted from the command actions (statusVersionAdvice,
 * restartTreeReport, runInstallTreeDoctorSection) and driven here with
 * hand-built assessments; the actions only pass real adapters in. The wiring
 * that the actions really call them is in test/unit-isolated/*-2034-wiring.
 */
import { describe, test, expect } from "bun:test";
import { assessTreeDivergence, withRunningVersion, type TreeAssessment } from "../../src/lib/tree-divergence.ts";
import { statusVersionAdvice } from "../../src/commands/status.ts";
import { restartTreeReport } from "../../src/commands/service.ts";
import { runInstallTreeDoctorSection, type InstallTreeDoctorDeps } from "../../src/commands/doctor.ts";

const OLD_TREE = "/u/.local/share/mise/installs/node/24.18.0/lib/node_modules/@tpsdev-ai/flair";
const NEW_TREE = "/u/.local/share/mise/installs/node/24.19.0/lib/node_modules/@tpsdev-ai/flair";
const NUDGE = { severity: "yellow", message: "flair 0.55.2 is behind — latest is 0.57.0 (2 minor versions behind). Run: flair upgrade" };

function assessment(state: "same" | "diverged" | "separate" | "unknown", over: { cliVersion?: string; running?: string | null } = {}): TreeAssessment {
  const cli = { dir: NEW_TREE, version: over.cliVersion ?? "0.55.2" };
  const dir = state === "same" ? NEW_TREE : state === "separate" ? "/opt/flair" : OLD_TREE;
  const serving =
    state === "unknown"
      ? { kind: "unknown" as const, reason: "no launchd service is registered for this data directory" }
      : {
          kind: "proven" as const,
          dir,
          version: "0.57.0",
          pid: 4242,
          manager: "launchd" as const,
          unitName: "ai.tpsdev.flair.abcd1234",
          unitPath: "/u/Library/LaunchAgents/ai.tpsdev.flair.abcd1234.plist",
          unitNodeBin: null,
          unitTree: dir,
          dropInPaths: [],
        };
  return withRunningVersion(
    assessTreeDivergence({ cli, serving, currentNodeBin: "/n", samePath: (a, b) => a === b }),
    over.running === undefined ? "0.57.0" : over.running,
  );
}

const texts = (lines: Array<{ text: string }>) => lines.map((l) => l.text);
const count = (lines: string[], needle: string) => lines.filter((l) => l.includes(needle)).length;

describe("statusVersionAdvice — each hint once, decided from the proven tree", () => {
  test("proven divergence: the block REPLACES the CLI's upgrade nudge; the remedy appears once", () => {
    const out = texts(statusVersionAdvice({ cliVersion: "0.55.2", runningVersion: "0.57.0", versionNudge: NUDGE, latest: "0.57.0", tree: assessment("diverged") }));
    expect(count(out, "Run: flair upgrade")).toBe(0);
    expect(count(out, "DIFFERENT install trees")).toBe(1);
    expect(count(out, "npm i -g @tpsdev-ai/flair")).toBe(1);
    expect(count(out, "run: flair restart")).toBe(0);
    expect(out.join("\n")).toContain("this CLI is behind, the instance is current");
  });

  test("same tree, server running other code: the CLI nudge once and `flair restart` once", () => {
    const out = texts(statusVersionAdvice({ cliVersion: "0.55.2", runningVersion: "0.54.0", versionNudge: NUDGE, latest: "0.57.0", tree: assessment("same") }));
    expect(count(out, "Run: flair upgrade")).toBe(1);
    expect(count(out, "run: flair restart")).toBe(1);
    expect(out.join("\n")).toContain("the same install tree");
  });

  test("unknown tree: server currency is stated with NO local remedy", () => {
    const out = texts(statusVersionAdvice({ cliVersion: "0.55.2", runningVersion: "0.57.0", versionNudge: null, latest: null, tree: assessment("unknown") }));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("the server is running flair 0.57.0; this CLI is 0.55.2");
    expect(out[0]).toContain("serving install tree: unknown");
    expect(out[0]).not.toContain("flair restart");
    expect(out[0]).not.toContain("npm i -g");
  });

  test("an unreadable server version is shown as unknown", () => {
    const out = texts(statusVersionAdvice({ cliVersion: "0.57.0", runningVersion: null, versionNudge: null, latest: null, tree: null }));
    expect(out).toEqual(["server version: unknown (this CLI is flair 0.57.0)"]);
  });

  test("everything current: nothing at all", () => {
    expect(statusVersionAdvice({ cliVersion: "0.57.0", runningVersion: "0.57.0", versionNudge: null, latest: "0.57.0", tree: assessment("same", { cliVersion: "0.57.0" }) })).toEqual([]);
  });

  test("a separately managed tree at this CLI's version is the steady state: not named", () => {
    const out = texts(statusVersionAdvice({ cliVersion: "0.57.0", runningVersion: "0.57.0", versionNudge: null, latest: "0.57.0", tree: assessment("separate", { cliVersion: "0.57.0" }) }));
    expect(out).toEqual([]);
  });

  test("a separately managed tree is named, and no re-point remedy is given", () => {
    const out = texts(statusVersionAdvice({ cliVersion: "0.55.2", runningVersion: "0.57.0", versionNudge: NUDGE, latest: "0.57.0", tree: assessment("separate") })).join("\n");
    expect(out).toContain("separately managed");
    expect(out).not.toContain("flair init");
    expect(count(out.split("\n"), "Run: flair upgrade")).toBe(1);
  });
});

describe("restartTreeReport — the verification step of the remedy", () => {
  test("still diverged after the restart: not ok, and the remedy is named", () => {
    const r = restartTreeReport(assessment("diverged", { cliVersion: "0.57.0" }));
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("still serves a DIFFERENT install tree");
    expect(r.lines.join("\n")).toContain("Remedy: flair init && flair restart");
  });

  test("same tree: ok, and the serving tree is named as this CLI's", () => {
    const r = restartTreeReport(assessment("same"));
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain(`serving install tree: ${NEW_TREE}`);
    expect(r.lines.join("\n")).toContain("this CLI's tree");
  });

  test("unknown: ok (the restart itself worked), and says why the tree is unverified", () => {
    const r = restartTreeReport(assessment("unknown"));
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("serving install tree: unknown");
  });
});

describe("runInstallTreeDoctorSection — counting", () => {
  function deps(over: Partial<InstallTreeDoctorDeps> & { after?: TreeAssessment } = {}): InstallTreeDoctorDeps & { calls: string[] } {
    const calls: string[] = [];
    let assessed = 0;
    const d: InstallTreeDoctorDeps = {
      assess: () => {
        calls.push("assess");
        assessed++;
        return assessed === 1 ? assessment("diverged", { cliVersion: "0.57.0" }) : (over.after ?? assessment("same", { cliVersion: "0.57.0" }));
      },
      repoint: (dry) => { calls.push(`repoint:${dry}`); return { kind: dry ? "would-repoint" : "repointed", detail: "re-pointed the launchd plist" }; },
      restart: async () => { calls.push("restart"); },
      rewriteFederation: () => ({ status: "not-enabled", detail: "" }),
      ...over,
    };
    return Object.assign(d, { calls });
  }
  const quiet = () => {};

  test("a proven divergence is one issue; report-only mode touches nothing", async () => {
    const d = deps();
    const r = await runInstallTreeDoctorSection({ autoFix: false, dryRun: false }, d, quiet);
    expect(r).toEqual({ issues: 1, fixed: 0 });
    expect(d.calls).toEqual(["assess"]);
  });

  test("--fix counts it fixed only after re-point + restart + a re-proven same tree", async () => {
    const d = deps();
    const r = await runInstallTreeDoctorSection({ autoFix: true, dryRun: false }, d, quiet);
    expect(r).toEqual({ issues: 1, fixed: 1 });
    expect(d.calls).toEqual(["assess", "repoint:false", "restart", "assess"]);
  });

  test("--fix whose restart still serves the old tree is NOT a fix", async () => {
    const d = deps({ after: assessment("diverged", { cliVersion: "0.57.0" }) });
    expect(await runInstallTreeDoctorSection({ autoFix: true, dryRun: false }, d, quiet)).toEqual({ issues: 1, fixed: 0 });
  });

  test("--fix whose serving tree is unknown after the restart is NOT a fix", async () => {
    const d = deps({ after: assessment("unknown") });
    expect(await runInstallTreeDoctorSection({ autoFix: true, dryRun: false }, d, quiet)).toEqual({ issues: 1, fixed: 0 });
  });

  test("--fix whose re-point is refused never restarts and is not a fix", async () => {
    const d = deps({ repoint: () => ({ kind: "refused", detail: "separately managed" }) });
    expect(await runInstallTreeDoctorSection({ autoFix: true, dryRun: false }, d, quiet)).toEqual({ issues: 1, fixed: 0 });
    expect(d.calls).not.toContain("restart");
  });

  test("--fix with a failing restart is not a fix", async () => {
    const d = deps({ restart: async () => { throw new Error("did not respond"); } });
    expect(await runInstallTreeDoctorSection({ autoFix: true, dryRun: false }, d, quiet)).toEqual({ issues: 1, fixed: 0 });
  });

  test("--fix will not re-point at an OLDER CLI tree", async () => {
    const d = deps({ assess: () => assessment("diverged", { cliVersion: "0.55.2" }) });
    expect(await runInstallTreeDoctorSection({ autoFix: true, dryRun: false }, d, quiet)).toEqual({ issues: 1, fixed: 0 });
    expect(d.calls.some((c) => c.startsWith("repoint"))).toBe(false);
  });

  test("--fix --dry-run plans the re-point and changes nothing", async () => {
    const d = deps();
    expect(await runInstallTreeDoctorSection({ autoFix: true, dryRun: true }, d, quiet)).toEqual({ issues: 1, fixed: 0 });
    expect(d.calls).toEqual(["assess", "repoint:true"]);
  });

  test("a deliberate pin, a separately managed tree and an unknown tree are never counted", async () => {
    for (const a of [assessment("same"), assessment("separate"), assessment("unknown")]) {
      const r = await runInstallTreeDoctorSection({ autoFix: true, dryRun: false }, deps({ assess: () => a }), quiet);
      expect(r).toEqual({ issues: 0, fixed: 0 });
    }
  });

  test("federation shim: 'nothing to rewrite' is neither an issue nor a fix", async () => {
    for (const status of ["not-enabled", "current", "pinned-node", "separate", "refused"] as const) {
      const r = await runInstallTreeDoctorSection(
        { autoFix: true, dryRun: false },
        deps({ assess: () => assessment("same"), rewriteFederation: () => ({ status, detail: "d" }) }),
        quiet,
      );
      expect(r).toEqual({ issues: 0, fixed: 0 });
    }
  });

  test("federation shim running another tree: one issue, fixed only when re-read as current", async () => {
    const seq = (after: string) => {
      const out = ["would-rewrite", "rewritten", after];
      return () => ({ status: out.shift() as any, detail: "d" });
    };
    const fixedRun = await runInstallTreeDoctorSection(
      { autoFix: true, dryRun: false },
      deps({ assess: () => assessment("same"), rewriteFederation: seq("current") }),
      quiet,
    );
    expect(fixedRun).toEqual({ issues: 1, fixed: 1 });
    const unverified = await runInstallTreeDoctorSection(
      { autoFix: true, dryRun: false },
      deps({ assess: () => assessment("same"), rewriteFederation: seq("would-rewrite") }),
      quiet,
    );
    expect(unverified).toEqual({ issues: 1, fixed: 0 });
  });
});
