/**
 * mqtt-off-deploy.ts — the component-deployment channel's MQTT-off step
 * (`flair deploy`, `flair upgrade --target`; called by deploy() in
 * src/deploy.ts).
 *
 * A component's config.yaml cannot turn Harper's MQTT listeners off: `mqtt` is
 * a section of the instance's ROOT configuration (config-root.schema.json),
 * not of an application's (config-app.schema.json), and an application that
 * lists `mqtt` only adds a handler of its own. Flair's local spawns set the
 * root section through HARPER_SET_CONFIG and MQTT_* variables; a component
 * deployment that does not go through those spawns (Harper Fabric) keeps
 * Harper's defaults (mqtt.webSocket true, TCP 1883, TLS 8883). So the channel
 * sets it through the target's operations API, in two steps. The operations
 * API URL must carry no credential (no user name or password, no credential in
 * its query); every URL the step prints is redacted to its origin and path.
 *
 *   1. Before the deploy — applyMqttOffConfiguration: `set_configuration` with
 *      MQTT_DISABLED_SET_CONFIGURATION, sent with the deploy's Basic credential
 *      to the operations API URL the caller resolved, replicated to the
 *      cluster's nodes when the deploy is. The origin refusing it, or a node
 *      the answer names as failed, stops the deploy before anything is
 *      deployed. A standalone instance (no replication) is set on its own.
 *
 *   2. After the deploy's restart — ensureMqttListenersOff. Harper applies the
 *      setting when the HTTP worker threads that register the MQTT listeners
 *      restart. The deploy's restart covers them, except when the root
 *      configuration marks the application `isolated`: Harper then restarts
 *      only that application's dedicated worker (components/operations.js,
 *      `restartScope`; server/threads/manageThreads.js `restartWorkers` skips
 *      the shared workers), and the shared workers keep their listeners. This
 *      step:
 *        - reads the target's configuration, which must show the MQTT-off
 *          values it set (`mqtt.network.port` and `mqtt.network.securePort`
 *          null, `mqtt.webSocket` false); an empty or malformed answer fails;
 *        - when the application is isolated, restarts the shared worker
 *          threads through `restart_service` (`scope: ""`, Harper's pool scope;
 *          replicated when the deploy is) and requires Harper's job to prove
 *          every restart it asked for: the job must complete, and when it was
 *          replicated, its result must list each cluster node's restart as a
 *          completed job (bin/restart.ts records a node it could not restart
 *          with that node's error instead, and still completes);
 *        - checks the URL that serves the target's HTTP port (the target URL
 *          unless the caller names another) with an MQTT CONNECT over a
 *          WebSocket with the `mqtt` subprotocol. Only a definitive refusal —
 *          an HTTP 4xx answer to the upgrade, or a WebSocket close frame
 *          instead of a CONNACK — confirms MQTT over WebSocket is off; a
 *          CONNACK means it is served; anything else (a connection error, an
 *          HTTP 5xx, the connection ending without a close frame, no answer in
 *          time) is inconclusive. If MQTT is still served, the shared workers
 *          are restarted once and checked again. A check that does not end in
 *          a definitive refusal fails the step, naming the restart and check
 *          to run.
 *      The WebSocket check reaches the node that URL routes to; the other
 *      nodes are covered by the replicated configuration and restart answers,
 *      which are inspected node by node.
 */
import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { MQTT_DISABLED_SET_CONFIGURATION, mqttOffConfirmed } from "./lib/mqtt-config.js";

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

/** The message Harper's job runner gives a job that completed (server/jobs/jobProcess.ts). */
const JOB_COMPLETED_MESSAGE = /^Successfully completed job\b/;

// ─── URLs: no credential in them, and redacted wherever printed ─────────────

const CREDENTIAL_QUERY_NAME = /(token|secret|pass|pwd|key|auth|sig|cred|session|jwt|bearer|cookie)/i;

/**
 * Why `url` may not be used as the operations API URL, or null when it may:
 * it must parse, and carry no user name or password and no query parameter
 * (or fragment) that names a credential. The deploy's credential goes in its
 * Basic header, never in the URL.
 */
