/**
 * ROOTPATH of a process `flair init` did not start (flair#1749).
 *
 * This reader is init's. Daemon sidecar recovery (`flair stop` / `flair start`
 * self-heal) keeps its own Linux-only `/proc` read and must not call this:
 * a macOS `ps` parse is a best-effort hint for an init message, not evidence
 * that may adopt a sidecar.
 *
 * Linux reads `/proc/<pid>/environ` (NUL-separated, spaces intact). macOS has
 * no proc environ file; `ps -Eww` appends the environment to the command.
 * A value is taken through to the next `NAME=` token so a space in the path
 * is not stored as a prefix. A failed read is "could not read" — callers must
 * not invent a data directory, and must not treat a missing value as proof
 * the listener is a different instance.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extractRootPath, parseNullSeparatedEnviron } from "./daemon-liveness.js";

export interface InitListenerRootPath {
  rootPath: string | null;
  /** False when the read failed. True when it succeeded, even if ROOTPATH is absent. */
  environReadable: boolean;
}

const UNREADABLE: InitListenerRootPath = { rootPath: null, environReadable: false };

/**
 * Parse `ps -Eww -o command=` output.
 *
 * `ROOTPATH` runs until the next environment assignment. `(\S+)` would keep
 * only `/Users/John` from `/Users/John Doe/.flair` and init would treat that
 * prefix as a different data directory. A missing `ROOTPATH` is a successful
 * read with no directory. Callers pass `null` when `ps` itself failed.
 */
export function parsePsCommandRootPath(command: string | null): InitListenerRootPath {
  if (command === null) return UNREADABLE;
  const match = /(?:^|\s)ROOTPATH=/.exec(command);
  if (!match) return { rootPath: null, environReadable: true };
  const rest = command.slice(match.index + match[0].length);
  const next = rest.search(/\s+[A-Za-z_][A-Za-z0-9_]*=/);
  const value = (next === -1 ? rest : rest.slice(0, next)).replace(/\s+$/, "");
  if (!value) return { rootPath: null, environReadable: true };
  return { rootPath: value, environReadable: true };
}

function readDarwinInitListenerRootPath(pid: number): InitListenerRootPath {
  try {
    const out = execFileSync("ps", ["-Eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parsePsCommandRootPath(String(out));
  } catch {
    return UNREADABLE;
  }
}

/** Init-only. Do not use this from sidecar recovery. */
export function readInitListenerRootPath(pid: number): InitListenerRootPath {
  if (!Number.isInteger(pid) || pid <= 0) return UNREADABLE;
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/environ`, "utf-8");
      return { rootPath: extractRootPath(parseNullSeparatedEnviron(raw)), environReadable: true };
    } catch {
      return UNREADABLE;
    }
  }
  if (process.platform === "darwin") return readDarwinInitListenerRootPath(pid);
  return UNREADABLE;
}
