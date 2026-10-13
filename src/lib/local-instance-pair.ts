/**
 * local-instance-pair.ts — the ONE check that an operations API endpoint and an
 * HTTP port on this host are the SAME running Harper process, used to pair an
 * ops endpoint with an HTTP port.
 *
 * Shared by the local delete paths (`memory hygiene --apply`, `agent remove`,
 * via src/lib/local-delete-instance.ts, flair#2225) and by `flair doctor`'s
 * Agent roster and home reads (src/cli.ts `verifyDoctorRosterInstance`,
 * flair#2483), so the rule is written once.
 *
 * What it checks:
 *   1. it asks the loopback ops endpoint on `opsPort` for Harper's
 *      `get_configuration`, and accepts only when that configuration
 *      - records a usable `http.port`,
 *      - binds that HTTP port on loopback or on all interfaces (127.0.0.1,
 *        localhost, 0.0.0.0, [::], or a bare port), and
 *      - records `operationsApi.network.port` equal to `opsPort`, the port asked;
 *   2. it resolves the live Harper process id serving the ops endpoint: the
 *      `harperdb_processes.core[0].pid` its `system_information` reports
 *      (exactly as src/lib/mcp-enable.ts's `checkTargetRunsFromConfig` and
 *      `captureBootDiscriminator` read it), or — when that answer carries no
 *      pid — the pid the instance's own `<rootPath>/hdb.pid` names when that
 *      process is alive. When both sources carry a pid, they must agree;
 *   3. it asks the configured HTTP port for `/HealthDetail` and reads the
 *      `pid` that resource reports (`process.pid` — the process serving that
 *      port); the pair is proven ONLY when the ops process id from step 2 and
 *      that pid are equal. Configured ports alone no longer establish it: a
 *      configuration edited without a restart (or otherwise stale) can name
 *      ports the live process is not serving.
 * It then reports the configured HTTP port. `flair doctor` requires it to equal
 * the HTTP port doctor probed. The delete paths compare it with `--port` only
 * when `--port` is given; otherwise they address that configured port. A failed
 * request, a non-2xx answer, a body that is not JSON, any of the configuration
 * conditions above unmet, no process id from either source, a PID-file pid that
 * is not alive, two sources that disagree, or two endpoints that disagree is
 * `unproven`, with a detail naming which.
 *
 * Its limit: both endpoints are reached over loopback, so a pair that forwards
 * one remote process onto two local ports reports the same id and is accepted.
 * The PID-file fallback trusts the file the Harper process writes under its
 * configured root; a pid it names is accepted only while that process is alive.
 */
import { join } from "node:path";
import { harperPortValue } from "./harper-port-value.js";
import { readPidfile } from "./pidfile.js";
import type { PidfileRead } from "./daemon-liveness.js";

/** The host halves of an `http.port` binding that bind on loopback or on all interfaces. */
const LOCAL_HTTP_BIND_HOSTS = ["127.0.0.1", "localhost", "0.0.0.0", "[::]", ""];

/** The outcome of {@link proveLocalInstancePair}. */
export type LocalInstancePairProof =
  | { kind: "proven"; httpPort: number }
  | { kind: "unproven"; status: number | null; detail: string };

/** Injectable seams for tests; production callers use the global `fetch` and
 *  a signal-0 liveness probe. */
export interface LocalInstancePairDeps {
  fetchImpl?: typeof fetch;
  /** Liveness probe for a PID-file pid (default: `kill(pid, 0)`). */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Ask the loopback ops endpoint on `opsPort` for its configuration and its live
 * Harper process id, ask the configured HTTP port for the process id it serves,
 * and report the HTTP port only when the two endpoints are one running process
 * (see the module comment). `authorization` is the full `Authorization` header
 * value. `status` is the HTTP status of a non-2xx answer, else null.
 */
export async function proveLocalInstancePair(
  opsPort: number,
  authorization: string,
  deps: LocalInstancePairDeps = {},
): Promise<LocalInstancePairProof> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const isPidAlive = deps.isPidAlive ?? isPidAliveByKill;
  const unproven = (detail: string, status: number | null = null): LocalInstancePairProof =>
    ({ kind: "unproven", status, detail });

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