export function operationsUrlCredentialProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "it is not a valid URL";
  }
  if (parsed.username || parsed.password) return "it carries a user name or password";
  for (const name of parsed.searchParams.keys()) {
    if (CREDENTIAL_QUERY_NAME.test(name)) return "its query carries a credential parameter";
  }
  if (parsed.hash && CREDENTIAL_QUERY_NAME.test(parsed.hash)) return "its fragment names a credential";
  return null;
}

/** `url` as printed: origin and path only — never a user name, password, query or fragment. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const elided = parsed.search || parsed.hash ? "?…" : "";
    return `${parsed.protocol}//${parsed.host}${path}${elided}`;
  } catch {
    return "(an unparseable URL)";
  }
}

/** Throw, before any request, when `url` carries a credential. */
export function assertOperationsUrlCarriesNoCredential(url: string): void {
  const problem = operationsUrlCredentialProblem(url);
  if (problem) {
    throw new Error(
      `flair deploy: the operations API URL ${displayUrl(url)} cannot be used: ${problem}. Nothing was sent. ` +
        `Pass the credential with FABRIC_USER / FABRIC_PASSWORD (or --fabric-user / --fabric-password-file) and an --ops-target / FLAIR_OPS_TARGET without it.`,
    );
  }
}

interface OpsTarget {
  /** The operations API URL. */
  url: string;
  fabricUser: string;
  fabricPassword: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** POST one operation to the endpoint's root, as flair's other ops calls do. Throws on a transport failure. */
async function postOperation(t: OpsTarget, body: Record<string, unknown>): Promise<{ status: number; ok: boolean; text: string }> {
  assertOperationsUrlCarriesNoCredential(t.url);
  const fetchImpl = t.fetchImpl ?? globalThis.fetch;
  const auth = Buffer.from(`${t.fabricUser}:${t.fabricPassword}`).toString("base64");
  const res = await fetchImpl(`${t.url.replace(/\/+$/, "")}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(t.timeoutMs ?? 60_000),
  });
  return { status: res.status, ok: res.ok, text: await res.text().catch(() => "") };
}

/** A node in a replicated answer that reports a failure (Harper's peer-result shapes). */
export function failedPeerNodes(answer: unknown): string[] {
  const peers = (answer as { replicated?: unknown } | null)?.replicated;
  if (!Array.isArray(peers)) return [];
  const failed: string[] = [];
  for (const peer of peers) {
    if (!peer || typeof peer !== "object") continue;
    const p = peer as Record<string, unknown>;
    const error = p.error ?? (p.status === "failed" ? p.reason : undefined);
    if ((error != null && error !== "") || p.status === "failed") {
      failed.push(String(p.node ?? p.name ?? p.hostname ?? "(unnamed node)"));
    }
  }
  return failed;
}

function parseJson(text: string): unknown {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** Trim and strip control characters from text a remote answered, before printing it. */
function quoteAnswer(text: string, max = 300): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max);
}

/**
 * Step 1: send the MQTT-off configuration to the operations API at `url`.
 * Throws, naming the endpoint and its answer, when the origin does not accept
 * it, and naming every node the replicated answer reports as failed; nothing
 * has been deployed when it throws.
 */
export async function applyMqttOffConfiguration(o: OpsTarget & {
  replicated: boolean;
  onProgress?: (msg: string) => void;
}): Promise<void> {
  assertOperationsUrlCarriesNoCredential(o.url);
  const shown = displayUrl(o.url);
  const send = async (replicated: boolean) => {
    try {
      return await postOperation(o, buildMqttOffOperation(replicated));
    } catch (err: any) {
      throw new Error(
        `flair deploy: could not send the MQTT-off configuration to ${shown} (${quoteAnswer(String(err?.message ?? err))}), so nothing was deployed. ` +
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
      `flair deploy: ${shown} refused the MQTT-off configuration (HTTP ${answer.status}: ${quoteAnswer(answer.text)}), so nothing was deployed. ` +
        `Fix the cause, or pass --keep-mqtt-config to deploy without changing the target's MQTT configuration.`,
    );
  }
  const failed = failedPeerNodes(parseJson(answer.text));
  if (failed.length > 0) {
    throw new Error(
      `flair deploy: the MQTT-off configuration did not reach ${failed.join(", ")}, so nothing was deployed. ` +
        `Re-run the deploy once ${failed.length === 1 ? "that node is" : "those nodes are"} reachable, or send ` +
        `${JSON.stringify(buildMqttOffOperation(false))} to ${failed.length === 1 ? "it" : "each of them"} and restart its worker threads, ` +
        `or pass --keep-mqtt-config to deploy without changing the target's MQTT configuration.`,
    );
  }
  o.onProgress?.(`MQTT listeners set off in the configuration of ${shown}${replicated ? " and its cluster nodes" : ""}`);
}

