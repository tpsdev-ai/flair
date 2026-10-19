// MQTT last-will messages on flair's tables follow the table-subscription
// policy (resources/table-subscription-policy.ts).
//
// A session registers a will at CONNECT; Harper stores it and publishes it
// later: when the session's connection ends without DISCONNECT (on the
// session's own context), or at a later worker start for a will still stored
// (on the stored will record, which carries no verified principal) — a session
// that never disconnected because the server stopped, or one whose will Harper
// could not publish as it dropped. A retained will on a table topic writes the
// row (or, with an empty payload, deletes it). This file starts one test-Harper
// with MQTT over WebSocket and a TCP listener on, and checks both moments:
//   (1) Session drop. A non-admin Harper user and an unauthenticated session
//       (which Harper authorizes locally as its super user), each over TCP and
//       over WebSocket, register a retained will that rewrites a MemoryUsage
//       row, then drop: Harper logs that it could not publish each will —
//       refused by the policy, or for the non-admin by Harper's own check on
//       the stored will — the row reads back unchanged, and an administrator's
//       subscription to `MemoryUsage/#` receives none of them. An
//       administrator's (Basic, over WebSocket) retained will applies: the row
//       is rewritten and the subscription receives it (positive control). A
//       will on a path another resource serves (`FeedMemories`, not a table)
//       is not decided by the policy: its CONNECT is accepted and its drop
//       adds no policy refusal.
//   (2) Startup replay. The same five sessions register retained wills and
//       stay connected; Harper is killed by PID (SIGKILL, so it publishes no
//       will on the way down) and started again on the same data directory.
//       Harper replays every stored will; each is refused, an administrator's
//       included (Harper logs each will it could not publish), and every row
//       reads back unchanged.
//
// Mutation check: stop recognising the replayed will record in the retained
// put()/delete() guard, and (2) goes red.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { MQTT_REASON, MqttClient } from "../helpers/mqtt-client";

/** The policy's refusal of a table publish, in either form (resources/table-subscription-policy.ts). */
const POLICY_REFUSALS = ["table publishes are for administrators", "table publishes need an administrator credential"];
/** Harper's log line for a stored will it could not publish at a worker start (server/DurableSubscriptionsSession.ts). */
const REPLAY_FAILED = "Failed to publish will";
/** Harper's log line for a will it could not publish as its session dropped. */
const DROP_FAILED = "Error publishing MQTT will for ";
/** Harper's own refusal of a non-admin session's read of its stored will. */
const HARPER_ACCESS_REFUSAL = "AccessViolation";

/**
 * Refuse to talk to anything but this test's own ephemeral instance: loopback,
 * the OS-assigned ports this instance was started on, never a production port,
 * and a data directory under the temp dir.
 */
