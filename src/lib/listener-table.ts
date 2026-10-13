/**
 * listener-table.ts — the processes the OS lists as LISTENING on a TCP port
 * (flair#2526). The answer comes from the kernel's socket table, never from
 * anything a listener says about itself and never from a PID file.
 *
 * Per platform:
 *   - Linux: the LISTEN rows (state `0A`) of `/proc/net/tcp` and
 *     `/proc/net/tcp6` whose local port is `port` name socket inodes; the
 *     processes holding those inodes are the ones whose `/proc/<pid>/fd/*` link
 *     reads `socket:[<inode>]`. No external tool.
 *   - every other platform (macOS included): `lsof -nP -iTCP:<port>
 *     -sTCP:LISTEN -Fp`, whose `p<pid>` lines name the processes.
 *
 * Its limit: both read only what this user can see. Linux `/proc/net` lists
 * this process's network namespace, and the fds of another user's process are
 * unreadable; macOS lsof lists only processes this user may inspect. A Harper
 * in a container, behind a port forward, or run by another user is therefore
 * absent from the table, held by the forwarder (docker-proxy, ssh -L), or held
 * by a process this user cannot inspect. Callers refuse every one of those.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** What the listener table says about one TCP port. `pids` are distinct and sorted. */
export type ListenerRead =
  | { kind: "listeners"; pids: number[] }
  | { kind: "unavailable"; reason: string; remedy: string };

/** The lsof command line the non-Linux reader runs for `port`. */
export function lsofListenerArgs(port: number): string[] {
  return ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"];
}

/** What to do when the table does not show the listener to this user. */
export const LISTENER_VISIBILITY_REMEDY =
  "Run this command on the host where Harper runs, as the user that runs it. A Harper inside a container or "
  + "reached through a port forward (docker-proxy, ssh -L) is refused, never proven: run the command inside that "
  + "container or on that host instead.";

/**
 * Parse `lsof -Fp` output into the distinct listening pids, sorted. Only `p`
 * lines carry a pid; lsof's other field lines (`f<fd>` and the like) are
 * ignored. A `p` line that is not a positive integer makes the whole output
 * unusable (null): the caller refuses rather than guessing.
 */
export function parseLsofListenerPids(output: string): number[] | null {
  const pids = new Set<number>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("p")) continue;
    const pid = Number(line.slice(1));
    if (!/^p[0-9]+$/.test(line) || !Number.isSafeInteger(pid) || pid <= 0) return null;
    pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

/**
 * Parse one `/proc/net/tcp` or `/proc/net/tcp6` table into the socket inodes
 * LISTENING (state `0A`) on `port`. The local address is `<hex addr>:<hex
 * port>`; inode 0 (no owning socket) is skipped. A data row with fewer than 10
 * columns makes the table unusable (null).
 */
export function parseProcNetTcpListenInodes(table: string, port: number): string[] | null {
  const inodes: string[] = [];
  const rows = table.split("\n").slice(1);
  for (const row of rows) {
    const cols = row.trim().split(/\s+/);
    if (cols.length === 1 && cols[0] === "") continue;
    if (cols.length < 10) return null;
    const local = cols[1];
    const colon = local.lastIndexOf(":");
    if (colon < 0) return null;
    const localPort = Number.parseInt(local.slice(colon + 1), 16);
    if (cols[3] !== "0A" || localPort !== port) continue;
    if (!/^[0-9]+$/.test(cols[9])) return null;
    if (cols[9] !== "0") inodes.push(cols[9]);
  }
  return inodes;
}

/** The I/O the readers use; tests replace parts of it. */
export interface ListenerTableIo {
  platform: NodeJS.Platform;
  /** Run lsof with these arguments and return its stdout; throws as `execFileSync` does. */
  runLsof: (args: string[]) => string;
  readFile: (path: string) => string;
  readDir: (path: string) => string[];
  readLink: (path: string) => string;
}

const DEFAULT_IO: ListenerTableIo = {
  platform: process.platform,
  runLsof: (args) =>
    execFileSync("lsof", args, { encoding: "utf-8", timeout: 5_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] }),
  readFile: (path) => readFileSync(path, "utf-8"),
  readDir: (path) => readdirSync(path),
  readLink: (path) => readlinkSync(path),
};

