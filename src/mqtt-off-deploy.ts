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
 * sets it through the target's operations API, in two steps.
 *
 * URLs: the deploy target, its operations API URL and the URL the check
 * reaches must be scheme, host, port and path only — a user name, password,
 * query or fragment is refused before anything is sent or printed
 * (assertSafeUrl) — and every URL the channel prints goes through safeUrl.
 * Errors quote a remote's HTTP status code, never its body, reason phrase or
 * a transport error's text.
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
 *      step verifies ONE node — the one the target URL (or the caller's check
 *      URL) reaches, through the target's operations API:
 *        - it reads that configuration, which must show the MQTT-off values it
 *          set (`mqtt.network.port` and `mqtt.network.securePort` null,
 *          `mqtt.webSocket` false); an empty or malformed answer fails;
 *        - when the application is isolated, it restarts the shared worker
 *          threads through `restart_service` (`scope: ""`, Harper's pool scope;
 *          replicated when the deploy is) and waits for Harper's job, failing
 *          on a failure the job reports (reportedRestartFailure). A completed
 *          restart job is not proof of a peer's restart: Harper sends a node's
 *          restart-complete from a `finally` (bin/restart.ts) and drops the
 *          worker replacement's outcome;
 *        - it checks MQTT over WebSocket on the URL that serves that node's
 *          HTTP port, authenticated with the deploy's credential
 *          (probeMqttOverWebSocket). Only Harper's own answer for a disabled
 *          MQTT-over-WebSocket path (a validated upgrade closed with code 1011
 *          and "No resource was found to handle <path>") counts as off; a
 *          CONNACK means it is served; anything else (an authentication
 *          denial, any other HTTP status or close, a connection error, no
 *          answer in time) is inconclusive. If MQTT is still served, the
 *          shared workers are restarted once and checked again. A check that
 *          does not end in "off" fails the step, naming the restart and check
 *          to run.
 *      Every other cluster node — those the replicated configuration and
 *      restart answers name — is reported NOT VERIFIED by name, with the check
 *      and restart to run on it (flair doctor on that node reports its
 *      listener state). The step succeeds for the verified node; with
 *      `requireAllNodesVerified` (`--require-all-nodes-verified`) an
 *      unverified node fails it.
 */
import { createHash, randomBytes } from "node:crypto";
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

// ─── URLs: refused when they carry anything but scheme, host, port and path ─

/**
 * Why `url` may not be used (as the deploy target, its operations API URL or
 * the URL the MQTT check reaches), or null when it may: it must parse, and
 * carry no user name or password, no query and no fragment. The deploy's
 * credential goes in its Basic header, never in a URL.
 */
export function unsafeUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "it is not a valid URL";
  }
  if (parsed.username || parsed.password) return "it carries a user name or password";
  if (parsed.search || url.includes("?")) return "it carries a query";
  if (parsed.hash || url.includes("#")) return "it carries a fragment";
  return null;
}

