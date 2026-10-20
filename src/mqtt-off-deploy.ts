/**
 * mqtt-off-deploy.ts — the component-deployment channel's MQTT-off step
 * (`flair deploy`, `flair upgrade --target`; called by deploy() in
 * src/deploy.ts).
 *
 * A component's config.yaml cannot set Harper's MQTT listeners off: `mqtt` is
 * a section of the instance's ROOT configuration (config-root.schema.json),
 * not of an application's (config-app.schema.json), and an application that
 * lists `mqtt` only adds a handler of its own. Flair's local spawns set the
 * root section through HARPER_SET_CONFIG and MQTT_* variables; a component
 * deployment does not go through those spawns. So the channel sets the
 * instance's `mqtt` section through the target's operations API, and requests
 * the worker restart that applies it:
 *
 *   1. Before the deploy — applyMqttOffConfiguration: `set_configuration` with
 *      MQTT_DISABLED_SET_CONFIGURATION (`mqtt.network.port` and
 *      `mqtt.network.securePort` null, `mqtt.webSocket` false), sent with the
 *      deploy's Basic credential to the operations API URL the caller
 *      resolved, replicated to the cluster's nodes when the deploy is. The
 *      origin refusing it, or a node the replicated answer names as failed,
 *      stops the deploy before anything is deployed. A standalone instance (no
 *      replication) is set on its own.
 *
 *   2. After the deploy's restart — completeMqttOff. Harper applies a changed
 *      `mqtt` section when the HTTP worker threads that start the MQTT
 *      listeners restart. The deploy's own restart covers them, except for a
 *      fresh isolated deploy: when the root configuration marks the
 *      application `isolated` and Harper does not find it already active,
 *      Harper restarts only that application's dedicated worker
 *      (components/operations.js `restartScope`;
 *      server/threads/manageThreads.js `restartWorkers` skips the shared
 *      workers); for an application it finds already active it restarts every
 *      worker. The step cannot tell which happened, so it requests the shared
 *      workers' restart for every isolated application. This step:
 *        - reads the target's configuration through its operations API: an
 *          answer that is not a recognizable root configuration
 *          (rootConfigurationProblem) is reported as not confirmed, never as
 *          off, and the saved `mqtt` section must show the MQTT-off values
 *          (mqttOffConfirmed, mismatches by field name and category);
 *        - when the application is isolated, requests the shared worker
 *          threads' restart through `restart_service` (`scope: ""`, Harper's
 *          pool scope; replicated when the deploy is) and follows Harper's job:
 *          a job read that does not succeed is refused before its body is
 *          parsed, only Harper's exact completed-job message for the requested
 *          job id counts as completed (isCompletedJobMessage), and any other
 *          failure the job reports fails the step, with every node its result
 *          lists without Harper's completed-job message
 *          (reportedRestartFailure); nodes are judged as that result lists
 *          them, not compared with the nodes the configuration answer named.
 *          A completed job is not proof that
 *          a node's workers restarted: Harper sends a node's restart-complete
 *          from a `finally` (bin/restart.ts) and drops the worker
 *          replacement's outcome;
 *        - reports, and claims nothing else: "MQTT listeners configured off on
 *          <nodes>; shared workers restart requested (<job and per-node
 *          outcomes>); the saved configuration on <target ops host> reads off.
 *          Listeners stop when each node's workers restart; flair does not
 *          probe them. To confirm on a node, connect an MQTT client to its MQTT
 *          ports or WebSocket path."
 *
 * URLs: the deploy target and its operations API URL must be http or https
 * URLs with a host, and nothing but scheme, host, port and path — any other
 * scheme, a URL without a host, a user name, password, query or fragment is
 * refused before anything is sent or printed (assertSafeUrl). Every URL these
 * MQTT-off steps print goes through safeUrl, including the operations API URL it
 * names for a cluster node (peerOpsUrl), which it builds only for a node name
 * that is a valid host name or IP address. The operations API calls follow no
 * redirect: a 3xx answer fails by its status.
 *
 * Output: the errors and progress lines of these steps quote a remote
 * answer's HTTP status code, a restart job's id (only when it is a plain token)
 * and state (only Harper's ERROR, PENDING or IN_PROGRESS), and cluster node
 * names as its answers give them (only when they are valid host names or IP
 * addresses); never its body, reason phrase, a job's message, a configuration
 * value or a transport error's text. This covers only these steps: the Harper
 * deploy between them (deploy() runs Harper's CLI) streams that child's output
 * as it comes.
 */
