/**
 * Action recall (flair#2067 slice 2) — the testable hot-path runner.
 *
 * `runActionRecall` reads the cache; `readStdin` changes stream state and installs
 * listeners and a timer.
 */

import { readEnvOrUnset } from "./env-guard.js";
import {
  COMMAND_MAX_BYTES,
  DEFAULT_FLAIR_URL,
  INTERNAL_DEADLINE_MS,
  STDIN_MAX_BYTES,
  STDOUT_MAX_BYTES,
  canonicalUrl,
  hookOutput,
  parseCommand,
  renderContext,
  selectEntries,
  utf8Bytes,
} from "./action-recall.js";
import { readBinding, readGeneration, resolveCacheRoot, sessionDir } from "./action-recall-cache.js";
import type { CachePayload } from "./action-recall.js";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  root?: string;
  cwd?: string;
}

/** Read stdin up to `maxBytes`; resolves to "" on oversize, error or the deadline. */
export function readStdin(maxBytes: number = STDIN_MAX_BYTES, deadlineMs: number = INTERNAL_DEADLINE_MS): Promise<string> {
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
        if (utf8Bytes(data) > maxBytes) {
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

/** Race a payload read against the internal deadline (null on timeout or throw). */
function withDeadline<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function readPayload(
  dir: string,
  url: string,
  principal: string,
  session: string,
  now: number,
): Promise<CachePayload | null> {
  const binding = await readBinding(dir, { url, principal, session });
  if (!binding) return null;
  return readGeneration(dir, binding, now);
}

/**
 * The whole read path. Returns the exact hook output string, or "" when there
 * is nothing to say (non-Bash tool, unsupported command, missing identity,
 * missing/corrupt/stale cache, no matching lesson).
 */
export async function runActionRecall(rawInput: string, opts: RunOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  let input: unknown;
  try {
    input = JSON.parse(rawInput || "");
  } catch {
    return "";
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  if (record.tool_name !== "Bash") return "";
  const toolInput = record.tool_input;
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) return "";
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== "string" || utf8Bytes(command) > COMMAND_MAX_BYTES) return "";
  const cmd = parseCommand(command);
  if (!cmd) return "";
  const agentId = readEnvOrUnset("FLAIR_AGENT_ID", env);
  if (!agentId) return "";
  const url = canonicalUrl(readEnvOrUnset("FLAIR_URL", env) ?? DEFAULT_FLAIR_URL);
  if (!url) return "";
  const session = typeof record.session_id === "string" ? record.session_id : "";
  if (!session) return "";
  const cwd = typeof record.cwd === "string" && record.cwd ? record.cwd : opts.cwd ?? process.cwd();

  const root = opts.root ?? resolveCacheRoot(env);
  const dir = sessionDir(root, url, agentId, session);
  const payload = await withDeadline(readPayload(dir, url, agentId, session, now), INTERNAL_DEADLINE_MS);
  if (!payload) return "";
  const hits = selectEntries(payload.entries, cmd, cwd, now);
  const context = renderContext(hits);
  if (!context) return "";
  const output = hookOutput(context);
  return utf8Bytes(output) > STDOUT_MAX_BYTES ? "" : output;
}

export function isActionRecallOutput(output: string): boolean {
  if (!output || utf8Bytes(output) > STDOUT_MAX_BYTES) return false;
  try {
    const record = JSON.parse(output);
    const context = record?.hookSpecificOutput;
    return typeof record === "object" && record !== null && !Array.isArray(record)
      && Object.keys(record).length === 1
      && typeof context === "object" && context !== null && !Array.isArray(context)
      && Object.keys(context).length === 2
      && context.hookEventName === "PreToolUse" && typeof context.additionalContext === "string";
  } catch {
    return false;
  }
}

/** True when this module is the process entry point (Bun or Node 22+). */
export function shouldRunAsMain(importMeta: ImportMeta & { main?: boolean }, argv1: string | undefined): boolean {
  return importMeta.main === true || (argv1 != null && importMeta.url === `file://${argv1}`);
}
