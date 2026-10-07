/**
 * stop-start-recovery.ts — the two decisions a `flair stop`/`flair start`
 * round-trip needs when it cannot fully resolve the daemon (flair#2350).
 *
 * The migration drill's failure chain:
 *   1. `flair stop` sends SIGTERM while a migration is mid-flight, then waits
 *      for the process to exit. On a loaded host that wait can expire: the
 *      daemon is alive but not answering, and the CLI died with a bare
 *      `Error: Process <pid> did not exit within 60000ms` stack trace.
 *   2. Harper removes `hdb.pid` in its own SIGTERM handler, so the next
 *      `flair start` sees "no pid recorded and the health check … did not
 *      respond" and refuses — with no remedy named.
 *
 * This module holds the decision behind the fix, kept out of the command
 * bodies so its branches are unit-testable without a daemon:
 *
 *   - `decideStartOnUnknown` — how `flair start` resolves the classifier's
 *     UNKNOWN "no pid + health silent" verdict. The health probe is a bounded
 *     /Health request; under load its 2s budget can fire before a loopback
 *     connect completes, so a port with NOTHING listening can read as
 *     "did not respond". Before refusing, `flair start` asks the narrower,
 *     decisive question directly (a TCP connect, `probePortListening`): a port
 *     whose connection is refused is free, and the start proceeds. A port
 *     that accepts one — or a probe that cannot decide — still refuses, and
 *     the refusal names the remedy.
 *
 * `unknown` is never `free`: an undetermined probe must not license a start,
 * the same discipline `daemon-liveness.ts` applies to an undetermined pid
 * liveness.
 */
import { connect } from "node:net";

/** What a direct TCP connect to the instance's HTTP port concluded. */
export type PortProbe = "free" | "listening" | "unknown";

/**
 * Classify a TCP connect outcome. `free` is returned ONLY for an errno that
 * says nothing accepted the connection — never for a timeout or an
 * undetermined error, which are `unknown` (and must not be read as `free`).
 */
export function classifyPortProbe(errCode: string | undefined, connected: boolean): PortProbe {
  if (connected) return "listening";
  if (errCode === "ECONNREFUSED" || errCode === "EHOSTUNREACH" || errCode === "ENETUNREACH") return "free";
  return "unknown";
}

/**
 * Open a TCP connection to `host:port` and report whether anything accepts it.
 * Bounded; the timer is the whole budget, so a silently-dropping socket cannot
 * hang the caller.
 */
export async function probePortListening(
  port: number,
  timeoutMs = 3_000,
  host = "127.0.0.1",
): Promise<PortProbe> {
  return await new Promise<PortProbe>((resolve) => {
    const socket = connect({ port, host });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PortProbe): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(() => finish("unknown"), timeoutMs);
    socket.once("connect", () => finish("listening"));
    socket.once("error", (err: NodeJS.ErrnoException) => finish(classifyPortProbe(err?.code, false)));
  });
}

export interface StartUnknownDecision {
  /** True when the start should proceed to boot; false when it must refuse. */
  proceed: boolean;
  /** The lines to print, in order. */
  lines: string[];
}

/**
 * Resolve the classifier's UNKNOWN verdict for `flair start`.
 *
 * `probe === "free"` (the port refuses every connection) means no instance is
 * holding it, so the start proceeds. Every other outcome — a listener, or a
 * probe that could not decide — refuses, and the lines name the remedy.
 */
export function decideStartOnUnknown(opts: { detail: string; port: number; probe: PortProbe }): StartUnknownDecision {
  const { detail, port, probe } = opts;
  if (probe === "free") {
    return {
      proceed: true,
      lines: [
        `⚠️  ${detail}`,
        `   Nothing is accepting connections on port ${port} — starting.`,
      ],
    };
  }
  const lines = [
    `⚠️  ${detail}`,
    `   Refusing to start — could not determine whether Flair is running.`,
  ];
  if (probe === "listening") {
    lines.push(`   Port ${port} is accepting connections. Stop what holds it, then start again:`);
    lines.push(`     flair stop --port ${port}`);
  } else {
    lines.push(`   The port could not be probed. Inspect the instance with 'flair doctor'.`);
  }
  return { proceed: false, lines };
}