import { isIP } from "node:net";
import { MQTT_DISABLED_SET_CONFIGURATION, mqttOffConfirmed, rootConfigurationProblem } from "./lib/mqtt-config.js";

/** The operations-API request that turns every MQTT listener off on a deploy target. */
export function buildMqttOffOperation(replicated: boolean): Record<string, unknown> {
  return {
    operation: "set_configuration",
    ...MQTT_DISABLED_SET_CONFIGURATION,
    ...(replicated ? { replicated: true } : {}),
  };
}

/** The operations-API request that restarts the shared HTTP worker threads (Harper's pool scope). */
export function buildSharedWorkerRestartOperation(replicated: boolean): Record<string, unknown> {
  return {
    operation: "restart_service",
    service: "http_workers",
    scope: "",
    ...(replicated ? { replicated: true } : {}),
  };
}

/**
 * What a Harper instance without replication answers a `replicated: true`
 * operation with (harper server/Server.ts, the default `server.replication`).
 * Such a standalone instance is set or restarted on its own.
 */
export const REPLICATION_NOT_IMPLEMENTED = "Replication not implemented";

/**
 * The message Harper's job runner gives a job that completed
 * (server/jobs/jobProcess.ts: `'Successfully completed job: ' + JOB_ID`), and
 * nothing else: exactly that text, then the job's id and nothing after it.
 */
const JOB_COMPLETED_PREFIX = "Successfully completed job: ";

/** A Harper job id as a cluster node's job record carries it: a plain token. */
const JOB_ID_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Whether `message` is Harper's completed-job message: for the requested job,
 * exactly `Successfully completed job: <jobId>`; for a cluster node's own job
 * (whose id the origin does not know), that text followed by a plain-token id
 * and nothing else.
 */
export function isCompletedJobMessage(message: unknown, jobId?: string): boolean {
  if (typeof message !== "string" || !message.startsWith(JOB_COMPLETED_PREFIX)) return false;
  const id = message.slice(JOB_COMPLETED_PREFIX.length);
  return jobId !== undefined ? id === jobId : JOB_ID_TOKEN.test(id);
}

/** The closing sentences of every report: what flair does not do, and how to confirm. */
export const MQTT_OFF_REPORT_LIMIT =
  "Listeners stop when each node's workers restart; flair does not probe them. " +
  "To confirm on a node, connect an MQTT client to its MQTT ports or WebSocket path.";

// ─── URLs: http or https with a host, and nothing but scheme, host, port and path ─

/**
 * Why `url` may not be used (as the deploy target or its operations API URL),
 * or null when it may: it must parse; its scheme must be http or https; it
 * must name a host; and it may carry no user name or password, no query and no
 * fragment. The deploy's credential goes in its Basic header, never in a URL.
 */
/**
 * Whether the authority of `url` as written — after the scheme's colon and any
 * slashes or backslashes, up to the next "/", "\\", "?", "#" or the end, with
 * the tabs and newlines and the leading spaces and control characters the URL
 * parser drops removed first — contains an "@". The parser normalizes an empty
 * user name and password away (`https://@host`, `https://:@host`), so the
 * parsed URL alone cannot show that one was given.
 */
