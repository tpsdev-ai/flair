/**
 * local-instance-pair.ts — the ONE check that pairs an operations API endpoint
 * with an HTTP port on this host.
 *
 * Shared by the local delete paths (`memory hygiene --apply`, `agent remove`,
 * via src/lib/local-delete-instance.ts, flair#2225) and by `flair doctor`
 * (src/cli.ts `verifyDoctorRosterInstance`, flair#2483), so the rule is
 * written once.
 *
 * What it checks:
 *   1. it asks the loopback ops endpoint on `opsPort` for Harper's
 *      `get_configuration`, and continues only when that configuration
 *      - records a usable `http.port`,
 *      - binds that HTTP port on loopback or on all interfaces (127.0.0.1,
 *        localhost, 0.0.0.0, [::], or a bare port), and
 *      - records `operationsApi.network.port` equal to `opsPort`, the port asked;
 *   2. it reads the OS listener table (src/lib/listener-table.ts: `/proc` on
 *      Linux, `lsof` elsewhere) for `opsPort` and for that HTTP port, requires
 *      exactly one listening process on each, and reads each one's birth
 *      identity (pid plus start time: `/proc/<pid>/stat` on Linux, `ps -o
 *      lstart=` elsewhere) (flair#2526);
 *   3. it requires each listener to have a recognized Harper command line
 *      (`isHarperProcessCommandLine`), so a forwarder holding a port is refused;
 *   4. it requires the two listeners to be one pid;
 *   5. it reads both listeners and their birth identities again and requires
 *      them unchanged, so a process replaced between reads (a restart that
 *      reused the pid) is refused.
 * Only then does it report the configured HTTP port. `flair doctor` requires it
 * to equal the HTTP port doctor probed. The delete paths compare it with
 * `--port` only when `--port` is given; otherwise they address that port.
 *
 * Nothing is sent to the HTTP port: the admin credential goes only to the ops
 * endpoint the caller named. Both callers send a credential to the HTTP port
 * only after this check proves it, or, in doctor when no usable admin
 * credential can run it, after {@link proveLocalHarperListener} proves that
 * port's own listener (src/commands/doctor.ts `decideDoctorPairGate`).
 * No PID file and no process id an endpoint reports about itself is evidence
 * (Harper's own `system_information` pid is read from its `hdb.pid`).
 *
 * Every other outcome is `unproven`, with a detail naming which condition
 * failed and, for the listener-table conditions except two different pids, a
 * `remedy`; callers supply their own remedy otherwise.
 *
 * Its limits: the listener table shows only what this CLI can see, so a Harper
 * listener outside that view (another network namespace or container, or a
 * user this CLI may not inspect) is refused, and so is a port reached through
 * a forward (docker-proxy, ssh -L): refused, never proven. The command-line
 * check reads what `ps`/`/proc` report; it does not authenticate the program.
 * The macOS start time has one-second resolution.
 */
import { harperPortValue } from "./harper-port-value.js";
import { isHarperProcessCommandLine } from "./daemon-liveness.js";
import { readProcessBirth, readTcpListenerPids, LISTENER_VISIBILITY_REMEDY, type BirthRead, type ListenerRead } from "./listener-table.js";
import { defaultReadProcessCmdline } from "./upgrade-exec-path.js";

/** The host halves of an `http.port` binding that bind on loopback or on all interfaces. */
const LOCAL_HTTP_BIND_HOSTS = ["127.0.0.1", "localhost", "0.0.0.0", "[::]", ""];

/** The outcome of {@link proveLocalInstancePair}. */
export type LocalInstancePairProof =
  | { kind: "proven"; httpPort: number }
  | { kind: "unproven"; status: number | null; detail: string; remedy?: string };

/** The OS reads behind steps 2 to 5. */
export interface InstancePairOsReads {
  /** The processes the OS lists as LISTENING on a TCP port. */
  listeners: (port: number) => ListenerRead;
  /** A process's birth identity (pid plus start time). */
  birth: (pid: number) => BirthRead;
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
  birth: (pid) => readProcessBirth(pid),
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

  // 2. One process listens on each port; note each one's birth identity.
  const first = observeListeners(os, opsPort, httpPort);
  if (!("ops" in first)) return first;

  // 3. Each has a recognized Harper command line, not a forwarder's.
  const notHarper = harperListenerRefusal(os, first.ops.pid, "ops", opsPort)
    ?? (first.http.pid === first.ops.pid ? null : harperListenerRefusal(os, first.http.pid, "HTTP", httpPort));
  if (notHarper !== null) return notHarper;

  // 4. They are one pid.
  if (first.ops.pid !== first.http.pid) {
    return unproven(
      `the process listening on ops port ${opsPort} is ${first.ops.pid} and the process listening on HTTP port ` +
        `${httpPort} is ${first.http.pid}, so they are not the same running instance`,
    );
  }

