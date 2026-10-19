// Table subscriptions, publishes and retained publishes over MQTT follow the
// table-subscription policy (resources/table-subscription-policy.ts).
//
// Flair runs Harper with MQTT off. This file starts each test-Harper with
// Harper's MQTT-over-WebSocket path ON (StartHarperOptions.mqttWebSocket), the
// state of an instance whose MQTT configuration was turned on, and checks that
// an exported table's MQTT topics (`<Table>/#`, `<Table>/<id>`) admit only
// administrators and trusted internal calls, as its SSE and WebSocket routes
// do (test/integration/table-subscription-default-deny.test.ts):
//   (a) ENUMERATION — every table in the flair database, read from the
//       database at runtime. A verified non-admin agent's SUBSCRIBE to each
//       table's collection topic and to the by-id topic of a row committed to
//       that table is refused (SUBACK 0x87; 0x8F is also accepted for a table
//       an administrator cannot list, which has no topic). A marker row is
//       then committed to EVERY table (each attribute the table requires
//       filled from its declared type): the administrator's subscription
//       receives it for every table an administrator can list whose path is
//       the table (not AgentReadPosition or OAuthToken, which another resource
//       serves), and the non-admin's connection receives no byte of any
//       marker. For every table but those two paths, the non-admin's PUBLISH,
//       retained PUBLISH and retained delete are refused — with the policy's
//       own reason string on a listed table (0x90/0x80 also accepted where the
//       table has no topic) — the row reads back unchanged, and none reaches
//       the administrator's subscription. The administrator's PUBLISH to each
//       listed table passes the policy and is delivered where the table
//       accepts a publish — required for Memory, Message, MemoryUsage and
//       Agent; a table whose own rules refuse even an administrator's publish
//       (AgentKeyRegistration and InstructionVersion today) is recorded.
//   (b) Memory, Message and MemoryUsage refuse a non-admin subscriber and
//       deliver nothing, including rows written after the attempt; an
//       anonymous subscriber is refused (CONNACK or SUBACK failure, whichever
//       Harper returns for the instance's authorizeLocal setting).
//   (c) Administrators (Basic and an admin agent) still subscribe and receive
//       the live committed row (the positive control: MQTT over WebSocket is on
//       and delivers).
//   (d) A non-admin and an anonymous PUBLISH to the Memory topic are refused
//       and reach neither an administrator's MQTT subscription nor an SSE one;
//       an administrator's publish is accepted and delivered to both.
//   (f) Retained PUBLISH over WebSocket: the non-admin's retained publish and
//       retained delete (to another agent's Memory row, to a Memory row of its
//       own — one it may write over HTTP — and creating an admin Agent row) and
//       an anonymous caller's are refused, and the rows read back unchanged;
//       an administrator's retained publish writes, overwrites and deletes.
//   (e) MQTT on a TCP listener, whose connection carries no HTTP request:
//       SUBSCRIBE, PUBLISH, retained PUBLISH and retained delete are refused
//       for an administrator's CONNECT credentials, a non-admin Harper user and
//       an unauthenticated session (or the session is refused at CONNECT), and
//       the rows read back unchanged.
//
// As in the SSE/WebSocket file, each Harper is checked twice: before the
// least-privilege `flair-agent` Harper user is provisioned (verified agents
// then resolve to the shared admin Harper user) and after; and on two Harpers,
// one per `authentication.authorizeLocal` setting.
//
// Mutation checks: remove the subscribe() guard and (a)/(b) go red; remove the
// publish() guard and (a)/(d) go red; remove the retained put()/delete() guard
// and (a)/(f) go red; treat a protocol-layer call without an HTTP request as
// internal and (e) goes red.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { MQTT_REASON, MqttClient } from "../helpers/mqtt-client";
import { commitMarkerRow, flairTableShapes, type TableShape } from "../helpers/table-markers";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