/** The restart and check an operator runs when the channel cannot confirm the MQTT listeners are off. */
export function sharedWorkerRestartInstruction(opsUrl: string): string {
  return (
    `send ${JSON.stringify(buildSharedWorkerRestartOperation(false))} to ${displayUrl(opsUrl)} on each node (Basic admin credential), ` +
    `then read each node's mqtt section with get_configuration and confirm an MQTT-over-WebSocket CONNECT to its HTTP port gets no CONNACK (the upgrade is refused or the WebSocket is closed); flair doctor reports a local instance's configuration`
  );
}

/** Why a completed restart job does not prove every restart it was asked for; null when it does. */
export function unprovenRestart(job: { status?: unknown; message?: unknown; result?: unknown }, replicated: boolean): string | null {
  if (job.status !== "COMPLETE") return `the job ended ${String(job.status ?? "without a status")}: ${quoteAnswer(String(job.message ?? ""))}`;
  if (typeof job.message !== "string" || !JOB_COMPLETED_MESSAGE.test(job.message)) {
    return `the job completed with "${quoteAnswer(String(job.message ?? ""))}" rather than a completed restart`;
  }
  if (!replicated) return null;
  const nodes = (job.result as { replicated?: unknown } | null | undefined)?.replicated;
  if (!Array.isArray(nodes)) return "the replicated job's result lists no cluster nodes, so their restarts are not shown";
  const unproven: string[] = [];
  for (const entry of nodes) {
    const e = (entry ?? {}) as { node?: unknown; message?: unknown };
    const name = typeof e.node === "string" && e.node ? e.node : "(unnamed node)";
    if (typeof e.message !== "string" || !JOB_COMPLETED_MESSAGE.test(e.message)) {
      unproven.push(`${name} (${quoteAnswer(String(e.message ?? "no answer"), 120)})`);
    }
  }
  return unproven.length ? `these nodes did not restart: ${unproven.join(", ")}` : null;
}

/**
 * Restart the shared HTTP worker threads through `restart_service` (pool
 * scope), replicated when asked, and wait for Harper's job. The answer must
 * carry a job id, and the finished job must prove each restart it asked for
 * (unprovenRestart). A standalone instance (no replication) is restarted on its
 * own. Throws naming what is not proven.
 */
