import type { ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { canonicalLexicalPath } from "./daemon-liveness.js";
import { readInitListenerRootPath } from "./init-listener-environ.js";
import type { OccupiedHarperListener } from "./init-occupied-listener.js";

export function initChildOwnsProcPort(pid: number, port: number, procRoot = "/proc"): boolean {
  try {
    const inodes = new Set<string>();
    for (const table of ["tcp", "tcp6"]) {
      const rows = readFileSync(join(procRoot, "net", table), "utf8").trim().split("\n").slice(1);
      for (const row of rows) {
        const fields = row.trim().split(/\s+/);
        if (fields[3] !== "0A" || parseInt(fields[1]?.split(":")[1] ?? "", 16) !== port) continue;
        if (!fields[9] || !/^[1-9]\d*$/.test(fields[9])) return false;
        inodes.add(fields[9]);
      }
    }
    if (inodes.size === 0) return false;
    const owned = new Set<string>();
    const fdDir = join(procRoot, String(pid), "fd");
    for (const fd of readdirSync(fdDir)) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(join(fdDir, fd)));
        if (match) owned.add(match[1]);
      } catch {}
    }
    return [...inodes].every(inode => owned.has(inode));
  } catch {
    return false;
  }
}

export function trackInitChild(child: ChildProcess, options: { platform?: NodeJS.Platform; procRoot?: string } = {}) {
  const pid = child.pid;
  const processGroup = process.platform === "win32" ? undefined : pid;
  let exited = false;
  child.once("exit", () => { exited = true; });
  child.once("error", () => { exited = true; });
  return {
    pid,
    processGroup,
    attributes(listener: OccupiedHarperListener, dataDir: string, freePorts: ReadonlySet<number>): boolean {
      if (!pid || exited || child.exitCode != null || child.signalCode != null || !freePorts.has(listener.port)) return false;
      if (listener.pids.length > 1) return false;
      if (listener.pids.some(holder => holder !== pid)) return false;
      if ((options.platform ?? process.platform) === "linux") {
        if (!initChildOwnsProcPort(pid, listener.port, options.procRoot)) return false;
      } else if (!listener.pidsKnown || listener.pids.length !== 1) return false;
      if (listener.dataDirs.some(dir => canonicalLexicalPath(dir) !== canonicalLexicalPath(dataDir))) return false;
      try {
        process.kill(pid, 0);
        if (processGroup) process.kill(-processGroup, 0);
      } catch {
        return false;
      }
      const root = readInitListenerRootPath(pid);
      return !root.environReadable || (root.rootPath !== null && canonicalLexicalPath(root.rootPath) === canonicalLexicalPath(dataDir));
    },
  };
}