/** The processes the OS lists as LISTENING on TCP `port` (see the module comment). */
export function readTcpListenerPids(port: number, io: Partial<ListenerTableIo> = {}): ListenerRead {
  const full: ListenerTableIo = { ...DEFAULT_IO, ...io };
  return full.platform === "linux" ? readFromProc(port, full) : readFromLsof(port, full);
}

function readFromLsof(port: number, io: ListenerTableIo): ListenerRead {
  const command = `lsof ${lsofListenerArgs(port).join(" ")}`;
  let output: string;
  try {
    output = io.runLsof(lsofListenerArgs(port));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return {
        kind: "unavailable",
        reason: `lsof is not installed or not on PATH, and this check reads the listener table with \`${command}\``,
        remedy: "Install lsof or put it on PATH (macOS ships it as /usr/sbin/lsof), then re-run this command on the host where Harper runs.",
      };
    }
    // lsof exits 1 with no output when no socket matches.
    if (err?.status === 1 && String(err?.stdout ?? "").trim() === "") return { kind: "listeners", pids: [] };
    const how = err?.signal ? `was stopped by ${err.signal}` : `exited ${err?.status ?? err?.code ?? "abnormally"}`;
    return {
      kind: "unavailable",
      reason: `\`${command}\` ${how}`,
      remedy: `Run \`${command}\` yourself to see why it fails, fix that, and re-run this command.`,
    };
  }
  const pids = parseLsofListenerPids(output);
  if (pids === null) {
    return { kind: "unavailable", reason: `\`${command}\` printed a pid line that is not a process id`, remedy: `Run \`${command}\` yourself and check its output.` };
  }
  return { kind: "listeners", pids };
}

function readFromProc(port: number, io: ListenerTableIo): ListenerRead {
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = io.readFile(table);
    } catch (err: any) {
      // A host with IPv6 disabled has no tcp6 table; the IPv4 table is required.
      if (table === "/proc/net/tcp6" && err?.code === "ENOENT") continue;
      return {
        kind: "unavailable",
        reason: `this check reads the listener table from ${table}, which cannot be read (${err?.code ?? err?.message})`,
        remedy: "Run this command on a Linux host with /proc mounted, as the user that runs Harper.",
      };
    }
    const found = parseProcNetTcpListenInodes(text, port);
    if (found === null) {
      return { kind: "unavailable", reason: `${table} has a row this check cannot parse`, remedy: `Check ${table}; this check reads its LISTEN rows.` };
    }
    for (const inode of found) inodes.add(inode);
  }
  if (inodes.size === 0) return { kind: "listeners", pids: [] };

  const owners = new Map<string, Set<number>>();
  let entries: string[];
  try {
    entries = io.readDir("/proc");
  } catch (err: any) {
    return {
      kind: "unavailable",
      reason: `this check finds socket owners under /proc, which cannot be listed (${err?.code ?? err?.message})`,
      remedy: "Run this command on a Linux host with /proc mounted, as the user that runs Harper.",
    };
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = io.readDir(`/proc/${entry}/fd`);
    } catch {
      continue; // another user's process, or one that exited: its sockets stay unowned below
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = io.readLink(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[([0-9]+)\]$/.exec(target);
      if (!match || !inodes.has(match[1])) continue;
      const set = owners.get(match[1]) ?? new Set<number>();
      set.add(Number(entry));
      owners.set(match[1], set);
    }
  }
  const unowned = [...inodes].filter((inode) => !owners.has(inode));
  if (unowned.length > 0) {
    return {
      kind: "unavailable",
      reason: `TCP port ${port} has a listening socket (inode ${unowned.join(", ")}) whose process this user cannot inspect in /proc/<pid>/fd`,
      remedy: LISTENER_VISIBILITY_REMEDY,
    };
  }
  const pids = new Set<number>();
  for (const set of owners.values()) for (const pid of set) pids.add(pid);
  return { kind: "listeners", pids: [...pids].sort((a, b) => a - b) };
}
