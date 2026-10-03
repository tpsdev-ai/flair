/**
 * Capture runtime provisioning + certification (flair#2068).
 *
 * The capture hook is a second consumer of the descriptor-driven provisioning
 * in ./action-recall-runtime.ts: the same versioned, Flair-owned copy under
 * `~/.flair/hooks/capture/<version>-<hash>/`, the same never-lower-safe copy
 * checks, and the same "execute the provisioned command and check what it did"
 * certification. Only the descriptor and the probe (what "working" means for
 * this hook) live here.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildCaptureHookCommand, captureFlushSpec } from "../doctor-client.js";
import { flairCliVersion } from "./mcp-spec.js";
import {
  hookArtifactForPackage,
  hookInstallRoot,
  isBuiltHookArtifact,
  plannedHookRuntime,
  provisionHookRuntime,
  resolveBunPath,
  resolveHookRuntime,
  type ActionRecallRuntime,
  type ActionRecallRuntimeResult,
  type HookArtifactDescriptor,
  type ResolveOptions,
} from "./action-recall-runtime.js";

export type { ActionRecallRuntime } from "./action-recall-runtime.js";

export const CAPTURE_ARTIFACT: HookArtifactDescriptor = {
  key: "capture",
  artifactFile: "capture-hook.js",
  binName: "flair-capture",
  marker: "flair-capture-built",
  runtimeFiles: ["capture-hook.js", "capture-spool.js", "capture.js", "env-guard.js", "secret-redaction.js", "record-id-path.js"],
  envArtifact: "FLAIR_CAPTURE_ARTIFACT",
};

export function captureArtifactForPackage(packageDir: string): string {
  return hookArtifactForPackage(packageDir, CAPTURE_ARTIFACT);
}

export function captureInstallRoot(homeDir: string): string {
  return hookInstallRoot(homeDir, CAPTURE_ARTIFACT);
}

export function plannedCaptureRuntime(runtime: ActionRecallRuntime, homeDir: string): ActionRecallRuntime {
  return plannedHookRuntime(runtime, homeDir, CAPTURE_ARTIFACT);
}

export function provisionCaptureRuntime(runtime: ActionRecallRuntime, homeDir: string, agentId: string, flairUrl: string): ActionRecallRuntime {
  return provisionHookRuntime(runtime, homeDir, agentId, flairUrl, CAPTURE_ARTIFACT, probeCaptureRuntime);
}

function isSupportedExecutable(runtime: ActionRecallRuntime): boolean {
  return resolveBunPath({ FLAIR_BUN_PATH: runtime.bunPath, PATH: "" }) === runtime.bunPath;
}

/** The secret shape the probe plants — a GitHub token the redactor recognizes. */
function probeSecret(nonce: string): string {
  return `ghp_${createHash("sha256").update(nonce).digest("hex").slice(0, 24)}`;
}

/**
 * Certification: run the provisioned command against a synthetic Stop payload
 * whose decision sentence carries a nonce and a secret-shaped token, then read
 * back the local spool. Working means: the command executed (exit 0), it
 * staged exactly one candidate, the candidate contains the nonce, and the
 * secret was redacted — so the probe proves execution, spooling AND redaction,
 * not merely that a file exists.
 */
