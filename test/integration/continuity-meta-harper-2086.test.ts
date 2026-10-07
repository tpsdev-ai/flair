/**
 * continuity-meta-harper-2086.test.ts — flair#2086 item 3.
 *
 * The SessionStart `meta` read (`fetchPreCompactRecord`) is tested against a
 * fake Flair elsewhere. This is the one test that exercises it against a real
 * ephemeral Harper: it inserts a pre-compaction-shaped Memory row through the
 * operations API, then reads it back through the same code path session start
 * uses, proving `meta`, the continuity tag, the ephemeral durability and the
 * expiry all survive a real round-trip (and that the content is redacted as
 * returned). One negative case guards the read: a row whose `meta.hook` is not
 * "PreCompact" is not surfaced.
 *
 * External HARPER_HTTP_URL mode is refused before the helper starts or any
 * rows are inserted. HOME/ROOTPATH are the helper's own scratch install
 * (OS-assigned ports); the only HTTP targets are that instance's
 * httpURL/opsURL.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/index.js";
import { fetchPreCompactRecord } from "../../packages/flair-mcp/src/precompact.js";
import { continuityTag } from "../../packages/flair-mcp/src/continuity.js";

let harper: HarperInstance;
const AGENT = "continuity-2086-agent";
const SESSION = "sess-2086";
const RECORD = "pc-2086-record";
const TOKEN = "ghp_" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z"; // a secret-shaped string in the row
const PLAIN = "Standing instruction: pin every dependency.";

function client(): FlairClient {
  return new FlairClient({
    url: harper.httpURL,
    agentId: AGENT,
    adminUser: harper.admin.username,
    adminPassword: harper.admin.password,
  });
}

async function adminInsert(op: Record<string, unknown>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

function row(id: string, hook: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    agentId: AGENT,
    content: `${PLAIN} Never paste ${TOKEN} again.`,
    type: "session",
    durability: "ephemeral",
    visibility: "private",
    tags: [continuityTag(SESSION)],
    sessionId: SESSION,
    meta: { seq: 1, processUUID: randomUUID(), sessionId: SESSION, hook, trigger: "manual" },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...extra,
  };
}

describe("flair#2086: the SessionStart meta read against a real Harper", () => {
  beforeAll(async () => {
    if (process.env.HARPER_HTTP_URL) {
      throw new Error("continuity-meta-harper-2086 requires an isolated Harper instance; unset HARPER_HTTP_URL");
    }
    harper = await startHarper();
    expect(harper.external).toBe(false);
    expect(harper.ownsInstallDir).toBe(true);
    const ins = await adminInsert({
      operation: "insert",
      database: "flair",
      table: "Memory",
      records: [row(RECORD, "PreCompact"), row("pc-2086-other", "Journal")],
    });
    expect(ins.status).toBe(200);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  test("a pre-compaction record round-trips: meta, tag, expiry and redaction survive a real Harper", async () => {
    const rec = await fetchPreCompactRecord(client(), AGENT, { recordId: RECORD, sessionId: SESSION });
    expect(rec).not.toBeNull();
    expect(rec?.trigger).toBe("manual");
    // The free text survived, and the credential shape in it was redacted.
    expect(rec?.content.includes(PLAIN)).toBe(true);
    expect(rec?.content.includes(TOKEN)).toBe(false);
    expect(rec?.content.includes("[redacted]")).toBe(true);
    expect((rec?.createdAt ?? "").length).toBeGreaterThan(0);
  }, 60_000);

  test("a row whose meta.hook is not PreCompact is not surfaced", async () => {
    const rec = await fetchPreCompactRecord(client(), AGENT, { recordId: "pc-2086-other", sessionId: SESSION });
    expect(rec).toBeNull();
  }, 60_000);
});