export async function restartSharedWorkers(o: OpsTarget & {
  replicated: boolean;
  jobTimeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<void> {
  const shown = displayUrl(o.url);
  const run = async (replicated: boolean): Promise<{ ok: boolean; message: string }> => {
    const started = await postOperation(o, buildSharedWorkerRestartOperation(replicated));
    if (!started.ok) return { ok: false, message: `HTTP ${started.status}: ${quoteAnswer(started.text)}` };
    const jobId = (parseJson(started.text) as { job_id?: unknown } | null)?.job_id;
    if (typeof jobId !== "string" || jobId.length === 0) {
      return { ok: false, message: `the restart was answered without a job id (${quoteAnswer(started.text)}), so its outcome cannot be followed` };
    }
    const deadline = Date.now() + (o.jobTimeoutMs ?? 600_000);
    while (Date.now() < deadline) {
      const job = await postOperation(o, { operation: "get_job", id: jobId });
      const rows = parseJson(job.text);
      const row = (Array.isArray(rows) ? rows[0] : rows) as { status?: unknown; message?: unknown; result?: unknown } | null;
      if (row?.status === "COMPLETE" || row?.status === "ERROR") {
        const problem = unprovenRestart(row, replicated);
        return problem ? { ok: false, message: problem } : { ok: true, message: "" };
      }
      await new Promise((r) => setTimeout(r, o.pollIntervalMs ?? 500));
    }
    return { ok: false, message: `the restart job ${jobId} did not finish in time` };
  };
  o.onProgress?.(`restarting the shared HTTP worker threads of ${shown}${o.replicated ? " and its cluster nodes" : ""} (they host the MQTT listeners)`);
  let outcome = await run(o.replicated);
  if (!outcome.ok && o.replicated && outcome.message.includes(REPLICATION_NOT_IMPLEMENTED)) {
    o.onProgress?.(`${shown} has no replication; restarting that instance's shared workers alone`);
    outcome = await run(false);
  }
  if (!outcome.ok) {
    throw new Error(
      `flair deploy: restarting the shared worker threads of ${shown} is not proven (${outcome.message}); the MQTT-off configuration is set but may not be applied. ` +
        sharedWorkerRestartInstruction(o.url) + ".",
    );
  }
}

// ─── The MQTT-over-WebSocket check ──────────────────────────────────────────

/** What the WebSocket check found. Only `refused` confirms MQTT over WebSocket is off. */
export interface MqttProbeOutcome {
  outcome: "served" | "refused" | "inconclusive";
  detail: string;
}

/** The MQTT 3.1.1 CONNECT the check sends: clean session, no credential. */
function mqttConnectPacket(clientId: string): Buffer {
  const id = Buffer.from(clientId, "utf8");
  const body = Buffer.concat([Buffer.from([0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x02, 0, 10, id.length >> 8, id.length & 0xff]), id]);
  return Buffer.concat([Buffer.from([0x10, body.length]), body]);
}

/** A masked client WebSocket frame (RFC 6455 §5.2) carrying `payload` (< 126 bytes). */
function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

/**
 * Check whether `baseUrl` serves MQTT over WebSocket: send a WebSocket upgrade
 * with the `mqtt` subprotocol to its root, then, once upgraded, an MQTT
 * CONNECT with no credential. A CONNACK is `served`; an HTTP 4xx answer to the
 * upgrade (other than 408 and 429) or a WebSocket close frame instead of a
 * CONNACK is a definitive `refused`; anything else — a connection or TLS
 * error, another HTTP status, the connection ending without a close frame, no
 * answer within `timeoutMs` — is `inconclusive`. The request carries no user
 * name or password from the URL.
 */
export async function probeMqttOverWebSocket(baseUrl: string, timeoutMs = 5_000): Promise<MqttProbeOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { outcome: "inconclusive", detail: "the URL to check is not valid" };
  }
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const port = Number(parsed.port) || (secure ? 443 : 80);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return await new Promise<MqttProbeOutcome>((resolve) => {
    let settled = false;
    let socket: Socket | undefined;
    let sock: Socket;
    const finish = (outcome: MqttProbeOutcome["outcome"], detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already closed */ }
      resolve({ outcome, detail });
    };
    const timer = setTimeout(() => finish("inconclusive", `no answer within ${timeoutMs} ms`), timeoutMs);
    try {
      sock = secure
        ? tlsConnect({ host, port, servername: host })
        : netConnect({ host, port });
      socket = sock;
    } catch (err: any) {
      finish("inconclusive", `the connection failed: ${quoteAnswer(String(err?.message ?? err), 120)}`);
      return;
    }
    const key = randomBytes(16).toString("base64");
    const request =
      `GET / HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n`;
    let upgraded = false;
    let buf = Buffer.alloc(0);
    sock.once(secure ? "secureConnect" : "connect", () => sock.write(request));
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
        buf = buf.subarray(end + 4);
        if (status === 101) {
          upgraded = true;
          sock.write(maskedFrame(0x2, mqttConnectPacket(`flair-mqtt-check-${randomBytes(4).toString("hex")}`)));
        } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          finish("refused", `the WebSocket upgrade was answered HTTP ${status}`);
          return;
        } else {
          finish("inconclusive", `the WebSocket upgrade was answered ${Number.isFinite(status) ? `HTTP ${status}` : "with something other than HTTP"}`);
          return;
        }
      }
      // WebSocket frames from the server (unmasked).
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
        if (buf[1] & 0x80) offset += 4; // a masked server frame (not expected)
        if (buf.length < offset + len) return;
        const payload = buf.subarray(offset, offset + len);
        buf = buf.subarray(offset + len);
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
          finish("refused", `the WebSocket was closed${code ? ` with code ${code}` : ""} instead of an MQTT answer`);
          return;
        }
        if ((opcode === 0x2 || opcode === 0x0 || opcode === 0x1) && payload.length > 0) {
          if (payload[0] >> 4 === 2) {
            finish("served", "an MQTT CONNACK came back");
            return;
          }
        }
      }
    });
    sock.on("error", (err: Error) => finish("inconclusive", `the connection failed: ${quoteAnswer(err.message, 120)}`));
    sock.on("close", () => finish("inconclusive", upgraded ? "the connection ended without a WebSocket close frame or an MQTT answer" : "the connection ended before the upgrade was answered"));
  });
}