function rawAuthorityHasUserinfo(url: string): boolean {
  const cleaned = url.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:[\/\\]*([^\/\\?#]*)/.exec(cleaned);
  return match !== null && match[1].includes("@");
}

export function unsafeUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "it is not a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "its scheme is not http or https";
  if (rawAuthorityHasUserinfo(url)) return "it carries a user name or password";
  // The URL parser already refuses an http or https URL without a host
  // ("it is not a valid URL" above); this keeps the rule explicit here.
  if (!parsed.hostname) return "it names no host";
  if (parsed.username || parsed.password) return "it carries a user name or password";
  if (parsed.search || url.includes("?")) return "it carries a query";
  if (parsed.hash || url.includes("#")) return "it carries a fragment";
  return null;
}

/**
 * `url` as flair prints it: scheme, host, port and path only — never a user
 * name, password, query or fragment — and only for an http or https URL with a
 * host; any other URL is printed as a placeholder. Every URL the deploy
 * channel prints goes through this.
 */
export function safeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "(an unparseable URL)";
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return "(a URL that is not http or https with a host)";
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** Throw, before anything is sent or printed, when `url` may not be used; `label` names it. */
export function assertSafeUrl(url: string, label: string): void {
  const problem = unsafeUrlProblem(url);
  if (problem) {
    throw new Error(
      `flair deploy: the ${label} ${safeUrl(url)} cannot be used: ${problem}. Nothing was sent. ` +
        `Give it as an http or https URL with a host: scheme, host, port and path only, and pass the credential with FABRIC_USER / FABRIC_PASSWORD (or --fabric-user / --fabric-password-file).`,
    );
  }
}

/**
 * The refusal a CLI prints, before anything else, when a URL the deploy
 * channel would use may not be used; null when every one may. `urls` pairs
 * each URL (absent ones are skipped) with how the refusal names it; the
 * message shows the URL only through safeUrl.
 */
export function deployUrlRefusal(urls: ReadonlyArray<readonly [string | undefined, string]>): string | null {
  for (const [url, label] of urls) {
    if (url === undefined || url === "") continue;
    try {
      assertSafeUrl(url, label);
    } catch (err) {
      return (err as Error).message;
    }
  }
  return null;
}

// ─── What a remote answered, as printed: never its text ─────────────────────

/** An HTTP answer as printed: its status code only, never its body or reason phrase. */
function httpAnswer(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : "an HTTP answer without a valid status";
}

/** A transport failure as printed: a fixed message, with the error's code when it is a plain identifier. */
function transportFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code ?? (err as { name?: unknown } | null)?.name;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(code) ? `the request failed (${code})` : "the request failed";
}

/** One DNS label (RFC 1123): letters, digits and inner hyphens, 1 to 63 characters. */
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Whether `value` is a valid host name (dot-separated RFC 1123 labels, at most
 * 253 characters) or an IP address (node:net isIP; an IPv6 address is given
 * without brackets). Anything else — a port suffix, a path, an empty label,
 * a lone ":" — is not.
 */
export function isNodeHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return false;
  if (isIP(value) !== 0) return true;
  return value.split(".").every((label) => HOST_LABEL.test(label));
}

/** A cluster node's name as printed: a valid host name or IP address, else a fixed placeholder. */
function nodeName(value: unknown): string {
  return isNodeHost(value) ? value : "(a node whose name is not a host name or address)";
}

/**
 * The operations API URL of cluster node `node`, assuming the target's
 * operations scheme and port, printed through safeUrl; for a node name that is
 * not a valid host name or IP address, a fixed phrase instead.
 */
export function peerOpsUrl(opsUrl: string, node: string): string {
  if (!isNodeHost(node)) return "that node's operations API";
  try {
    const parsed = new URL(opsUrl);
    // A node's address is built from the scheme and port only; an operations
    // URL with a path would lose it, so none is built.
    if (parsed.pathname !== "/" && parsed.pathname !== "") return "that node's operations API";
    const host = isIP(node) === 6 ? `[${node}]` : node;
    return safeUrl(`${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`);
  } catch {
    return "that node's operations API";
  }
}

/** A Harper job id as printed: a plain token, else a fixed placeholder. */
function jobIdText(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : "(an id that is not a plain token)";
}

