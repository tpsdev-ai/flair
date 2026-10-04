import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

export interface TrackedLaunchdJob {
  label: string;
  plistPath: string;
}

interface CommandResult {
  status: number | null;
  stderr: string;
  signal?: string | null;
  error?: Error;
}

export type CleanupCommand = (args: string[], timeout: number) => CommandResult;

const realCommand: CleanupCommand = (args, timeout) =>
  spawnSync("launchctl", args, { encoding: "utf-8", timeout });

export function unloadJob(
  label: string,
  plistPath: string,
  run: CleanupCommand = realCommand,
  uid: number | undefined = process.getuid?.(),
): void {
  if (uid === undefined) throw new Error(`launchd cleanup ${label}: cannot determine gui domain`);
  const failures: string[] = [];
  for (const args of [["unload", plistPath], ["bootout", `gui/${uid}/${label}`]]) {
    const result = run(args, 10_000);
    if (result.status !== 0 || result.signal || result.error) {
      failures.push(`${args[0]} exit ${result.status}, signal ${result.signal ?? "none"}: ${result.error?.message ?? result.stderr.trim()}`);
    }
  }
  const probe = run(["print", `gui/${uid}/${label}`], 5_000);
  const absent = !probe.error && !probe.signal && probe.status !== null && probe.status !== 0 &&
    (probe.status === 113 || /could not find service/i.test(probe.stderr));
  if (!absent) {
    const state = probe.status === 0 && !probe.error && !probe.signal
      ? "job is still loaded"
      : "could not verify job absence";
    throw new Error(`launchd cleanup ${label}: ${state}; ${failures.join("; ")}; print exit ${probe.status}: ${probe.error?.message ?? probe.stderr.trim()}`);
  }
}

export async function cleanupLaunchdSandbox(
  jobs: Set<TrackedLaunchdJob>,
  launchAgentsDir: string,
  removeSandbox: () => Promise<void>,
  unload: (label: string, plistPath: string) => void = unloadJob,
): Promise<void> {
  const owned = [...jobs].filter(job => dirname(job.plistPath) === launchAgentsDir);
  for (const job of owned) unload(job.label, job.plistPath);
  await removeSandbox();
  for (const job of owned) jobs.delete(job);
}