/**
 * `url` as flair prints it: scheme, host, port and path only — never a user
 * name, password, query or fragment. Every URL the deploy channel prints goes
 * through this.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return "(an unparseable URL)";
  }
}

/** Throw, before anything is sent or printed, when `url` may not be used; `label` names it. */
export function assertSafeUrl(url: string, label: string): void {
  const problem = unsafeUrlProblem(url);
  if (problem) {
    throw new Error(
      `flair deploy: the ${label} ${safeUrl(url)} cannot be used: ${problem}. Nothing was sent. ` +
        `Give it as scheme, host, port and path only, and pass the credential with FABRIC_USER / FABRIC_PASSWORD (or --fabric-user / --fabric-password-file).`,
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

/** A cluster node's name as printed: a host name or address, else a fixed placeholder. */
function nodeName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._:\-[\]]{1,253}$/.test(value) ? value : "(a node whose name is not printable)";
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
  assertSafeUrl(t.url, "operations API URL");
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

/**
 * Step 1: send the MQTT-off configuration to the operations API at `url`.
 * Throws, naming the endpoint and the HTTP status (never the answer's text),
 * when the origin does not accept it, and naming every node the replicated
 * answer reports as failed; nothing has been deployed when it throws. Answers
 * the cluster nodes the replicated answer names, which step 2 reports as not
 * verified.
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
        `${JSON.stringify(buildMqttOffOperation(false))} to ${failed.length === 1 ? "it" : "each of them"} and restart its worker threads, ` +
        `or pass --keep-mqtt-config to deploy without changing the target's MQTT configuration.`,
    );
  }
  o.onProgress?.(`MQTT listeners set off in the configuration of ${shown}${replicated ? " and its cluster nodes" : ""}`);
  return { peers: replicated ? replicatedNodes(parsed) : [] };
}

/** The operations API URL of cluster node `node`, assuming the target's operations port and scheme. */
function peerOpsUrl(opsUrl: string, node: string): string {
  try {
    const parsed = new URL(opsUrl);
    return `${parsed.protocol}//${node}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return `the operations API of ${node}`;
  }
}

/**
 * What to run to check one node's MQTT listeners by hand: `flair doctor` on
 * that node (its "MQTT listeners" section reports the listener state), or the
 * worker restart and the WebSocket check against that node.
 */
export function nodeCheckInstruction(opsUrl: string, node: string): string {
  return (
    `on ${node}, run flair doctor (its "MQTT listeners" section reports the listener state); ` +
    `or send ${JSON.stringify(buildSharedWorkerRestartOperation(false))} to ${peerOpsUrl(opsUrl, node)} (Basic admin credential), ` +
    `read its mqtt section with get_configuration, and confirm an authenticated MQTT-over-WebSocket CONNECT to its HTTP port is closed with Harper's answer for a disabled MQTT-over-WebSocket path (close code 1011, "No resource was found to handle /")`
  );
}

/** The restart and check an operator runs when the channel cannot confirm the target node's MQTT listeners are off. */
export function sharedWorkerRestartInstruction(opsUrl: string): string {
  return (
    `send ${JSON.stringify(buildSharedWorkerRestartOperation(false))} to ${safeUrl(opsUrl)} (Basic admin credential), ` +
    `then read its mqtt section with get_configuration and confirm an authenticated MQTT-over-WebSocket CONNECT to its HTTP port is closed with Harper's answer for a disabled MQTT-over-WebSocket path (close code 1011, "No resource was found to handle /"); flair doctor on a node reports its MQTT listener state`
  );
}

/**
 * Why a finished restart job reports a failure, or null when it reports none.
 * A completed restart job is not proof of a peer's restart: Harper sends a
 * node's restart-complete from a `finally` and does not carry the worker
 * replacement's outcome, so this catches only the failures Harper reports — a
 * job that did not complete, a completion message that is not Harper's, a
 * replicated result without its node list, and a node recorded with an error.
 * It never echoes the job's text.
 */
export function reportedRestartFailure(job: { status?: unknown; message?: unknown; result?: unknown }, replicated: boolean): string | null {
  if (job.status !== "COMPLETE") {
    const status = typeof job.status === "string" && /^[A-Z_]{1,20}$/.test(job.status) ? job.status : "with an unrecognized status";
    return `the job ended ${status}`;
  }
  if (typeof job.message !== "string" || !JOB_COMPLETED_MESSAGE.test(job.message)) {
    return "the job completed with a message other than Harper's completed-job message";
  }
  if (!replicated) return null;
  const nodes = (job.result as { replicated?: unknown } | null | undefined)?.replicated;
  if (!Array.isArray(nodes)) return "the replicated job's result lists no cluster nodes";
  const failed: string[] = [];
  for (const entry of nodes) {
    const e = (entry ?? {}) as { node?: unknown; message?: unknown };
    if (typeof e.message !== "string" || !JOB_COMPLETED_MESSAGE.test(e.message)) failed.push(nodeName(e.node));
  }
  return failed.length ? `the job records these nodes without a completed restart: ${failed.join(", ")}` : null;
}

/**
 * Restart the shared HTTP worker threads through `restart_service` (pool
 * scope), replicated when asked, and wait for Harper's job. The answer must
 * carry a job id, and the finished job must report no failure
 * (reportedRestartFailure) — which is not proof that a peer restarted. A
 * standalone instance (no replication) is restarted on its own. Throws naming
 * the reported failure; answers the cluster nodes the job's result names.
 */
export async function restartSharedWorkers(o: OpsTarget & {
  replicated: boolean;
  jobTimeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<{ nodes: string[] }> {
  const shown = safeUrl(o.url);
  const run = async (replicated: boolean): Promise<{ ok: boolean; message: string; standalone?: boolean; nodes?: string[] }> => {
    let started: { status: number; ok: boolean; text: string };
    try {
      started = await postOperation(o, buildSharedWorkerRestartOperation(replicated));
    } catch (err) {
      return { ok: false, message: transportFailure(err) };
    }
    if (!started.ok) {
      return { ok: false, message: httpAnswer(started.status), standalone: replicated && started.text.includes(REPLICATION_NOT_IMPLEMENTED) };
    }
    const jobId = (parseJson(started.text) as { job_id?: unknown } | null)?.job_id;
    if (typeof jobId !== "string" || jobId.length === 0) {
      return { ok: false, message: "the restart was answered without a job id, so its outcome cannot be followed" };
    }
    const deadline = Date.now() + (o.jobTimeoutMs ?? 600_000);
    while (Date.now() < deadline) {
      let job: { status: number; ok: boolean; text: string };
      try {
        job = await postOperation(o, { operation: "get_job", id: jobId });
      } catch (err) {
        return { ok: false, message: transportFailure(err) };
      }
      const rows = parseJson(job.text);
      const row = (Array.isArray(rows) ? rows[0] : rows) as { status?: unknown; message?: unknown; result?: unknown } | null;
      if (row?.status === "COMPLETE" || row?.status === "ERROR") {
        const problem = reportedRestartFailure(row, replicated);
        if (problem) return { ok: false, message: problem, standalone: replicated && typeof row.message === "string" && row.message.includes(REPLICATION_NOT_IMPLEMENTED) };
        return { ok: true, message: "", nodes: replicated ? replicatedNodes(row.result) : [] };
      }
      await new Promise((r) => setTimeout(r, o.pollIntervalMs ?? 500));
    }
    return { ok: false, message: "the restart job did not finish in time" };
  };
  o.onProgress?.(`restarting the shared HTTP worker threads of ${shown}${o.replicated ? " and its cluster nodes" : ""} (they host the MQTT listeners)`);
  let outcome = await run(o.replicated);
  if (!outcome.ok && o.replicated && outcome.standalone) {
    o.onProgress?.(`${shown} has no replication; restarting that instance's shared workers alone`);
    outcome = await run(false);
  }
  if (!outcome.ok) {
    throw new Error(
      `flair deploy: restarting the shared worker threads of ${shown} failed (${outcome.message}); the MQTT-off configuration is set but may not be applied. ` +
        sharedWorkerRestartInstruction(o.url) + ".",
    );
  }
  return { nodes: outcome.nodes ?? [] };
}

// ─── The MQTT-over-WebSocket check ──────────────────────────────────────────

/**
 * What the WebSocket check found: `served` (an MQTT CONNACK came back), `off`
 * (Harper's own answer for a disabled MQTT-over-WebSocket path), or
 * `inconclusive` (anything else). Only `off` confirms MQTT over WebSocket is
 * off on the node the check reached.
 */
export interface MqttProbeOutcome {
  outcome: "served" | "off" | "inconclusive";
  detail: string;
}

/**
 * Harper's answer to an authenticated WebSocket upgrade with the `mqtt`
 * subprotocol when MQTT over WebSocket is off: the upgrade succeeds (its REST
 * WebSocket handler takes it) and the socket is closed with code 1011 and the
 * reason "No resource was found to handle <path>". Measured against a real
 * Harper with `mqtt.webSocket: false` (test/integration/mqtt-off-deploy-doctor
 * pins it); with MQTT over WebSocket on, the same request gets a CONNACK.
 */
export const HARPER_MQTT_WEBSOCKET_OFF = Object.freeze({ code: 1011, reason: (path: string) => `No resource was found to handle ${path}` });

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The MQTT 3.1.1 CONNECT the check sends: clean session; the credential rides on the upgrade request. */
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

/** A header value from a raw HTTP head, or undefined. */
function headerValue(head: string, name: string): string | undefined {
  for (const line of head.split("\r\n").slice(1)) {
    const at = line.indexOf(":");
    if (at > 0 && line.slice(0, at).trim().toLowerCase() === name) return line.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Check whether `baseUrl` serves MQTT over WebSocket: send a WebSocket upgrade
 * with the `mqtt` subprotocol and, when a user and password are given, the
 * deploy's Basic credential to the URL's path; validate the upgrade answer
 * (101, a Sec-WebSocket-Accept that matches the key, the `mqtt` subprotocol);
 * then send an MQTT CONNECT. A CONNACK is `served`. Harper's own answer for a
 * disabled MQTT-over-WebSocket path (HARPER_MQTT_WEBSOCKET_OFF) is `off`.
 * Anything else is `inconclusive`: any other HTTP status (an authentication
 * denial or any 4xx included), an upgrade answer that does not validate, any
 * other close, a connection or TLS error, the connection ending, or no answer
 * within `timeoutMs`. Details never quote the server's text.
 */
export async function probeMqttOverWebSocket(
  baseUrl: string,
  opts: { user?: string; password?: string; timeoutMs?: number } | number = {},
): Promise<MqttProbeOutcome> {
  const o = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const timeoutMs = o.timeoutMs ?? 5_000;
  if (unsafeUrlProblem(baseUrl)) return { outcome: "inconclusive", detail: "the URL to check may not be used" };
  const parsed = new URL(baseUrl);
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const port = Number(parsed.port) || (secure ? 443 : 80);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const path = parsed.pathname || "/";
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
    } catch (err) {
      finish("inconclusive", transportFailure(err));
      return;
    }
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
    const auth = o.user !== undefined && o.password !== undefined
      ? `Authorization: Basic ${Buffer.from(`${o.user}:${o.password}`).toString("base64")}\r\n`
      : "";
    const request =
      `GET ${path} HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: mqtt\r\n${auth}\r\n`;
    let upgraded = false;
    let buf = Buffer.alloc(0);
    sock.once(secure ? "secureConnect" : "connect", () => sock.write(request));
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.subarray(0, end).toString("latin1");
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
        buf = buf.subarray(end + 4);
        if (status !== 101) {
          finish("inconclusive", `the WebSocket upgrade was answered ${Number.isFinite(status) ? `HTTP ${status}` : "with something other than HTTP"}`);
          return;
        }
        if (headerValue(head, "sec-websocket-accept") !== expectedAccept || headerValue(head, "sec-websocket-protocol")?.toLowerCase() !== "mqtt") {
          finish("inconclusive", "the WebSocket upgrade answer did not validate (Sec-WebSocket-Accept or the mqtt subprotocol)");
          return;
        }
        upgraded = true;
        sock.write(maskedFrame(0x2, mqttConnectPacket(`flair-mqtt-check-${randomBytes(4).toString("hex")}`)));
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
          const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
          if (code === HARPER_MQTT_WEBSOCKET_OFF.code && reason === HARPER_MQTT_WEBSOCKET_OFF.reason(path)) {
            finish("off", "Harper closed the WebSocket with its answer for a disabled MQTT-over-WebSocket path (code 1011, no resource for the path)");
          } else {
            finish("inconclusive", `the WebSocket was closed${code ? ` with code ${code}` : ""}, which is not Harper's answer for a disabled MQTT-over-WebSocket path`);
          }
          return;
        }
        if ((opcode === 0x2 || opcode === 0x0 || opcode === 0x1) && payload.length > 0 && payload[0] >> 4 === 2) {
          finish("served", "an MQTT CONNACK came back");
          return;
        }
      }
    });
    sock.on("error", (err: Error) => finish("inconclusive", transportFailure(err)));
    sock.on("close", () => finish("inconclusive", upgraded ? "the connection ended without a close frame or an MQTT answer" : "the connection ended before the upgrade was answered"));
  });
}