interface OpsTarget {
  /** The operations API URL. */
  url: string;
  fabricUser: string;
  fabricPassword: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * POST one operation to the endpoint's root, as flair's other ops calls do.
 * A redirect is not followed: its 3xx answer is returned as not ok, and its
 * location receives nothing. Throws on a transport failure.
 */
async function postOperation(t: OpsTarget, body: Record<string, unknown>): Promise<{ status: number; ok: boolean; text: string }> {
  assertSafeUrl(t.url, "operations API URL");
  const fetchImpl = t.fetchImpl ?? globalThis.fetch;
  const auth = Buffer.from(`${t.fabricUser}:${t.fabricPassword}`).toString("base64");
  const res = await fetchImpl(`${t.url.replace(/\/+$/, "")}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(t.timeoutMs ?? 60_000),
    redirect: "manual",
  });
  const redirected = res.status >= 300 && res.status < 400;
  return { status: res.status, ok: res.ok && !redirected, text: redirected ? "" : await res.text().catch(() => "") };
}

/** The entries of a replicated answer (Harper's per-node results), or [] when it lists none. */
function replicatedEntries(answer: unknown): Record<string, unknown>[] {
  const peers = (answer as { replicated?: unknown } | null)?.replicated;
  return Array.isArray(peers) ? peers.filter((p): p is Record<string, unknown> => !!p && typeof p === "object") : [];
}

function entryName(p: Record<string, unknown>): string {
  return nodeName(p.node ?? p.name ?? p.hostname);
}

/** A node in a replicated answer that reports a failure (Harper's peer-result shapes). */
export function failedPeerNodes(answer: unknown): string[] {
  const failed: string[] = [];
  for (const p of replicatedEntries(answer)) {
    const error = p.error ?? (p.status === "failed" ? p.reason : undefined);
    if ((error != null && error !== "") || p.status === "failed") failed.push(entryName(p));
  }
  return failed;
}

/** The nodes a replicated answer names (failed or not). */
export function replicatedNodes(answer: unknown): string[] {
  return replicatedEntries(answer).map(entryName);
}

function parseJson(text: string): unknown {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** The operations API URL's host as the report names it (host and port). */
function opsHost(opsUrl: string): string {
  try {
    return new URL(opsUrl).host;
  } catch {
    return safeUrl(opsUrl);
  }
}

/**
 * Step 1: send the MQTT-off configuration to the operations API at `url`.
 * Throws, naming the endpoint and the HTTP status (never the answer's text),
 * when the origin does not accept it, and naming every node the replicated
 * answer reports as failed, with the request to send to each; nothing has been
 * deployed when it throws. Answers the cluster nodes the replicated answer
 * names.
 */
export async function applyMqttOffConfiguration(o: OpsTarget & {
  replicated: boolean;
  onProgress?: (msg: string) => void;
}): Promise<{ peers: string[] }> {
  assertSafeUrl(o.url, "operations API URL");
  const shown = safeUrl(o.url);
  const send = async (replicated: boolean) => {
    try {
      return await postOperation(o, buildMqttOffOperation(replicated));
    } catch (err) {
      throw new Error(
        `flair deploy: could not send the MQTT-off configuration to ${shown} (${transportFailure(err)}), so nothing was deployed. ` +
          `Check that the target's operations API is reachable (--ops-target / FLAIR_OPS_TARGET name it), or pass --keep-mqtt-config to deploy without changing its MQTT configuration.`,
      );
    }
  };
  let replicated = o.replicated;
  let answer = await send(replicated);
  if (!answer.ok && replicated && answer.text.includes(REPLICATION_NOT_IMPLEMENTED)) {
    // A standalone instance: it has no cluster nodes to reach.
    o.onProgress?.(`${shown} has no replication; setting MQTT off on that instance alone`);
    replicated = false;
    answer = await send(false);
  }
  if (!answer.ok) {
    throw new Error(
      `flair deploy: ${shown} refused the MQTT-off configuration (${httpAnswer(answer.status)}), so nothing was deployed. ` +
        `Fix the cause, or pass --keep-mqtt-config to deploy without changing the target's MQTT configuration.`,
    );
  }
  const parsed = parseJson(answer.text);
  const failed = failedPeerNodes(parsed);
  if (failed.length > 0) {
    throw new Error(
      `flair deploy: the MQTT-off configuration did not reach ${failed.join(", ")}, so nothing was deployed. ` +
        `Re-run the deploy once ${failed.length === 1 ? "that node is" : "those nodes are"} reachable, or send ` +
        `${JSON.stringify(buildMqttOffOperation(false))} (Basic admin credential) to ${failed.map((n) => peerOpsUrl(o.url, n)).join(", ")} and restart ${failed.length === 1 ? "its" : "their"} worker threads, ` +
        `or pass --keep-mqtt-config to deploy without changing the target's MQTT configuration.`,
    );
  }
  o.onProgress?.(`MQTT listeners set off in the configuration of ${shown}${replicated ? " and its cluster nodes" : ""}`);
  return { peers: replicated ? replicatedNodes(parsed) : [] };
}

/** The restart an operator sends when the channel's own restart request failed or was not made. */
export function sharedWorkerRestartInstruction(opsUrl: string): string {
  return `send ${JSON.stringify(buildSharedWorkerRestartOperation(false))} to ${safeUrl(opsUrl)} (Basic admin credential)`;
}

/**
 * Why a finished restart job reports a failure, or null when it reports none.
 * A completed restart job is not proof of a node's restart: Harper sends a
 * node's restart-complete from a `finally` and does not carry the worker
 * replacement's outcome, so this catches only the failures Harper reports — a
 * job that did not complete, a completion message that is not exactly
 * Harper's for `jobId` (isCompletedJobMessage), a replicated result without
 * its node list, and a node recorded without Harper's completed-job message
 * (each named). It never echoes the job's text.
 */
