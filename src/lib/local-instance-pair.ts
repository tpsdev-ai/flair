/**
 * local-instance-pair.ts — the ONE check that pairs an operations API endpoint
 * with an HTTP port on this host.
 *
 * Shared by the local delete paths (`memory hygiene --apply`, `agent remove`,
 * via src/lib/local-delete-instance.ts, flair#2225) and by `flair doctor`'s
 * Agent roster and home reads (src/cli.ts `verifyDoctorRosterInstance`,
 * flair#2483), so the rule is written once.
 *
 * What it checks:
 *   1. it asks the loopback ops endpoint on `opsPort` for Harper's
 *      `get_configuration`, and continues only when that configuration
 *      - records a usable `http.port`,
 *      - binds that HTTP port on loopback or on all interfaces (127.0.0.1,
 *        localhost, 0.0.0.0, [::], or a bare port), and
 *      - records `operationsApi.network.port` equal to `opsPort`, the port asked;
 *   2. it reads the OS listener table (src/lib/listener-table.ts: `/proc` on
 *      Linux, `lsof` elsewhere) for `opsPort` and for that HTTP port, and
 *      requires exactly one process listening on each (flair#2526);
 *   3. it requires each listener's command line to be a Harper command line
 *      (`isHarperProcessCommandLine`), so a forwarder holding a port is
 *      refused;
 *   4. it requires the two listeners to be the SAME process.
 * Only then does it report the configured HTTP port. `flair doctor` requires it
 * to equal the HTTP port doctor probed. The delete paths compare it with
 * `--port` only when `--port` is given; otherwise they address that port.
 *
 * Nothing is sent to the HTTP port: the admin credential goes only to the ops
 * endpoint the caller named, and a caller sends it to the HTTP port only after
 * this check has proven the port. No PID file and no process id an endpoint
 * reports about itself is evidence (Harper's own `system_information` pid is
 * read from its `hdb.pid`).
 *
 * Every other outcome is `unproven`, with a detail naming which condition
 * failed and, where the caller's own remedy would not fit, a `remedy`.
 *
 * Its limits: the listener table shows only what this user can see, so a Harper
 * run by another user, inside a container, or reached through a port forward
 * (docker-proxy, ssh -L) is refused, never proven. The command-line check is
 * what `ps`/`/proc` report; it does not authenticate the program.
 */
import { harperPortValue } from "./harper-port-value.js";
import { isHarperProcessCommandLine } from "./daemon-liveness.js";
import { readTcpListenerPids, LISTENER_VISIBILITY_REMEDY, type ListenerRead } from "./listener-table.js";
import { defaultReadProcessCmdline } from "./upgrade-exec-path.js";

/** The host halves of an `http.port` binding that bind on loopback or on all interfaces. */
const LOCAL_HTTP_BIND_HOSTS = ["127.0.0.1", "localhost", "0.0.0.0", "[::]", ""];

/** The outcome of {@link proveLocalInstancePair}. */
export type LocalInstancePairProof =
  | { kind: "proven"; httpPort: number }
  | { kind: "unproven"; status: number | null; detail: string; remedy?: string };

/** The OS reads behind steps 2 and 3. */
export interface InstancePairOsReads {
  /** The processes the OS lists as LISTENING on a TCP port. */
  listeners: (port: number) => ListenerRead;
  /** A process's command line, or null when it cannot be read. */
  commandLine: (pid: number) => string | null;
}

/** Injectable seams for tests; production callers use the global `fetch` and the OS reads. */
export interface LocalInstancePairDeps {
  fetchImpl?: typeof fetch;
  osReads?: Partial<InstancePairOsReads>;
}

const DEFAULT_OS_READS: InstancePairOsReads = {
  listeners: (port) => readTcpListenerPids(port),
  commandLine: defaultReadProcessCmdline,
};

/**
 * Test seam for callers that cannot pass `deps` (the CLI commands run
 * in-process by test/unit-isolated). Production never sets it.
 */
let osReadsForTests: Partial<InstancePairOsReads> | null = null;

export function setInstancePairOsReadsForTests(reads: Partial<InstancePairOsReads> | null): void {
  osReadsForTests = reads;
}

/**
 * Ask the loopback ops endpoint on `opsPort` for its configuration, then prove
 * from the OS listener table that one Harper process listens on both that ops
 * port and the configured HTTP port (see the module comment). `authorization`
 * is the full `Authorization` header value; it is sent only to `opsPort`.
 * `status` is the HTTP status of a non-2xx answer, else null.
 */