export function probeCaptureRuntime(runtime: ActionRecallRuntime, agentId = "flair-probe", flairUrl = "http://localhost:19926", command?: string): string | null {
  const failure = `capture self-test failed (${runtime.bunPath}, ${runtime.artifactPath})`;
  if (!isSupportedExecutable(runtime) || !isBuiltHookArtifact(runtime.artifactPath, CAPTURE_ARTIFACT)) return failure;
  let home: string | undefined;
  try {
    home = mkdtempSync(join(realpathSync(tmpdir()), "flair-capture-probe-"));
    const nonce = randomBytes(16).toString("hex");
    const secret = probeSecret(nonce);
    const dir = join(home, ".flair", "capture");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const installedCommand = command ?? buildCaptureHookCommand(runtime.bunPath, runtime.artifactPath, agentId, flairUrl, captureFlushSpec());
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "probe",
      last_assistant_message: `Decision: use probe ${nonce} with token ${secret} for the archive.`,
    });
    const env = {
      HOME: home,
      USERPROFILE: home,
      TMPDIR: home,
      PATH: "/usr/bin:/bin",
      BUN_INSTALL_AUTO: "disable",
      FLAIR_CAPTURE_DIR: dir,
      FLAIR_CAPTURE_NO_FLUSH: "1",
    };
    execFileSync("/bin/sh", ["-c", installedCommand], { input: payload, encoding: "utf8", timeout: 2000, maxBuffer: 8192, cwd: home, env, stdio: ["pipe", "ignore", "ignore"] });
    const spoolText = readFileSync(join(dir, `${agentId}.spool.json`), "utf-8");
    const parsed = JSON.parse(spoolText) as { records?: Array<{ content?: unknown }> };
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    if (records.length !== 1) return failure;
    const content = typeof records[0]?.content === "string" ? (records[0]!.content as string) : "";
    if (!content.includes(nonce)) return failure;
    if (content.includes(secret)) return failure;
    if (!content.includes("[redacted]")) return failure;
    // A non-capturable payload must stage nothing: proves the hook plans, not
    // merely appends.
    writeFileSync(join(dir, `${agentId}.spool.json`), `${JSON.stringify({ v: 1, agentId, records: [] })}\n`, { mode: 0o600 });
    execFileSync("/bin/sh", ["-c", installedCommand], {
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "probe", last_assistant_message: "Routine turn; nothing to record." }),
      encoding: "utf8", timeout: 2000, maxBuffer: 8192, cwd: home, env, stdio: ["pipe", "ignore", "ignore"],
    });
    const after = JSON.parse(readFileSync(join(dir, `${agentId}.spool.json`), "utf-8")) as { records?: unknown[] };
    if ((after.records ?? []).length !== 0) return failure;
    // A failed Bash call (PostToolUseFailure) and its later success
    // (PostToolUse) must stage one redacted candidate.
    const toolInput = { command: `probe-${nonce} run` };
    for (const event of [
      { hook_event_name: "PostToolUseFailure", session_id: "probe", tool_name: "Bash", tool_input: toolInput, error: `Error: token ${secret} rejected` },
      { hook_event_name: "PostToolUse", session_id: "probe", tool_name: "Bash", tool_input: toolInput, tool_response: { stdout: "" } },
    ]) {
      execFileSync("/bin/sh", ["-c", installedCommand], {
        input: JSON.stringify(event), encoding: "utf8", timeout: 2000, maxBuffer: 8192, cwd: home, env, stdio: ["pipe", "ignore", "ignore"],
      });
    }
    const paired = JSON.parse(readFileSync(join(dir, `${agentId}.spool.json`), "utf-8")) as { records?: Array<{ content?: unknown }> };
    const pairedRecords = Array.isArray(paired.records) ? paired.records : [];
    if (pairedRecords.length !== 1) return failure;
    const pairedContent = typeof pairedRecords[0]?.content === "string" ? (pairedRecords[0]!.content as string) : "";
    if (!pairedContent.includes(nonce) || pairedContent.includes(secret) || !pairedContent.includes("[redacted]")) return failure;
    return null;
  } catch {
    return failure;
  } finally {
    if (home) {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  }
}

export function isWorkingCaptureRuntime(runtime: ActionRecallRuntime): boolean {
  return probeCaptureRuntime(runtime) === null;
}

export function resolveCaptureRuntime(opts: ResolveOptions): ActionRecallRuntimeResult {
  return resolveHookRuntime(opts, CAPTURE_ARTIFACT, probeCaptureRuntime);
}

/** Re-exported for callers that need the version the descriptor expects. */
export { flairCliVersion };