export function reportedRestartFailure(job: { status?: unknown; message?: unknown; result?: unknown }, replicated: boolean, jobId: string): string | null {
  if (job.status !== "COMPLETE") {
    const status = job.status === "ERROR" || job.status === "PENDING" || job.status === "IN_PROGRESS" ? job.status : "with an unrecognized status";
    return `the job ended ${status}`;
  }
  if (!isCompletedJobMessage(job.message, jobId)) {
    return "the job completed with a message other than Harper's completed-job message for this job";
  }
  if (!replicated) return null;
  const nodes = (job.result as { replicated?: unknown } | null | undefined)?.replicated;
  if (!Array.isArray(nodes)) return "the replicated job's result lists no cluster nodes";
  const failed = restartFailedNodes(job);
  return failed.length ? `the job records these nodes without Harper's completed-job message: ${failed.join(", ")}` : null;
}

/** The cluster nodes a replicated restart job's result lists without Harper's completed-job message, as printed. */
function restartFailedNodes(job: { result?: unknown }): string[] {
  const nodes = (job.result as { replicated?: unknown } | null | undefined)?.replicated;
  if (!Array.isArray(nodes)) return [];
  const failed: string[] = [];
  for (const entry of nodes) {
    const e = (entry ?? {}) as { node?: unknown; message?: unknown };
    if (!isCompletedJobMessage(e.message)) failed.push(nodeName(e.node));
  }
  return failed;
}

/** What a restart request came to: the job id and each node's outcome as Harper's job records it. */
export interface SharedWorkerRestart {
  jobId: string;
  /** "<node> completed" for the origin (the job's own status) and each cluster node the job names. */
  outcomes: string[];
}

/**
 * Request the shared HTTP worker threads' restart through `restart_service`
 * (pool scope), replicated when asked, and wait for Harper's job. The answer
 * must carry a job id, and the finished job must report no failure
 * (reportedRestartFailure) — which is not proof that a node's workers
 * restarted. A standalone instance (no replication) is restarted on its own.
 * Throws naming the reported failure and every node the job names as failed;
 * answers the job id and the per-node outcomes.
 */
