// flair#2568 — a stub Harper child for `stopHarper`/`stopHarpers` tests that
// need no real Harper. Shared by test/unit/harper-lifecycle-budgets.test.ts and
// the hook fixture that test writes and runs under a child `bun test`.
import { EventEmitter } from "node:events";
import type { HarperInstance } from "./harper-lifecycle.js";

/**
 * A stopped-by-signal stub instance. `exitAfterMs` null = the child never exits
 * (the stop stalls in `terminate`); a number = it emits `exit` that long after
 * the first kill signal. No install dir, so a stop has nothing else to wait on.
 */
export function stubHarperInstance(pid: number, exitAfterMs: number | null): HarperInstance {
  const proc = new EventEmitter() as unknown as NonNullable<HarperInstance["process"]>;
  let signalled = false;
  Object.assign(proc, {
    pid,
    exitCode: null,
    signalCode: null,
    kill: () => {
      if (signalled || exitAfterMs === null) return true;
      signalled = true;
      setTimeout(() => {
        Object.assign(proc, { exitCode: 0 });
        proc.emit("exit", 0, null);
      }, exitAfterMs);
      return true;
    },
  });
  return {
    httpURL: "",
    opsURL: "",
    installDir: "",
    process: proc,
    admin: { username: "admin", password: "x" },
    external: false,
    ownsInstallDir: false,
  };
}