  // 5. Nothing changed since step 2: the same pid and birth on both ports.
  const second = observeListeners(os, opsPort, httpPort);
  if (!("ops" in second)) return second;
  for (const [label, port, before, after] of [
    ["ops", opsPort, first.ops, second.ops],
    ["HTTP", httpPort, first.http, second.http],
  ] as const) {
    if (before.birth !== after.birth) {
      return unproven(
        `the process listening on ${label} port ${port} changed between two reads (${before.birth}, then ${after.birth}), ` +
          `so it is not proven to be the process whose command line was checked`,
        null,
        RESTARTING_REMEDY,
      );
    }
  }
  return { kind: "proven", httpPort };
}

/**
 * The credential-free half of the check, for one HTTP port (flair#2526): one
 * process listens on `httpPort`, it has a recognized Harper command line, and
 * its pid and start time are unchanged on a second read. Nothing is sent to
 * any port. It proves the port's listener is a Harper process, not which ops
 * endpoint it pairs with: `flair doctor` uses it only when the full check
 * could not read the ops configuration for want of a usable admin credential,
 * and then only for requests to that HTTP port.
 */
export function proveLocalHarperListener(httpPort: number, deps: Pick<LocalInstancePairDeps, "osReads"> = {}): LocalInstancePairProof {
  const os: InstancePairOsReads = { ...DEFAULT_OS_READS, ...osReadsForTests, ...deps.osReads };
  const first = observeListener(os, "HTTP", httpPort);
  if (!("birth" in first)) return first;
  const notHarper = harperListenerRefusal(os, first.pid, "HTTP", httpPort);
  if (notHarper !== null) return notHarper;
  const second = observeListener(os, "HTTP", httpPort);
  if (!("birth" in second)) return second;
  if (first.birth !== second.birth) {
    return {
      kind: "unproven",
      status: null,
      detail: `the process listening on HTTP port ${httpPort} changed between two reads (${first.birth}, then ${second.birth}), ` +
        `so it is not proven to be the process whose command line was checked`,
      remedy: RESTARTING_REMEDY,
    };
  }
  return { kind: "proven", httpPort };
}

/** What to do when a listener changed under the check. */
const RESTARTING_REMEDY = "Re-run this command once the instance is running and not restarting.";

/** One listener observation: its pid and birth identity (`<pid>@<start>`). */
interface ListenerObservation {
  pid: number;
  birth: string;
}

/** Read the sole listener on each port and its birth identity, or an `unproven` proof naming why not. */
function observeListeners(
  os: InstancePairOsReads,
  opsPort: number,
  httpPort: number,
): { ops: ListenerObservation; http: ListenerObservation } | LocalInstancePairProof {
  const ops = observeListener(os, "ops", opsPort);
  if (!("birth" in ops)) return ops;
  const http = observeListener(os, "HTTP", httpPort);
  if (!("birth" in http)) return http;
  return { ops, http };
}

function observeListener(os: InstancePairOsReads, label: "ops" | "HTTP", port: number): ListenerObservation | LocalInstancePairProof {
  const sole = soleListener(os.listeners(port), label, port);
  if (!("pid" in sole)) return sole;
  const birth = os.birth(sole.pid);
  if (birth.kind === "unavailable") {
    return { kind: "unproven", status: null, detail: `the process listening on ${label} port ${port} has no readable birth identity: ${birth.reason}`, remedy: birth.remedy };
  }
  return { pid: sole.pid, birth: birth.id };
}

/** An `unproven` proof when `pid`'s command line cannot be read or is not a recognized Harper one, else null. */
function harperListenerRefusal(os: InstancePairOsReads, pid: number, label: "ops" | "HTTP", port: number): LocalInstancePairProof | null {
  const commandLine = os.commandLine(pid);
  if (commandLine === null) {
    return { kind: "unproven", status: null, detail: `the command line of process ${pid}, listening on ${label} port ${port}, cannot be read`, remedy: LISTENER_VISIBILITY_REMEDY };
  }
  if (isHarperProcessCommandLine(commandLine)) return null;
  return {
    kind: "unproven",
    status: null,
    detail: `process ${pid} (${programName(commandLine)}), listening on ${label} port ${port}, does not have a recognized Harper command line, as when a port forwarder (docker-proxy, ssh -L) holds that port`,
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
      detail: `the listener table shows no process this CLI can see listening on ${label} port ${port}`,
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
      remedy: `Stop every listener on ${label} port ${port} but Harper's own, then re-run this command.`,
    };
  }
  return { pid: read.pids[0] };
}

/** The basename of a command line's first argument (never the arguments). */
function programName(commandLine: string): string {
  const first = commandLine.includes("\u0000") ? commandLine.split("\u0000")[0] : commandLine.trim().split(/\s+/)[0];
  return first.split("/").pop() || "unknown program";
}
