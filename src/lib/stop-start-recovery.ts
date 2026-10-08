import { connect } from "node:net";
import { healthIndicatesListener, type DaemonEvidence } from "./daemon-liveness.js";

/** What a direct TCP connect to the instance's HTTP port concluded. */
export type PortProbe = "free" | "listening" | "unknown";

export function classifyPortProbe(errCode: string | undefined, connected: boolean): PortProbe {
  if (connected) return "listening";
  if (errCode === "ECONNREFUSED") return "free";
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

export function decideStartOnUnknown(opts: {
  evidence: DaemonEvidence;
  detail: string;
  port: number;
  probe: PortProbe;
}): StartUnknownDecision {
  const { evidence, detail, port, probe } = opts;
  const pid = evidence.pidfile.kind === "present" ? evidence.pidfile.pid : evidence.lastKnownPid;
  const ownerExited = evidence.dataDirUnsafe === null && evidence.pidfile.kind !== "unreadable"
    && pid !== undefined && evidence.pidLiveness?.kind === "gone"
    && evidence.sidecar?.kind !== "unreadable"
    && (evidence.sidecar?.kind !== "present" || evidence.sidecarLiveness?.kind === "gone")
    && !healthIndicatesListener(evidence.health);
  if (ownerExited && probe === "free") {
    return { proceed: true, lines: [`⚠️  ${detail}`, `   Recorded owner has exited; connection to port ${port} was refused — starting.`] };
  }
  return {
    proceed: false,
    lines: [
      `⚠️  ${detail}`,
      `   Refusing to start — could not determine whether Flair is running.`,
      `   Inspect the instance with 'flair doctor'.`,
    ],
  };
}