  // 2. The live Harper process id serving the ops endpoint.
  const ops = await resolveOpsProcessId(fetchImpl, opsPort, authorization, config, isPidAlive);
  if (!("pid" in ops)) return ops;

  // 3. The live process id the configured HTTP port reports.
  const http = await readHttpProcessId(fetchImpl, httpPort, authorization);
  if (!("pid" in http)) return http;

  if (ops.pid !== http.pid) {
    return unproven(
      `the operations API reports Harper process ${ops.pid} and the HTTP endpoint on port ${httpPort} reports ` +
        `process ${http.pid}, so they are not the same running instance`,
    );
  }
  return { kind: "proven", httpPort };
}

/** Signal-0 liveness: a pid the probe may not signal is NOT reported alive. */
function isPidAliveByKill(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The live Harper process id serving the ops endpoint: the id its
 * `system_information` reports, or, when that answer carries no usable pid, the
 * alive pid the instance's own `<rootPath>/hdb.pid` names; the two must agree
 * when both carry one. A `system_information` request that fails refuses; two
 * sources that disagree, or no pid from either, refuses.
 */
async function resolveOpsProcessId(
  fetchImpl: typeof fetch,
  opsPort: number,
  authorization: string,
  config: any,
  isPidAlive: (pid: number) => boolean,
): Promise<{ pid: number } | LocalInstancePairProof> {
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ operation: "system_information", attributes: ["harperdb_processes"] }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    return { kind: "unproven", status: null, detail: "the operations API got no answer to its process-identity request" };
  }
  if (!response.ok) {
    return { kind: "unproven", status: response.status, detail: `the process-identity request answered HTTP ${response.status}` };
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    return { kind: "unproven", status: null, detail: "the process-identity answer is not JSON" };
  }
  const reported = data?.harperdb_processes?.core?.[0]?.pid;
  const systemInformationPid = isUsablePid(reported) ? reported : null;

  // The PID file of the instance whose configuration this ops endpoint reports.
  const root = typeof config?.rootPath === "string" && config.rootPath !== "" ? config.rootPath : null;
  const pidfile: PidfileRead = root === null ? { kind: "absent" } : readPidfile(root);
  let pidfilePid: number | null = null;
  if (pidfile.kind === "present") {
    pidfilePid = pidfile.pid;
    if (!isPidAlive(pidfilePid)) {
      return { kind: "unproven", status: null, detail: `the PID file ${join(root!, "hdb.pid")} names process ${pidfilePid}, which is not alive` };
    }
  }

  if (systemInformationPid !== null && pidfilePid !== null && systemInformationPid !== pidfilePid) {
    return {
      kind: "unproven",
      status: null,
      detail: `its operations API reports Harper process ${systemInformationPid} but its PID file names process ${pidfilePid}, so they disagree`,
    };
  }
  const pid = systemInformationPid ?? pidfilePid;
  if (pid === null) {
    const unread = pidfile.kind === "unreadable" ? ` (${pidfile.reason})` : "";
    return { kind: "unproven", status: null, detail: `its operations API reports no running Harper process id and its PID file names none${unread}` };
  }
  return { pid };
}

/** A JSON value usable as a process id. */
function isUsablePid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** The process id the HTTP endpoint on `httpPort` reports, or an `unproven` proof naming why not. */
async function readHttpProcessId(
  fetchImpl: typeof fetch,
  httpPort: number,
  authorization: string,
): Promise<{ pid: number } | LocalInstancePairProof> {
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${httpPort}/HealthDetail`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { kind: "unproven", status: null, detail: `the HTTP endpoint on port ${httpPort} got no answer to its health request` };
  }
  if (!response.ok) {
    return { kind: "unproven", status: response.status, detail: `the health request to the HTTP endpoint on port ${httpPort} answered HTTP ${response.status}` };
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    return { kind: "unproven", status: null, detail: `the health answer from the HTTP endpoint on port ${httpPort} is not JSON` };
  }
  const pid = data?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { kind: "unproven", status: null, detail: `the HTTP endpoint on port ${httpPort} reports no running process id` };
  }
  return { pid };
}