export async function proveLocalInstancePair(
  opsPort: number,
  authorization: string,
  deps: LocalInstancePairDeps = {},
): Promise<LocalInstancePairProof> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const os: InstancePairOsReads = { ...DEFAULT_OS_READS, ...osReadsForTests, ...deps.osReads };
  const unproven = (detail: string, status: number | null = null, remedy?: string): LocalInstancePairProof =>
    remedy === undefined ? { kind: "unproven", status, detail } : { kind: "unproven", status, detail, remedy };

  // 1. The ops endpoint's own configuration.
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ operation: "get_configuration" }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    return unproven("the configuration request got no answer");
  }
  if (!response.ok) return unproven(`the configuration request answered HTTP ${response.status}`, response.status);
  let config: any;
  try {
    config = await response.json();
  } catch {
    return unproven("the configuration answer is not JSON");
  }
  const httpPort = harperPortValue(config?.http?.port);
  if (httpPort === null) return unproven("its configuration records no usable HTTP port");
  const configuredOpsPort = harperPortValue(config?.operationsApi?.network?.port);
  if (configuredOpsPort !== opsPort) {
    return unproven(`its configuration records ops port ${configuredOpsPort ?? "none"}, not ${opsPort}`);
  }
  const binding = String(config?.http?.port ?? "");
  const separator = binding.lastIndexOf(":");
  const host = separator < 0 ? "127.0.0.1" : binding.slice(0, separator);
  if (!LOCAL_HTTP_BIND_HOSTS.includes(host)) {
    return unproven(`its configuration binds HTTP to ${host}, not loopback or all interfaces`);
  }

  // 2. One process listens on each port.
  const opsListener = soleListener(os.listeners(opsPort), "ops", opsPort);
  if (!("pid" in opsListener)) return opsListener;
  const httpListener = soleListener(os.listeners(httpPort), "HTTP", httpPort);
  if (!("pid" in httpListener)) return httpListener;

  // 3. Each is a Harper process, not a forwarder holding the port.
  const notHarper = harperListenerRefusal(os, opsListener.pid, "ops", opsPort)
    ?? (httpListener.pid === opsListener.pid ? null : harperListenerRefusal(os, httpListener.pid, "HTTP", httpPort));
  if (notHarper !== null) return notHarper;

  // 4. They are the same process.
  if (opsListener.pid !== httpListener.pid) {
    return unproven(
      `the process listening on ops port ${opsPort} is ${opsListener.pid} and the process listening on HTTP port ` +
        `${httpPort} is ${httpListener.pid}, so they are not the same running instance`,
    );
  }
  return { kind: "proven", httpPort };
}

/** An `unproven` proof when `pid`'s command line cannot be read or is not Harper's, else null. */
function harperListenerRefusal(os: InstancePairOsReads, pid: number, label: "ops" | "HTTP", port: number): LocalInstancePairProof | null {
  const commandLine = os.commandLine(pid);
  if (commandLine === null) {
    return { kind: "unproven", status: null, detail: `the command line of process ${pid}, listening on ${label} port ${port}, cannot be read`, remedy: LISTENER_VISIBILITY_REMEDY };
  }
  if (isHarperProcessCommandLine(commandLine)) return null;
  return {
    kind: "unproven",
    status: null,
    detail: `process ${pid} (${programName(commandLine)}), listening on ${label} port ${port}, is not a Harper process, as when a port forwarder (docker-proxy, ssh -L) holds that port`,
    remedy: LISTENER_VISIBILITY_REMEDY,
  };
}

/** The one process listening on `port`, or an `unproven` proof naming why not. */
function soleListener(read: ListenerRead, label: "ops" | "HTTP", port: number): { pid: number } | LocalInstancePairProof {
  if (read.kind === "unavailable") {
    return { kind: "unproven", status: null, detail: `the listener table for ${label} port ${port} cannot be read: ${read.reason}`, remedy: read.remedy };
  }
  if (read.pids.length === 0) {
    return {
      kind: "unproven",
      status: null,
      detail: `the listener table shows no process this user can see listening on ${label} port ${port}`,
      remedy: label === "HTTP"
        ? `Start the instance that should serve HTTP port ${port}, or correct its configuration and restart it. ${LISTENER_VISIBILITY_REMEDY}`
        : LISTENER_VISIBILITY_REMEDY,
    };
  }
  if (read.pids.length > 1) {
    return {
      kind: "unproven",
      status: null,
      detail: `processes ${read.pids.join(", ")} all listen on ${label} port ${port}, so the one serving it cannot be named`,
    };
  }
  return { pid: read.pids[0] };
}

/** The basename of a command line's first argument (never the arguments). */
function programName(commandLine: string): string {
  const first = commandLine.includes("\u0000") ? commandLine.split("\u0000")[0] : commandLine.trim().split(/\s+/)[0];
  return first.split("/").pop() || "unknown program";
}