export async function restartSharedWorkers(o: OpsTarget & {
  replicated: boolean;
  jobTimeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<SharedWorkerRestart> {
  const shown = safeUrl(o.url);
  type Run = { kind: "done"; jobId: string; nodes: string[] } | { kind: "failed"; message: string; standalone?: boolean; failedNodes?: string[] };
  const run = async (replicated: boolean): Promise<Run> => {
    let started: { status: number; ok: boolean; text: string };
    try {
      started = await postOperation(o, buildSharedWorkerRestartOperation(replicated));
    } catch (err) {
      return { kind: "failed", message: transportFailure(err) };
    }
    if (!started.ok) {
      return { kind: "failed", message: httpAnswer(started.status), standalone: replicated && started.text.includes(REPLICATION_NOT_IMPLEMENTED) };
    }
    const jobId = (parseJson(started.text) as { job_id?: unknown } | null)?.job_id;
    if (typeof jobId !== "string" || jobId.length === 0) {
      return { kind: "failed", message: "the restart was answered without a job id, so its outcome cannot be followed" };
    }
    const deadline = Date.now() + (o.jobTimeoutMs ?? 600_000);
    while (Date.now() < deadline) {
      let job: { status: number; ok: boolean; text: string };
      try {
        job = await postOperation(o, { operation: "get_job", id: jobId });
      } catch (err) {
        return { kind: "failed", message: transportFailure(err) };
      }
      // A job read that did not succeed establishes nothing about the job: it
      // is refused before its body is parsed, whatever the body says.
      if (!job.ok) return { kind: "failed", message: `the job's status read was answered ${httpAnswer(job.status)}` };
      const rows = parseJson(job.text);
      const row = (Array.isArray(rows) ? rows[0] : rows) as { status?: unknown; message?: unknown; result?: unknown } | null;
      if (row?.status === "COMPLETE" || row?.status === "ERROR") {
        const problem = reportedRestartFailure(row, replicated, jobId);
        if (problem) {
          return {
            kind: "failed",
            message: problem,
            standalone: replicated && typeof row.message === "string" && row.message.includes(REPLICATION_NOT_IMPLEMENTED),
            failedNodes: replicated ? restartFailedNodes(row) : [],
          };
        }
        return { kind: "done", jobId, nodes: replicated ? replicatedNodes(row.result) : [] };
      }
      await new Promise((r) => setTimeout(r, o.pollIntervalMs ?? 500));
    }
    return { kind: "failed", message: "the restart job did not finish in time" };
  };
  o.onProgress?.(`requesting a restart of the shared HTTP worker threads of ${shown}${o.replicated ? " and its cluster nodes" : ""} (they start the MQTT listeners)`);
  let outcome = await run(o.replicated);
  if (outcome.kind === "failed" && o.replicated && outcome.standalone) {
    o.onProgress?.(`${shown} has no replication; requesting the restart of that instance's shared workers alone`);
    outcome = await run(false);
  }
  if (outcome.kind === "failed") {
    const peers = (outcome.failedNodes ?? []).map((n) => peerOpsUrl(o.url, n));
    throw new Error(
      `flair deploy: the restart of the shared worker threads of ${shown} failed (${outcome.message}). The MQTT-off configuration is set, and the listeners' live state is unconfirmed: ` +
        `unless the deploy's own restart covered the shared workers (Harper restarts every worker only for an application it finds already active), workers that have not restarted may still serve their previous listener configuration. ` +
        `Deployed; ${sharedWorkerRestartInstruction(o.url)}${peers.length ? `, and the same request to ${peers.join(", ")}` : ""}.`,
    );
  }
  return {
    jobId: jobIdText(outcome.jobId),
    outcomes: [`${opsHost(o.url)} completed`, ...outcome.nodes.map((n) => `${n} completed`)],
  };
}

/**
 * Step 2: after the deploy's restart, read the target's configuration, request
 * the shared worker threads' restart when the application is isolated, and
 * answer the report (see this module's header). Throws — after the deploy,
 * naming the restart to send — when the configuration cannot be read, the
 * answer is not a recognizable root configuration (not confirmed, never taken
 * for off), its `mqtt` section does not show the MQTT-off values (by field
 * name and category), or the restart request fails.
 */
export async function completeMqttOff(o: OpsTarget & {
  /** The application's name in the target's root configuration. */
  project: string;
  replicated: boolean;
  /** Cluster nodes the replicated MQTT-off configuration named (step 1). */
  peers?: readonly string[];
  jobTimeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<{ report: string }> {
  assertSafeUrl(o.url, "operations API URL");
  const shown = safeUrl(o.url);
  let configuration: unknown;
  let readProblem: string | null = null;
  try {
    const read = await postOperation(o, { operation: "get_configuration" });
    if (!read.ok) readProblem = httpAnswer(read.status);
    else configuration = parseJson(read.text);
  } catch (err) {
    readProblem = transportFailure(err);
  }
  if (readProblem) {
    throw new Error(
      `flair deploy: could not read the configuration of ${shown} after the deploy (${readProblem}), so the MQTT-off configuration is not confirmed there. ` +
        `Deployed; read its mqtt section with get_configuration, and ${sharedWorkerRestartInstruction(o.url)} so the listeners stop.`,
    );
  }
  const notRoot = rootConfigurationProblem(configuration);
  if (notRoot) {
    throw new Error(
      `flair deploy: the configuration answer of ${shown} is not a recognizable root configuration (${notRoot}), so the MQTT-off configuration is not confirmed there. ` +
        `Deployed; read its mqtt section with get_configuration, and ${sharedWorkerRestartInstruction(o.url)} so the listeners stop.`,
    );
  }
  const notOff = mqttOffConfirmed(configuration);
  if (notOff) {
    throw new Error(
      `flair deploy: the saved configuration on ${shown} does not read off: ${notOff}. ` +
        `Deployed; send ${JSON.stringify(buildMqttOffOperation(false))} to ${shown}, then ${sharedWorkerRestartInstruction(o.url)}.`,
    );
  }
  const entry = (configuration as Record<string, unknown>)[o.project];
  const isolated = entry !== null && typeof entry === "object" && (entry as { isolated?: unknown }).isolated === true;
  let restartPart: string;
  if (isolated) {
    o.onProgress?.(`${o.project} is an isolated application on ${shown}: unless Harper found it already active, the deploy's restart covered only its own worker`);
    const restart = await restartSharedWorkers({ ...o, onProgress: o.onProgress });
    restartPart = `job ${restart.jobId}: ${restart.outcomes.join(", ")}`;
  } else {
    restartPart = "with the deploy's own restart";
  }
  const nodes = [opsHost(o.url), ...(o.peers ?? [])];
  const report =
    `MQTT listeners configured off on ${nodes.join(", ")}; shared workers restart requested (${restartPart}); ` +
    `the saved configuration on ${opsHost(o.url)} reads off. ${MQTT_OFF_REPORT_LIMIT}`;
  o.onProgress?.(report);
  return { report };
}