function assertOwnInstance(harper: HarperInstance): void {
  for (const [label, href] of [["http", harper.httpURL], ["ops", harper.opsURL]] as const) {
    const u = new URL(href);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} is not an instance this test started`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port as number;
      s.close(() => resolve(port));
    });
  });
}

const count = (text: string, needles: readonly string[]) => needles.reduce((n, needle) => n + text.split(needle).length - 1, 0);

/** The text Harper logged after `marker` (the reason that follows it), or undefined when it logged none. */
function loggedAfter(log: string, marker: string, length = 400): string | undefined {
  const at = log.indexOf(marker);
  return at < 0 ? undefined : log.slice(at + marker.length, at + marker.length + length);
}

/** Whether Harper logged a stored will it could not publish whose payload carries `needle`. */
function replayFailedFor(log: string, needle: string): boolean {
  return log.split(REPLAY_FAILED).slice(1).some((chunk) => chunk.slice(0, 600).includes(needle));
}
const now = () => new Date().toISOString();

describe("MQTT last-will messages on flair tables", () => {
  const installDir = mkdtempSync(join(tmpdir(), "flair-will-"));
  const run = `will-${randomUUID().slice(0, 8)}`;
  const owner = `${run}-owner`;
  const NON_ADMIN = { username: `${run}-user`, password: `${run}-not-a-secret` };
  let harper: HarperInstance;
  let tcpPort = 0;
  const clients: MqttClient[] = [];

  const basicOf = (username: string, password: string) => "Basic " + btoa(`${username}:${password}`);
  const adminBasic = () => basicOf(harper.admin.username, harper.admin.password);
  const log = () => harper.getLog?.() ?? "";

  async function adminOp(body: Record<string, unknown>): Promise<Response> {
    assertOwnInstance(harper);
    return fetch(harper.opsURL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: adminBasic() }, body: JSON.stringify(body) });
  }

  // The rows are MemoryUsage rows: that table's put() stores a will's payload
  // as Harper hands it over (a frozen record), so an admitted will visibly
  // applies there.
  async function storedMemoryId(id: string): Promise<string | undefined> {
    const res = await adminOp({ operation: "search_by_value", database: "flair", table: "MemoryUsage", search_attribute: "id", search_value: id, get_attributes: ["*"] });
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0]?.memoryId : undefined;
  }

  async function insertRow(id: string): Promise<void> {
    const res = await adminOp({ operation: "upsert", database: "flair", table: "MemoryUsage", records: [{ id, agentId: owner, memoryId: `${id} original`, createdAt: now() }] });
    expect(res.status, await res.text()).toBe(200);
  }

  /** A retained will that rewrites MemoryUsage row `id`. */
  const rewrite = (id: string) => ({ topic: `MemoryUsage/${id}`, payload: { id, agentId: owner, memoryId: `${id} rewritten`, createdAt: now() }, retain: true });

  type Transport = "tcp" | "ws";
  type Who = "non-admin Harper user" | "unauthenticated session" | "administrator";

  async function openSession(transport: Transport, who: Who): Promise<MqttClient> {
    if (transport === "tcp") {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const attempt = await MqttClient.openTcp("127.0.0.1", tcpPort, 2_000);
        if (attempt.opened) { clients.push(attempt.client); return attempt.client; }
        await attempt.client.close();
        await Bun.sleep(500);
      }
      throw new Error(`no TCP MQTT listener on ${tcpPort}`);
    }
    // Over WebSocket the credential goes on the upgrade request.
    const auth = who === "administrator" ? adminBasic() : who === "non-admin Harper user" ? basicOf(NON_ADMIN.username, NON_ADMIN.password) : undefined;
    const { client, opened } = await MqttClient.open(`${harper.httpURL.replace(/^http/, "ws")}/`, auth);
    clients.push(client);
    expect(opened, `${transport} ${who}: the MQTT-over-WebSocket upgrade was accepted`).toBe(true);
    return client;
  }

  /** CONNECT with a will; over TCP a non-admin presents its Harper credentials in CONNECT. Answers the client id. */
  async function connectWithWill(client: MqttClient, transport: Transport, who: Who, will: { topic: string; payload: unknown; retain: boolean }): Promise<string> {
    const creds = transport === "tcp" && who === "non-admin Harper user" ? NON_ADMIN : {};
    const clientId = `${run}-${randomUUID()}`;
    const connack = await client.connect({ clientId, ...creds, will });
    expect({ transport, who, connack }).toEqual({ transport, who, connack: { kind: "answered", value: MQTT_REASON.SUCCESS } });
    return clientId;
  }

  async function startTcpListener(): Promise<void> {
    tcpPort = await freePort();
    const set = await adminOp({ operation: "set_configuration", mqtt_network_port: tcpPort });
    expect(set.status, await set.text()).toBe(200);
    const restart = await adminOp({ operation: "restart_service", service: "http_workers" });
    expect(restart.status, await restart.text()).toBe(200);
    // The restarted worker replays stored wills 2 s after its components load;
    // let that pass before this file registers any.
    const probe = await openSession("tcp", "administrator");
    await probe.close();
    await Bun.sleep(4_000);
  }

  beforeAll(async () => {
    harper = await startHarper({ installDir, mqttWebSocket: true });
    assertOwnInstance(harper);
    expect(typeof harper.getLog, "the harness captures Harper's log").toBe("function");
    const kp = nacl.sign.keyPair();
    const tablePerms = { read: true, insert: true, update: true, delete: true, attribute_permissions: [] };
    for (const op of [
      { operation: "upsert", database: "flair", table: "Agent", records: [{ id: owner, name: owner, role: "agent", publicKey: Buffer.from(kp.publicKey).toString("base64"), createdAt: now() }] },
      { operation: "add_role", role: `${run}-role`, permission: { super_user: false, flair: { tables: { Memory: tablePerms, MemoryUsage: tablePerms } } } },
      { operation: "add_user", role: `${run}-role`, username: NON_ADMIN.username, password: NON_ADMIN.password, active: true },
    ]) {
      const res = await adminOp(op);
      expect(res.status, `${op.operation}: ${await res.text()}`).toBe(200);
    }
    await startTcpListener();
  }, 240_000);

  afterAll(async () => {
    for (const c of clients) await c.drop().catch(() => {});
    if (harper) await stopHarper(harper);
    // This file's own temp directory (the helper does not remove a directory it was handed).
    rmSync(installDir, { recursive: true, force: true });
  }, 120_000);

  const REFUSED: Array<[Transport, Who]> = [
    ["tcp", "non-admin Harper user"],
    ["tcp", "unauthenticated session"],
    ["ws", "non-admin Harper user"],
    ["ws", "unauthenticated session"],
  ];

  test("(1) a will published as its session drops: refused for a non-admin and an unauthenticated session, applied for an administrator; a will on a non-table topic is not decided by the policy", async () => {
    const admin = await openSession("ws", "administrator");
    expect((await admin.connect({ clientId: `${run}-watch` })).kind).toBe("answered");
    expect(await admin.subscribe(["MemoryUsage/#"])).toEqual({ kind: "answered", value: [0] });

    for (const [transport, who] of REFUSED) {
      const id = `${run}-drop-${transport}-${who.split(" ")[0]}`;
      await insertRow(id);
      const client = await openSession(transport, who);
      const clientId = await connectWithWill(client, transport, who, rewrite(id));
      await client.drop();
      const deadline = Date.now() + 10_000;
      while (loggedAfter(log(), DROP_FAILED + clientId) === undefined && Date.now() < deadline) await Bun.sleep(50);
      const reason = loggedAfter(log(), DROP_FAILED + clientId) ?? "(no log line)";
      // A locally authorized session reaches the policy; a non-admin Harper user
      // may be stopped first by Harper's own check on reading its stored will.
      const allowed = who === "unauthenticated session" ? POLICY_REFUSALS : [...POLICY_REFUSALS, HARPER_ACCESS_REFUSAL];
      expect({ transport, who, refused: allowed.some((r) => reason.includes(r)) }, reason.slice(0, 200)).toEqual({ transport, who, refused: true });
      await Bun.sleep(500);
      expect({ transport, who, content: await storedMemoryId(id) }).toEqual({ transport, who, content: `${id} original` });
      expect({ transport, who, delivered: admin.receivedText.includes(`${id} rewritten`) }).toEqual({ transport, who, delivered: false });
    }

    // Positive control: an administrator's retained will applies and is delivered.
    const adminRow = `${run}-drop-ws-administrator`;
    await insertRow(adminRow);
    const owned = await openSession("ws", "administrator");
    const ownedId = await connectWithWill(owned, "ws", "administrator", rewrite(adminRow));
    await owned.drop();
    const delivered = await admin.waitForPublish((p) => p.text.includes(`${adminRow} rewritten`), 10_000);
    const ownedFailure = loggedAfter(log(), DROP_FAILED + ownedId);
    expect(ownedFailure, "Harper published the administrator's will").toBeUndefined();
    expect(await storedMemoryId(adminRow)).toBe(`${adminRow} rewritten`);
    expect(delivered?.topic, "the administrator's will reaches the subscription").toBeDefined();

    // A will on a path another resource serves is that resource's to decide.
    // The session is one Harper authorizes locally, so Harper publishes the
    // will as it drops and the resource's own rules answer it.
    const before = count(log(), POLICY_REFUSALS);
    const other = await openSession("tcp", "unauthenticated session");
    const otherId = await connectWithWill(other, "tcp", "unauthenticated session", { topic: `FeedMemories/${run}-feed`, payload: { content: `${run} feed will` }, retain: true });
    await other.drop();
    await Bun.sleep(1_500);
    expect(count(log(), POLICY_REFUSALS), "a non-table will adds no policy refusal").toBe(before);
    const otherReason = loggedAfter(log(), DROP_FAILED + otherId) ?? "";
    expect(POLICY_REFUSALS.some((r) => otherReason.includes(r)), otherReason.slice(0, 200)).toBe(false);
  }, 180_000);

  test("(2) a will Harper replays at startup is refused for every table, an administrator's included", async () => {
    const sessions: Array<[Transport, Who]> = [...REFUSED, ["ws", "administrator"]];
    const rows: string[] = [];
    for (const [transport, who] of sessions) {
      const id = `${run}-replay-${transport}-${who.split(" ")[0]}`;
      rows.push(id);
      await insertRow(id);
      await connectWithWill(await openSession(transport, who), transport, who, rewrite(id));
    }
    const stored = await adminOp({ operation: "search_by_value", database: "system", table: "hdb_session_will", search_attribute: "topic", search_value: `MemoryUsage/${run}-replay-*`, get_attributes: ["id", "topic", "retain"] });
    const storedRows = await stored.json();
    expect(Array.isArray(storedRows) ? storedRows.length : storedRows, "every session's will is stored").toBe(sessions.length);

    // Kill Harper while every session is connected, so no will is published on the way down.
    const pid = harper.process!.pid!;
    const exited = new Promise<void>((resolve) => harper.process!.once("exit", () => resolve()));
    process.kill(pid, "SIGKILL");
    await exited;
    await stopHarper(harper); // releases this instance's database locks; the directory is kept
    for (const c of clients.splice(0)) await c.drop().catch(() => {});

    harper = await startHarper({ installDir, mqttWebSocket: true });
    assertOwnInstance(harper);
    const replayed = () => rows.filter((id) => replayFailedFor(log(), `${id} rewritten`)).length;
    const deadline = Date.now() + 30_000;
    while (replayed() < rows.length && Date.now() < deadline) await Bun.sleep(100);
    await Bun.sleep(1_000);
    const outcomes = [];
    for (const [i, [transport, who]] of sessions.entries()) {
      outcomes.push({ transport, who, replayRefused: replayFailedFor(log(), `${rows[i]} rewritten`), row: await storedMemoryId(rows[i]) });
    }
    expect(outcomes).toEqual(sessions.map(([transport, who], i) => ({ transport, who, replayRefused: true, row: `${rows[i]} original` })));
  }, 240_000);
});
