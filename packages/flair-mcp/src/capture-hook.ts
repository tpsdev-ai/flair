#!/usr/bin/env bun
/**
 * Flair capture hook for Claude Code (flair#2068) — the hot path.
 *
 * CONFIG (env):
 *   FLAIR_AGENT_ID   (required — absent ⇒ capture nothing)
 *   FLAIR_URL, FLAIR_KEY_PATH   (flush only, via flair-client)
 *   FLAIR_CAPTURE_DIR (default ~/.flair/capture; test override)
 *   FLAIR_HOOK_PROBE (probe mode: exit immediately, no stdin read, no writes)
 */

import { spawn } from "node:child_process";
import { isProbeMode } from "./env-guard.js";
import {
  CAPTURE_STDIN_MAX_BYTES,
  claimFlushSlot,
  resolveCaptureDir,
  runCapture,
  runCaptureFlush,
  stripInterpolationLiteralsFromEnv,
} from "./capture-spool.js";

/** Resolves to "" on oversize, error or deadline. */
function readStdin(maxBytes: number = CAPTURE_STDIN_MAX_BYTES, deadlineMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (value: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(""), deadlineMs);
    timer.unref?.();
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        data += chunk;
        if (Buffer.byteLength(data, "utf8") > maxBytes) {
          process.stdin.pause?.();
          finish("");
        }
      });
      process.stdin.on("end", () => finish(data));
      process.stdin.on("error", () => finish(""));
    } catch {
      finish("");
    }
  });
}

/** Spawn a detached, unref'd flush; never waits on it. The flush runs the
 *  version-matched published package (the installer records its spec in
 *  FLAIR_CAPTURE_FLUSH_SPEC), which carries flair-client — so the hot-path
 *  copy stays dependency-free. With no spec the spool simply waits. */
export function kickBackgroundFlush(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const agentId = env.FLAIR_AGENT_ID;
    if (!agentId) return;
    // Probe-only switch (see capture-runtime.ts): the certification run must
    // not launch a flush, so it sets this and the spool simply waits.
    if (env.FLAIR_CAPTURE_NO_FLUSH === "1") return;
    const spec = env.FLAIR_CAPTURE_FLUSH_SPEC;
    if (!spec || !/^@[A-Za-z0-9._/-]+@[A-Za-z0-9._-]+$/.test(spec)) return;
    const dir = resolveCaptureDir(env);
    if (!claimFlushSlot(dir, agentId, Date.now())) return;
    const child = spawn("npx", ["-y", "-p", spec, "flair-capture", "--flush"], {
      detached: true,
      stdio: "ignore",
      env: { ...env, FLAIR_CAPTURE_FLUSH: "1" },
    });
    child.unref();
    child.on("error", () => {});
  } catch {
    // Fail-open: the spool waits, bounded.
  }
}

async function main(): Promise<void> {
  if (isProbeMode()) return;
  stripInterpolationLiteralsFromEnv();
  if (process.argv.includes("--flush")) {
    try {
      await runCaptureFlush();
    } catch {
      // Fail-open.
    }
    return;
  }
  try {
    const raw = await readStdin();
    runCapture(raw, { kickFlush: () => kickBackgroundFlush() });
  } catch {
    // Fail-open is the contract.
  }
}

const importMeta = import.meta as ImportMeta & { main?: boolean };
const isMain =
  importMeta.main === true ||
  (typeof process !== "undefined" && process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`);

if (isMain) {
  void main().catch(() => {}).finally(() => process.exit(0));
}
