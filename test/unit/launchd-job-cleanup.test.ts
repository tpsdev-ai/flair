import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { cleanupLaunchdSandbox, unloadJob, type CleanupCommand } from "../helpers/launchd-job-cleanup.ts";

test("cleanup leaves an untracked legacy label alone", async () => {
  const jobs = new Set([{ label: "ai.tpsdev.flair.fixture", plistPath: "/fixture/LaunchAgents/instance.plist" }]);
  const calls: string[] = [];
  await cleanupLaunchdSandbox(jobs, "/fixture/LaunchAgents", async () => {}, label => { calls.push(label); });
  expect(calls).toEqual(["ai.tpsdev.flair.fixture"]);
  expect(calls).not.toContain("ai.tpsdev.flair");
  expect(jobs.size).toBe(0);
});

test("cleanup does not unload a tracked job outside the sandbox LaunchAgents directory", async () => {
  const sandboxJob = { label: "ai.tpsdev.flair.fixture", plistPath: "/fixture/LaunchAgents/instance.plist" };
  const externalJob = { label: "ai.tpsdev.flair.external", plistPath: "/other/LaunchAgents/instance.plist" };
  const jobs = new Set([sandboxJob, externalJob]);
  const calls: Array<[string, string]> = [];
  let removed = false;
  await cleanupLaunchdSandbox(jobs, "/fixture/LaunchAgents", async () => {
    removed = true;
  }, (label, plistPath) => { calls.push([label, plistPath]); });
  expect(calls).toEqual([[sandboxJob.label, sandboxJob.plistPath]]);
  expect(removed).toBe(true);
  expect([...jobs]).toEqual([externalJob]);
});

test("unload checks both command results and verifies absence", () => {
  const calls: string[] = [];
  const run: CleanupCommand = args => {
    calls.push(args[0]);
    return { status: args[0] === "print" ? 113 : 1, stderr: "not loaded" };
  };
  expect(() => unloadJob("fixture", "/fixture/job.plist", run, 501)).not.toThrow();
  expect(calls).toEqual(["unload", "bootout", "print"]);
});

test("cleanup retains the label and root when the job is still loaded", async () => {
  const root = tempDir("flair-cleanup-");
  const launchAgentsDir = join(root, "LaunchAgents");
  mkdirSync(launchAgentsDir);
  const jobs = new Set([{ label: "fixture", plistPath: join(launchAgentsDir, "job.plist") }]);
  const run: CleanupCommand = args => ({ status: args[0] === "print" ? 0 : args[0] === "bootout" ? 2 : 1, stderr: "refused" });
  const cleanup = cleanupLaunchdSandbox(jobs, launchAgentsDir, async () => {
    rmSync(root, { recursive: true });
  }, (label, path) => unloadJob(label, path, run, 501));
  await expect(cleanup).rejects.toThrow(/launchd cleanup fixture: job is still loaded; unload exit 1.*bootout exit 2/);
  expect(jobs.size).toBe(1);
  expect(existsSync(root)).toBe(true);
});

for (const probe of [
  { status: null, stderr: "Could not find service", error: new Error("timed out") },
  { status: 1, stderr: "permission denied" },
  { status: 113, stderr: "", signal: "SIGTERM" },
]) {
  test(`cleanup refuses an inconclusive presence probe (${probe.status}, ${probe.stderr}, ${probe.signal ?? "no signal"})`, () => {
    const run: CleanupCommand = args => args[0] === "print" ? probe : { status: 0, stderr: "" };
    expect(() => unloadJob("fixture", "/fixture/job.plist", run, 501)).toThrow("launchd cleanup fixture: could not verify job absence");
  });
}
