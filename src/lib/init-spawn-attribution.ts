import type { ChildProcess } from "node:child_process";
import { canonicalLexicalPath } from "./daemon-liveness.js";
import { readInitListenerRootPath } from "./init-listener-environ.js";
import type { OccupiedHarperListener } from "./init-occupied-listener.js";

export function trackInitChild(child: ChildProcess) {
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