/**
 * Refuse to talk to anything but this test's own ephemeral instance: loopback,
 * the OS-assigned ports this instance was started on, never a production port,
 * and a data directory under the temp dir.
 */
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  const httpPort = Number(http.port);
  const opsPort = Number(ops.port);
  for (const [label, u, port] of [["http", http, httpPort], ["ops", ops, opsPort]] as const) {
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (httpPort === opsPort || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

function basicAuth(harper: HarperInstance): string {
  return "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
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

/** An SSE subscription that records the ids and raw text it received. */
function openSse(url: string, authorization: string) {
  const ctrl = new AbortController();
  let status: number | undefined;
  let text = "";
  const pump = (async () => {
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream", Authorization: authorization }, signal: ctrl.signal });
      status = res.status;
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    } catch { /* aborted by stop() */ }
  })();
  return {
    status: () => status,
    text: () => text,
    waitForText: async (needle: string, ms = 10_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (text.includes(needle)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return text.includes(needle);
    },
    stop: async () => { ctrl.abort(); await pump; },
  };
}

const A = mkAgent("tmq-a"); // owns private rows
const B = mkAgent("tmq-b"); // verified non-admin subscriber, party to nothing of A's
const C = mkAgent("tmq-c"); // A's message recipient
const ADMIN = mkAgent("tmq-admin"); // an admin agent (role "admin")

// Paths that share a table's name but are served by a resource that is not the
// table (see table-subscription-default-deny.test.ts). They implement no
// subscription, so an MQTT subscriber there receives nothing of the table.
const NOT_TABLE_ROUTES = new Set(["AgentReadPosition", "OAuthToken"]);

/** The policy's refusal of a table publish to a verified non-admin agent (resources/table-subscription-policy.ts). */
const POLICY_PUBLISH_REFUSAL = "table publishes are for administrators";

const HARPERS = [
  { name: "authorizeLocal on (harness default)", authorizeLocal: undefined },
  { name: "authorizeLocal off", authorizeLocal: "false" },
] as const;

for (const config of HARPERS) {
  describe(`table subscriptions and publishes over MQTT are served to administrators only — ${config.name}`, () => {
    let harper: HarperInstance;
    const tag = config.authorizeLocal ?? "default";
    const opened: MqttClient[] = [];

    async function adminOp(op: Record<string, any>): Promise<Response> {
      return fetch(harper.opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basicAuth(harper) },
        body: JSON.stringify(op),
      });
    }

    async function adminInsert(table: string, record: Record<string, unknown>): Promise<void> {
      const res = await adminOp({ operation: "upsert", database: "flair", table, records: [record] });
      const text = await res.text();
      expect(res.status, `insert into ${table} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    }

    async function writeMemory(agent: TestAgent, body: Record<string, unknown>): Promise<void> {
      const path = "/FeedMemories";
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "POST",
        headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, ...body }),
      });
      const text = await res.text();
      expect(res.status, `memory write ${String(body.id)} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    }

    const now = () => new Date().toISOString();
    const wsBase = () => harper.httpURL.replace(/^http/, "ws");

    /**
     * An MQTT-over-WebSocket session for `as`: the credential goes on the
     * WebSocket upgrade request, the way SSE and WebSocket subscribers present
     * it. Answers the CONNACK reason code; the session is closed in afterAll.
     */
    async function mqttAs(as: TestAgent | "basic" | "anonymous"): Promise<{ client: MqttClient; connack: number | string }> {
      const auth = as === "anonymous" ? undefined : as === "basic" ? basicAuth(harper) : ed25519Header(as, "GET", "/");
      const { client, opened: ok } = await MqttClient.open(`${wsBase()}/`, auth);
      opened.push(client);
      expect(ok, "the MQTT-over-WebSocket upgrade was accepted").toBe(true);
      expect(client.protocol, "Harper's MQTT handler took the upgrade").toBe("mqtt");
      const ack = await client.connect({ clientId: `tmq-${tag}-${randomUUID()}` });
      return { client, connack: ack.kind === "answered" ? ack.value : ack.kind };
    }

    /** SUBACK codes, or the reason the SUBSCRIBE got no SUBACK. */
    async function suback(client: MqttClient, filters: string[]): Promise<number[] | string> {
      const res = await client.subscribe(filters);
      return res.kind === "answered" ? res.value : res.kind;
    }

    /** Tables in the flair database, read from the database itself (test/helpers/table-markers.ts). */
    const flairTables = () => flairTableShapes(adminOp);

    /** Whether an administrator's collection read of `/<table>/` returns the table's rows. */
    async function listedByAdmin(table: string): Promise<boolean> {
      const res = await fetch(`${harper.httpURL}/${table}/`, { headers: { Authorization: basicAuth(harper), Accept: "application/json" } });
      const text = await res.text();
      if (res.status !== 200) return false;
      try { return Array.isArray(JSON.parse(text)); } catch { return false; }
    }

    /** Commit a row to `table` whose primary key is `key` (test/helpers/table-markers.ts). */
    const insertMarkerRow = (table: string, shape: TableShape, key: string) => commitMarkerRow(adminOp, table, shape, key);

    /** The stored row of `table` whose primary key is `key`, read through the operations API; undefined when absent. */
    async function storedRow(table: string, primaryKey: string, key: string): Promise<Record<string, unknown> | undefined> {
      const res = await adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: primaryKey, search_value: key, get_attributes: ["*"] });
      const text = await res.text();
      expect(res.status, `read ${table} ${key}: ${text.slice(0, 200)}`).toBe(200);
      const rows = JSON.parse(text);
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
    }

    /** `row` with every attribute that holds `from` set to `to`, and the primary key set to `key`. */
    function variant(row: Record<string, unknown>, primaryKey: string, from: string, to: string, key: string): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = v === from ? to : v;
      out[primaryKey] = key;
      return out;
    }

    function cases(phase: string) {
      const p = `tmq-${tag}-${phase}`;
      const ids = {
        memory: `${p}-a-private-memory`,
        message: `${p}-a-to-c-message`,
        usage: `${A.id}:${p}-a-private-memory`,
      };

      beforeAll(async () => {
        await writeMemory(A, { id: ids.memory, content: `${p} a private`, visibility: "private" });
        await adminInsert("Message", { id: ids.message, from: A.id, to: C.id, threadId: `${p}-thread`, seq: 0, kind: "message", body: `${p} body for c only`, state: "delivered", createdAt: now() });
        await adminInsert("MemoryUsage", { id: ids.usage, agentId: A.id, memoryId: ids.memory, createdAt: now() });
      }, 60_000);

      test("(a) every table: a non-admin is refused SUBSCRIBE on its collection and by-id topics; a marker row committed to each table reaches the administrator's subscription and not the non-admin; the non-admin's PUBLISH and retained PUBLISH (write and delete) to each table are refused, leave the row unchanged and reach no subscriber; an administrator's PUBLISH passes the policy and is delivered on the positive-control tables", async () => {
        const schema = await flairTables();
        const tables = [...schema.keys()];
        const listed: string[] = [];
        for (const t of tables) if (await listedByAdmin(t)) listed.push(t);
        // Not vacuous: the enumeration reaches the topics this rule exists for.
        for (const t of ["Memory", "Message", "MemoryUsage", "Agent"]) expect(listed, `${t} is listed by an administrator`).toContain(t);
        // Tables whose topic is the table itself (an administrator can list it,
        // and its path is not served by another resource).
        const tableTopics = listed.filter((t) => !NOT_TABLE_ROUTES.has(t));

        const run = `${p}-enum-${randomUUID().slice(0, 8)}`;
        const keyOf = (t: string) => `${run}-${t}`;
        const found: string[] = [];

        const { client: nonAdmin, connack } = await mqttAs(B);
        expect(connack, "a verified agent's MQTT session is accepted").toBe(MQTT_REASON.SUCCESS);
        const { client: admin, connack: adminAck } = await mqttAs("basic");
        expect(adminAck).toBe(MQTT_REASON.SUCCESS);

        // SUBSCRIBE: the non-admin to every table's collection topic and to the
        // by-id topic of the row committed below; the administrator to every
        // collection topic.
        const filters = tables.flatMap((t) => [{ table: t, filter: `${t}/#`, collection: true }, { table: t, filter: `${t}/${keyOf(t)}`, collection: false }]);
        const codes = await suback(nonAdmin, filters.map((f) => f.filter));
        expect(Array.isArray(codes), `SUBACK for ${filters.length} filters: ${String(codes)}`).toBe(true);
        filters.forEach((f, i) => {
          if (NOT_TABLE_ROUTES.has(f.table)) return; // not the table: it only has to deliver none of the table's rows
          const code = (codes as number[])[i];
          // A table an administrator can list has a topic, so its filters must
          // be refused by the policy itself (0x87), not missed.
          const allowed: number[] = listed.includes(f.table)
            ? [MQTT_REASON.NOT_AUTHORIZED]
            : [MQTT_REASON.NOT_AUTHORIZED, MQTT_REASON.TOPIC_FILTER_INVALID, MQTT_REASON.UNSPECIFIED_ERROR];
          if (!allowed.includes(code)) found.push(`${f.filter}: SUBACK 0x${code?.toString(16)}, expected ${allowed.map((c) => `0x${c.toString(16)}`).join(" or ")}`);
        });
        const adminCodes = await suback(admin, tables.map((t) => `${t}/#`));
        expect(Array.isArray(adminCodes), String(adminCodes)).toBe(true);
        tables.forEach((t, i) => {
          if (tableTopics.includes(t) && (adminCodes as number[])[i] !== MQTT_REASON.SUCCESS) found.push(`administrator SUBSCRIBE ${t}/#: 0x${(adminCodes as number[])[i].toString(16)}`);
        });

        const rows = new Map<string, Record<string, unknown>>();
        try {
          // A committed marker row in every table.
          for (const t of tables) rows.set(t, await insertMarkerRow(t, schema.get(t)!, keyOf(t)));
          for (const t of tableTopics) {
            const hit = await admin.waitForPublish((m) => m.topic === `${t}/${keyOf(t)}`, 5_000);
            if (!hit) found.push(`the administrator's ${t}/# subscription did not receive the row committed to ${t}`);
          }
          await new Promise((r) => setTimeout(r, 500));
          if (nonAdmin.receivedText.includes(run)) found.push(`a committed marker row reached the non-admin subscriber`);
          const delivered = nonAdmin.publishes.filter((m) => !NOT_TABLE_ROUTES.has(m.topic.split("/")[0]));
          if (delivered.length > 0) found.push(`the non-admin received ${delivered.length} table messages: ${delivered.map((m) => m.topic).join(", ")}`);

          // PUBLISH, retained PUBLISH and a retained delete by the non-admin, to
          // every table topic. For a table with a topic, the refusal is the
          // policy's own (its reason string), not a table's write rule.
          for (const t of tables) {
            if (NOT_TABLE_ROUTES.has(t)) continue;
            const { primaryKey } = schema.get(t)!;
            const key = keyOf(t);
            const row = rows.get(t)!;
            const outcomes: Array<[string, Awaited<ReturnType<MqttClient["publishDetailed"]>>]> = [
              ["PUBLISH", await nonAdmin.publishDetailed(`${t}/${key}-b`, variant(row, primaryKey, key, `${key}-b`, `${key}-b`))],
              ["retained PUBLISH", await nonAdmin.publishDetailed(`${t}/${key}`, variant(row, primaryKey, key, `${key}-r`, key), { retain: true })],
              ["retained delete", await nonAdmin.publishDetailed(`${t}/${key}`, null, { retain: true })],
            ];
            for (const [what, outcome] of outcomes) {
              const answered = outcome.kind === "answered" ? outcome.value : undefined;
              const ok = listed.includes(t)
                ? answered?.code === MQTT_REASON.NOT_AUTHORIZED && answered.reason === POLICY_PUBLISH_REFUSAL
                : answered !== undefined && ([MQTT_REASON.NOT_AUTHORIZED, MQTT_REASON.TOPIC_NAME_INVALID, MQTT_REASON.UNSPECIFIED_ERROR] as number[]).includes(answered.code);
              if (!ok) found.push(`${t}: non-admin ${what} answered ${JSON.stringify(outcome)}`);
            }
            const stored = await storedRow(t, primaryKey, key);
            if (!stored) found.push(`${t}: the marker row is gone after the non-admin's retained delete`);
            else if (JSON.stringify(stored).includes(`${key}-r`)) found.push(`${t}: the non-admin's retained PUBLISH changed the row`);
          }

          // The administrator's PUBLISH to every table topic passes the policy,
          // and where the table itself accepts a publish it is delivered: had
          // the non-admin's publishes been accepted, they would have arrived too.
          // A table's own rules may refuse even an administrator's publish
          // (their refusal is not the policy's).
          const tableRefusesPublish: string[] = [];
          for (const t of tableTopics) {
            const { primaryKey } = schema.get(t)!;
            const key = keyOf(t);
            const outcome = await admin.publishDetailed(`${t}/${key}-ad`, variant(rows.get(t)!, primaryKey, key, `${key}-ad`, `${key}-ad`));
            const answered = outcome.kind === "answered" ? outcome.value : undefined;
            if (answered?.code === MQTT_REASON.SUCCESS) {
              if (!(await admin.waitForPublish((m) => m.topic === `${t}/${key}-ad`, 5_000))) found.push(`${t}: the administrator's PUBLISH did not reach the administrator's subscription`);
            } else if (answered !== undefined && answered.reason !== POLICY_PUBLISH_REFUSAL && answered.code === MQTT_REASON.NOT_AUTHORIZED) {
              tableRefusesPublish.push(t);
            } else {
              found.push(`${t}: administrator PUBLISH answered ${JSON.stringify(outcome)}`);
            }
          }
          // Not vacuous: the positive control was delivered on the topics this rule exists for.
          for (const t of ["Memory", "Message", "MemoryUsage", "Agent"]) expect(tableRefusesPublish, `${t} accepts an administrator's publish`).not.toContain(t);
          await new Promise((r) => setTimeout(r, 300));
          for (const t of tables) {
            for (const marker of [`${keyOf(t)}-b`, `${keyOf(t)}-r`]) {
              if (admin.receivedText.includes(marker)) found.push(`${t}: the non-admin's ${marker.endsWith("-b") ? "PUBLISH" : "retained PUBLISH"} reached the administrator's subscription`);
            }
          }
          // The non-admin's own PUBACKs echo its topics in their reason strings,
          // so after it has published, its connection is checked for messages.
          const later = nonAdmin.publishes.filter((m) => !NOT_TABLE_ROUTES.has(m.topic.split("/")[0]));
          if (later.length > 0) found.push(`the non-admin received ${later.length} table messages: ${later.map((m) => m.topic).join(", ")}`);
        } finally {
          for (const [t, row] of rows) {
            const { primaryKey } = schema.get(t)!;
            await adminOp({ operation: "delete", database: "flair", table: t, ids: [row[primaryKey]] }).then((r) => r.arrayBuffer());
          }
        }
        expect(found, `tables: ${tables.join(", ")}; listed by an administrator: ${listed.join(", ")}`).toEqual([]);
      }, 240_000);

      for (const [label, filter, liveWrite] of [
        ["Memory", "Memory/#", async (marker: string) => writeMemory(A, { id: marker, content: `${marker} live`, visibility: "private" })],
        ["Memory by id", `Memory/${ids.memory}`, async (marker: string) => writeMemory(A, { id: ids.memory, content: `${marker} v2`, visibility: "private" })],
        ["Message", "Message/#", async (marker: string) => adminInsert("Message", { id: marker, from: A.id, to: C.id, threadId: `${p}-thread`, seq: 1, kind: "message", body: `${marker} body`, state: "delivered", createdAt: now() })],
        ["MemoryUsage", "MemoryUsage/#", async (marker: string) => adminInsert("MemoryUsage", { id: `${A.id}:${marker}`, agentId: A.id, memoryId: marker, createdAt: now() })],
      ] as const) {
        test(`(b) ${label}: a non-admin MQTT subscriber is refused and receives nothing; an anonymous one is refused`, async () => {
          const marker = `${p}-${label.replace(/ /g, "-")}-${randomUUID()}`;
          const { client, connack } = await mqttAs(B);
          expect(connack).toBe(MQTT_REASON.SUCCESS);
          expect(await suback(client, [filter]), `non-admin SUBSCRIBE ${filter}`).toEqual([MQTT_REASON.NOT_AUTHORIZED]);
          await liveWrite(marker);
          await new Promise((r) => setTimeout(r, 500));
          expect(client.receivedText.includes(marker), `the live write reached the non-admin subscriber of ${filter}`).toBe(false);
          expect(client.publishes.map((m) => m.topic), `messages on ${filter}`).toEqual([]);

          const anon = await mqttAs("anonymous");
          if (anon.connack === MQTT_REASON.SUCCESS) {
            // authorizeLocal admits the loopback session; the policy still
            // refuses the subscription as one without a valid credential.
            expect(await suback(anon.client, [filter]), `anonymous SUBSCRIBE ${filter}`).toEqual([MQTT_REASON.UNSPECIFIED_ERROR]);
          } else {
            expect(typeof anon.connack === "number" && anon.connack !== MQTT_REASON.SUCCESS, `anonymous CONNACK ${anon.connack}`).toBe(true);
          }
          expect(anon.client.publishes).toEqual([]);
        }, 60_000);
      }

      test("(c) an administrator still subscribes over MQTT and receives the live committed row (Basic and an admin agent)", async () => {
        const subscribers: Array<[string, MqttClient]> = [];
        for (const as of ["basic", ADMIN] as const) {
          const { client, connack } = await mqttAs(as);
          expect(connack, `${as === "basic" ? "Basic" : "admin agent"} CONNACK`).toBe(MQTT_REASON.SUCCESS);
          expect(await suback(client, ["Memory/#"]), `${as === "basic" ? "Basic" : "admin agent"} SUBSCRIBE Memory/#`).toEqual([MQTT_REASON.SUCCESS]);
          subscribers.push([as === "basic" ? "Basic" : "admin agent", client]);
        }
        const marker = `${p}-admin-live-${randomUUID()}`;
        await writeMemory(A, { id: marker, content: `${marker} live`, visibility: "private" });
        for (const [who, client] of subscribers) {
          const hit = await client.waitForPublish((m) => m.topic === `Memory/${marker}` && m.text.includes(`${marker} live`));
          expect(hit, `${who} receives A's live committed memory`).toBeDefined();
        }
      }, 60_000);

      test("(d) a non-admin and an anonymous MQTT publish to a table topic are refused and reach no subscriber; an administrator's publish is delivered", async () => {
        const { client: watcher } = await mqttAs("basic");
        expect(await suback(watcher, ["Memory/#"])).toEqual([MQTT_REASON.SUCCESS]);
        const sse = openSse(`${harper.httpURL}/Memory/`, basicAuth(harper));
        try {
          const record = (marker: string) => ({ id: marker, agentId: A.id, content: `${marker} published`, visibility: "shared", createdAt: now() });

          const nonAdminMarker = `${p}-pub-agent-${randomUUID()}`;
          const { client: agent } = await mqttAs(B);
          expect(await agent.publish(`Memory/${nonAdminMarker}`, record(nonAdminMarker)), "non-admin PUBLISH (QoS 1)")
            .toEqual({ kind: "answered", value: MQTT_REASON.NOT_AUTHORIZED });
          expect(await agent.publish(`Memory/${nonAdminMarker}-q0`, record(`${nonAdminMarker}-q0`), 0)).toEqual({ kind: "answered", value: MQTT_REASON.SUCCESS });

          const anonMarker = `${p}-pub-anon-${randomUUID()}`;
          const anon = await mqttAs("anonymous");
          if (anon.connack === MQTT_REASON.SUCCESS) {
            expect(await anon.client.publish(`Memory/${anonMarker}`, record(anonMarker)), "anonymous PUBLISH (QoS 1)")
              .toEqual({ kind: "answered", value: MQTT_REASON.UNSPECIFIED_ERROR });
          } else {
            expect(typeof anon.connack === "number" && anon.connack !== MQTT_REASON.SUCCESS, `anonymous CONNACK ${anon.connack}`).toBe(true);
            await anon.client.publish(`Memory/${anonMarker}`, record(anonMarker), 0);
          }

          // The administrator's publish is the positive control: it is accepted
          // and both subscribers receive it, so the refused publishes above
          // would have arrived by now had they been accepted.
          const adminMarker = `${p}-pub-admin-${randomUUID()}`;
          const { client: admin } = await mqttAs("basic");
          expect(await admin.publish(`Memory/${adminMarker}`, record(adminMarker)), "administrator PUBLISH (QoS 1)")
            .toEqual({ kind: "answered", value: MQTT_REASON.SUCCESS });
          expect(await watcher.waitForPublish((m) => m.text.includes(`${adminMarker} published`)), "the MQTT subscriber receives the administrator's publish").toBeDefined();
          expect(await sse.waitForText(`${adminMarker} published`), "the SSE subscriber receives the administrator's publish").toBe(true);
          await new Promise((r) => setTimeout(r, 300));

          for (const marker of [nonAdminMarker, anonMarker]) {
            expect(watcher.receivedText.includes(marker), `${marker} reached the MQTT subscriber`).toBe(false);
            expect(sse.text().includes(marker), `${marker} reached the SSE subscriber`).toBe(false);
          }
        } finally {
          await sse.stop();
        }
      }, 60_000);

      test("(f) retained PUBLISH over WebSocket: a non-admin's (to its own and to another agent's rows) and an anonymous caller's retained publish and retained delete are refused and leave the rows unchanged; an administrator's retained publish writes and deletes the row", async () => {
        const now2 = now();
        const others = `${p}-ret-a-${randomUUID()}`; // A's row
        await adminInsert("Memory", { id: others, agentId: A.id, content: `${others} original`, visibility: "private", durability: "persistent", createdAt: now2 });
        const own = `${p}-ret-b-${randomUUID()}`; // a row B may write over HTTP: its own memory
        const newAgent = `${p}-ret-agent-${randomUUID()}`;
        const memory = (id: string, agentId: string, content: string) => ({ id, agentId, content, visibility: "private", durability: "persistent", createdAt: now() });

        const { client: agent } = await mqttAs(B);
        expect(await agent.publishRetained(`Memory/${others}`, memory(others, A.id, `${others} changed`)), "non-admin retained PUBLISH to another agent's row")
          .toEqual({ kind: "answered", value: MQTT_REASON.NOT_AUTHORIZED });
        expect(await agent.publishRetained(`Memory/${others}`, null), "non-admin retained delete of another agent's row")
          .toEqual({ kind: "answered", value: MQTT_REASON.NOT_AUTHORIZED });
        expect(await agent.publishRetained(`Memory/${own}`, memory(own, B.id, `${own} by retained publish`)), "non-admin retained PUBLISH of its own row")
          .toEqual({ kind: "answered", value: MQTT_REASON.NOT_AUTHORIZED });
        expect(await agent.publishRetained(`Agent/${newAgent}`, { id: newAgent, name: newAgent, role: "admin", publicKey: "not-a-key", createdAt: now() }), "non-admin retained PUBLISH creating an admin Agent row")
          .toEqual({ kind: "answered", value: MQTT_REASON.NOT_AUTHORIZED });

        const anon = await mqttAs("anonymous");
        if (anon.connack === MQTT_REASON.SUCCESS) {
          for (const [what, outcome] of [
            ["retained PUBLISH", await anon.client.publishRetained(`Memory/${others}`, memory(others, A.id, `${others} changed by anonymous`))],
            ["retained delete", await anon.client.publishRetained(`Memory/${others}`, null)],
            ["retained Agent PUBLISH", await anon.client.publishRetained(`Agent/${newAgent}`, { id: newAgent, name: newAgent, role: "admin", publicKey: "not-a-key", createdAt: now() })],
          ] as const) {
            expect(outcome, `anonymous ${what}`).toEqual({ kind: "answered", value: MQTT_REASON.UNSPECIFIED_ERROR });
          }
        } else {
          expect(typeof anon.connack === "number" && anon.connack !== MQTT_REASON.SUCCESS, `anonymous CONNACK ${anon.connack}`).toBe(true);
        }

        const read = async (table: string, id: string) => {
          const res = await adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: "id", search_value: id, get_attributes: ["*"] });
          const rows = await res.json();
          return Array.isArray(rows) ? rows[0] : undefined;
        };
        expect((await read("Memory", others))?.content, "another agent's row is unchanged").toBe(`${others} original`);
        expect(await read("Memory", own), "no row was written for the non-admin's own retained publish").toBeUndefined();
        expect(await read("Agent", newAgent), "no Agent row was created").toBeUndefined();

        // The administrator's retained publish behaves as a write: put, overwrite, delete.
        const { client: admin } = await mqttAs("basic");
        const adminRow = `${p}-ret-admin-${randomUUID()}`;
        expect(await admin.publishRetained(`Memory/${adminRow}`, memory(adminRow, A.id, `${adminRow} written`))).toEqual({ kind: "answered", value: MQTT_REASON.SUCCESS });
        expect((await read("Memory", adminRow))?.content, "the administrator's retained publish wrote the row").toBe(`${adminRow} written`);
        expect(await admin.publishRetained(`Memory/${others}`, memory(others, A.id, `${others} changed by admin`))).toEqual({ kind: "answered", value: MQTT_REASON.SUCCESS });
        expect((await read("Memory", others))?.content).toBe(`${others} changed by admin`);
        expect(await admin.publishRetained(`Memory/${adminRow}`, null)).toEqual({ kind: "answered", value: MQTT_REASON.SUCCESS });
        expect(await read("Memory", adminRow), "the administrator's retained delete removed the row").toBeUndefined();
      }, 60_000);
    }

    beforeAll(async () => {
      // startHarper copies process.env into the spawned Harper's environment;
      // restore it immediately so no other file sees the override.
      const prior = process.env.AUTHENTICATION_AUTHORIZELOCAL;
      if (config.authorizeLocal === undefined) delete process.env.AUTHENTICATION_AUTHORIZELOCAL;
      else process.env.AUTHENTICATION_AUTHORIZELOCAL = config.authorizeLocal;
      try {
        harper = await startHarper({ mqttWebSocket: true });
        assertOwnInstance(harper);
      } finally {
        if (prior === undefined) delete process.env.AUTHENTICATION_AUTHORIZELOCAL;
        else process.env.AUTHENTICATION_AUTHORIZELOCAL = prior;
      }
      for (const [ag, role] of [[A, "agent"], [B, "agent"], [C, "agent"], [ADMIN, "admin"]] as const) {
        await adminInsert("Agent", { id: ag.id, name: ag.id, role, publicKey: ag.publicKey, createdAt: now() });
      }
    }, 180_000);

    afterAll(async () => {
      await Promise.all(opened.map((c) => c.close()));
      if (harper) await stopHarper(harper);
    }, 30_000);

    test("the Harper under test serves MQTT over WebSocket", async () => {
      const res = await adminOp({ operation: "get_configuration" });
      const cfg = await res.json();
      expect(res.status).toBe(200);
      expect(cfg?.mqtt?.webSocket, "mqtt.webSocket").toBe(true);
    }, 30_000);

    describe("agents resolve to the shared admin Harper user", () => {
      cases("shared-user");
    });

    describe("agents resolve to the least-privilege flair-agent user", () => {
      beforeAll(async () => {
        await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
        await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
      }, 60_000);

      cases("flair-agent");
    });

    test("(e) MQTT on a TCP listener (no HTTP request): SUBSCRIBE, PUBLISH, retained PUBLISH and retained delete are refused for an administrator's CONNECT credentials, a non-admin Harper user and an unauthenticated session; the rows are unchanged", async () => {
      // Turn on a TCP listener on an ephemeral port through the operations API
      // and restart the worker threads, as an operator would.
      const port = await freePort();
      const set = await adminOp({ operation: "set_configuration", mqtt_network_port: port });
      expect(set.status, await set.text()).toBe(200);
      const restart = await adminOp({ operation: "restart_service", service: "http_workers" });
      expect(restart.status, await restart.text()).toBe(200);
      const openTcp = async (): Promise<MqttClient> => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const attempt = await MqttClient.openTcp("127.0.0.1", port, 2_000);
          if (attempt.opened) { opened.push(attempt.client); return attempt.client; }
          await attempt.client.close();
          await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error(`no TCP MQTT listener on ${port}`);
      };

      // A Harper user that is not a super user, with full permissions on two tables.
      const role = `tmq-${tag}-role`;
      const user = `tmq-${tag}-user`;
      const userPass = `tmq-${tag}-not-a-secret`;
      const tablePerms = { read: true, insert: true, update: true, delete: true, attribute_permissions: [] };
      for (const op of [
        { operation: "add_role", role, permission: { super_user: false, flair: { tables: { Memory: tablePerms, Agent: tablePerms } } } },
        { operation: "add_user", role, username: user, password: userPass, active: true },
      ]) {
        const res = await adminOp(op);
        expect(res.status, `${op.operation}: ${await res.text()}`).toBe(200);
      }

      const rowId = `tmq-${tag}-tcp-row-${randomUUID()}`;
      await adminInsert("Memory", { id: rowId, agentId: A.id, content: `${rowId} original`, visibility: "private", durability: "persistent", createdAt: now() });
      const read = async (table: string, id: string) => {
        const res = await adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: "id", search_value: id, get_attributes: ["*"] });
        const rows = await res.json();
        return Array.isArray(rows) ? rows[0] : undefined;
      };

      for (const [who, creds] of [
        ["administrator CONNECT credentials", { username: harper.admin.username, password: harper.admin.password }],
        ["non-admin Harper user", { username: user, password: userPass }],
        ["unauthenticated session", {}],
      ] as const) {
        const tcp = await openTcp();
        const connack = await tcp.connect({ clientId: `tmq-tcp-${randomUUID()}`, ...creds });
        if (who === "unauthenticated session" && !(connack.kind === "answered" && connack.value === MQTT_REASON.SUCCESS)) {
          // authorizeLocal off: Harper refuses the session at CONNECT.
          expect(connack.kind === "answered" && connack.value !== MQTT_REASON.SUCCESS, `${who}: CONNACK ${JSON.stringify(connack)}`).toBe(true);
          continue;
        }
        expect(connack, `${who}: the MQTT session is accepted`).toEqual({ kind: "answered", value: MQTT_REASON.SUCCESS });
        expect(await suback(tcp, ["Memory/#", "Message/#"]), `${who}: SUBSCRIBE`).toEqual([MQTT_REASON.UNSPECIFIED_ERROR, MQTT_REASON.UNSPECIFIED_ERROR]);
        const marker = `tmq-${tag}-tcp-${randomUUID()}`;
        const newAgent = `${marker}-agent`;
        for (const [what, outcome] of [
          ["PUBLISH", await tcp.publish(`Memory/${marker}`, { id: marker, agentId: A.id, content: marker, createdAt: now() })],
          ["retained PUBLISH", await tcp.publishRetained(`Memory/${rowId}`, { id: rowId, agentId: A.id, content: `${rowId} changed`, visibility: "private", durability: "persistent", createdAt: now() })],
          ["retained delete", await tcp.publishRetained(`Memory/${rowId}`, null)],
          ["retained Agent PUBLISH", await tcp.publishRetained(`Agent/${newAgent}`, { id: newAgent, name: newAgent, role: "admin", publicKey: "not-a-key", createdAt: now() })],
        ] as const) {
          expect(outcome, `${who}: ${what}`).toEqual({ kind: "answered", value: MQTT_REASON.UNSPECIFIED_ERROR });
        }
        expect((await read("Memory", rowId))?.content, `${who}: the row is unchanged`).toBe(`${rowId} original`);
        expect(await read("Agent", newAgent), `${who}: no Agent row was created`).toBeUndefined();
        await writeMemory(A, { id: `${marker}-w`, content: `${marker} write`, visibility: "private" });
        await new Promise((r) => setTimeout(r, 500));
        expect(tcp.receivedText.includes(marker), `${who}: a committed write reached the TCP session`).toBe(false);
      }
    }, 180_000);
  });
}