/**
 * Step 2: after the deploy's restart, check the target's MQTT listeners (see
 * this module's header). Throws, naming what is still on or unconfirmed and
 * the restart and check to run, unless the configuration shows the MQTT-off
 * values and the WebSocket check ends in a definitive refusal.
 */
export async function ensureMqttListenersOff(o: OpsTarget & {
  /** The URL that serves the target's HTTP port (what the WebSocket check reaches). */
  baseUrl: string;
  /** The application's name in the target's root configuration. */
  project: string;
  replicated: boolean;
  /** How long the WebSocket check waits for a definitive refusal after a restart. */
  checkTimeoutMs?: number;
  checkIntervalMs?: number;
  probe?: (baseUrl: string) => Promise<MqttProbeOutcome>;
  jobTimeoutMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<void> {
  assertOperationsUrlCarriesNoCredential(o.url);
  const shownOps = displayUrl(o.url);
  const shownBase = displayUrl(o.baseUrl);
  const probe = o.probe ?? ((url: string) => probeMqttOverWebSocket(url));
  let configuration: unknown;
  try {
    const read = await postOperation(o, { operation: "get_configuration" });
    if (!read.ok) throw new Error(`HTTP ${read.status}: ${quoteAnswer(read.text, 200)}`);
    configuration = parseJson(read.text);
  } catch (err: any) {
    throw new Error(
      `flair deploy: could not read the configuration of ${shownOps} to check that its MQTT listeners are off (${quoteAnswer(String(err?.message ?? err), 200)}). ` +
        `Deployed; ${sharedWorkerRestartInstruction(o.url)}.`,
    );
  }
  const notOff = mqttOffConfirmed(configuration);
  if (notOff) {
    throw new Error(
      `flair deploy: the configuration of ${shownOps} does not show the MQTT-off values that were set: ${notOff}. ` +
        `Deployed; send ${JSON.stringify(buildMqttOffOperation(false))} to ${shownOps}, then ${sharedWorkerRestartInstruction(o.url)}.`,
    );
  }
  const entry = (configuration as Record<string, unknown>)[o.project];
  const isolated = entry !== null && typeof entry === "object" && (entry as { isolated?: unknown }).isolated === true;
  let restarted = false;
  if (isolated) {
    o.onProgress?.(`${o.project} is an isolated application on ${shownOps}: the deploy's restart covered only its own worker`);
    await restartSharedWorkers({ ...o, onProgress: o.onProgress });
    restarted = true;
  }
  /** Probe until a definitive refusal or the deadline; answers the last outcome. */
  const checkUntilRefused = async (): Promise<MqttProbeOutcome> => {
    const deadline = Date.now() + (o.checkTimeoutMs ?? 120_000);
    for (;;) {
      const result = await probe(o.baseUrl);
      if (result.outcome === "refused" || Date.now() >= deadline) return result;
      await new Promise((r) => setTimeout(r, o.checkIntervalMs ?? 2_000));
    }
  };
  let last = await checkUntilRefused();
  if (last.outcome === "served" && !restarted) {
    o.onProgress?.(`${shownBase} still serves MQTT over WebSocket after the deploy's restart`);
    await restartSharedWorkers({ ...o, onProgress: o.onProgress });
    restarted = true;
    last = await checkUntilRefused();
  }
  if (last.outcome === "served") {
    throw new Error(
      `flair deploy: ${shownBase} still serves MQTT over WebSocket after the shared worker threads were restarted (${last.detail}). ` +
        `Deployed; ${sharedWorkerRestartInstruction(o.url)}.`,
    );
  }
  if (last.outcome !== "refused") {
    throw new Error(
      `flair deploy: could not confirm that ${shownBase} no longer serves MQTT over WebSocket (${last.detail}). ` +
        `Deployed; ${sharedWorkerRestartInstruction(o.url)}.`,
    );
  }
  o.onProgress?.(`MQTT listeners checked off: the configuration of ${shownOps} shows the MQTT-off values, and ${shownBase} refused an MQTT-over-WebSocket CONNECT (${last.detail})`);
}