/**
 * Step 2: after the deploy's restart, check the MQTT listeners of the node
 * the target reaches (see this module's header). Throws, naming what is still
 * on or unconfirmed and the restart and check to run, unless that node's
 * configuration shows the MQTT-off values and the WebSocket check finds MQTT
 * over WebSocket off. Every other cluster node — those the replicated
 * configuration and restart answers name — is answered as not verified;
 * `requireAllNodesVerified` turns any of them into a failure.
 */
export async function ensureMqttListenersOff(o: OpsTarget & {
  /** The URL that serves the target's HTTP port (what the WebSocket check reaches). */
  baseUrl: string;
  /** The application's name in the target's root configuration. */
  project: string;
  replicated: boolean;
  /** Cluster nodes the replicated MQTT-off configuration named (step 1). */
  peers?: readonly string[];
  /** Fail when any cluster node other than the checked one cannot be verified. */
  requireAllNodesVerified?: boolean;
  /** How long the WebSocket check waits for MQTT over WebSocket to be off after a restart. */
  checkTimeoutMs?: number;
  checkIntervalMs?: number;
  probe?: (baseUrl: string) => Promise<MqttProbeOutcome>;
  jobTimeoutMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<{ unverified: { node: string; instruction: string }[] }> {
  assertSafeUrl(o.url, "operations API URL");
  assertSafeUrl(o.baseUrl, "URL the MQTT check reaches");
  const shownOps = safeUrl(o.url);
  const shownBase = safeUrl(o.baseUrl);
  const probe = o.probe ?? ((url: string) => probeMqttOverWebSocket(url, { user: o.fabricUser, password: o.fabricPassword }));
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
      `flair deploy: could not read the configuration of ${shownOps} to check that its MQTT listeners are off (${readProblem}). ` +
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
  const peers = new Set(o.peers ?? []);
  let restarted = false;
  const restart = async () => {
    const { nodes } = await restartSharedWorkers({ ...o, onProgress: o.onProgress });
    for (const n of nodes) peers.add(n);
    restarted = true;
  };
  if (isolated) {
    o.onProgress?.(`${o.project} is an isolated application on ${shownOps}: the deploy's restart covered only its own worker`);
    await restart();
  }
  /** Probe until MQTT over WebSocket is off or the deadline; answers the last outcome. */
  const checkUntilOff = async (): Promise<MqttProbeOutcome> => {
    const deadline = Date.now() + (o.checkTimeoutMs ?? 120_000);
    for (;;) {
      const result = await probe(o.baseUrl);
      if (result.outcome === "off" || Date.now() >= deadline) return result;
      await new Promise((r) => setTimeout(r, o.checkIntervalMs ?? 2_000));
    }
  };
  let last = await checkUntilOff();
  if (last.outcome === "served" && !restarted) {
    o.onProgress?.(`${shownBase} still serves MQTT over WebSocket after the deploy's restart`);
    await restart();
    last = await checkUntilOff();
  }
  if (last.outcome === "served") {
    throw new Error(
      `flair deploy: ${shownBase} still serves MQTT over WebSocket after the shared worker threads were restarted (${last.detail}). ` +
        `Deployed; ${sharedWorkerRestartInstruction(o.url)}.`,
    );
  }
  if (last.outcome !== "off") {
    throw new Error(
      `flair deploy: could not confirm that ${shownBase} no longer serves MQTT over WebSocket (${last.detail}). ` +
        `Deployed; ${sharedWorkerRestartInstruction(o.url)}.`,
    );
  }
  o.onProgress?.(`MQTT listeners checked off on the node ${shownBase} reaches: the configuration of ${shownOps} shows the MQTT-off values, and MQTT over WebSocket is off (${last.detail})`);
  const unverified = [...peers].map((node) => ({ node, instruction: nodeCheckInstruction(o.url, node) }));
  if (unverified.length > 0 && o.requireAllNodesVerified) {
    throw new Error(
      `flair deploy: --require-all-nodes-verified: ${unverified.length === 1 ? "a cluster node was" : `${unverified.length} cluster nodes were`} NOT VERIFIED: ` +
        `${unverified.map((u) => u.node).join(", ")}. The MQTT-off configuration was sent to ${unverified.length === 1 ? "it" : "them"}, but flair checks only the node ${shownBase} reaches, ` +
        `and a completed restart job is not proof of a peer's restart. Deployed; ${unverified.map((u) => u.instruction).join("; ")}.`,
    );
  }
  return { unverified };
}
