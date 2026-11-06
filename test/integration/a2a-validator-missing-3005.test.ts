// ─── flair#3005 — A2A reports a missing OrgEvent validator ──────────────────
//
// The A2A message/send handler answers a missing OrgEvent validator with
// `org_event_validator_missing`, distinct from `org_event_row_invalid`. This
// test makes the OrgEvent table's own `validate` method unavailable for one
// request in a real, HOME-isolated Harper
// (test/fixtures/org-event-validator-missing-3005's probe resource), sends an
// A2A message/send, and asserts the HTTP/JSON-RPC code, `data.error`, and that no event reached staging or the table. The
// validator is then restored and a control message lands its event, so the
// absence above is measured against a live write path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, type ProbeComponent, type ProbeFiles } from "../helpers/component-with-replay-probe";

const VALIDATOR_PROBE: ProbeFiles = {
  source: join("test", "fixtures", "org-event-validator-missing-3005", "probe.js"),
  target: join("dist", "resources", "zz-org-event-validator-missing-3005.js"),
  out: "org-event-validator-missing-3005", // unused by the composer; the probe writes staged.jsonl under ROOTPATH
};

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

const sfx = Date.now().toString(36);
const A2A = mkAgent(`validator-missing-a2a-${sfx}`);

let harper: HarperInstance;
let installDir = "";
let composed: ProbeComponent | undefined;

function assertOwnInstance(h: HarperInstance): void {
  for (const u of [new URL(h.httpURL), new URL(h.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (new URL(h.httpURL).port === new URL(h.opsURL).port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ database: "flair", ...operation }),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text ? JSON.parse(text) : null;
}

async function probe(action: string): Promise<any> {
  const res = await fetch(`${harper.httpURL}/OrgEventValidatorMissingProbe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ action }),
  });
  const text = await res.text();
  expect(res.status, `${action}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function staged(): Promise<any[]> {
  return (await probe("staged")).staged;
}

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

function sendA2A(text: string): Promise<{ status: number; raw: string }> {
  const path = "/a2a";
  return fetch(harper.httpURL + path, {
    method: "POST",
    headers: { Authorization: ed25519(A2A, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 11, method: "message/send",
      params: { agentId: A2A.id, message: { parts: [{ text }] } },
    }),
  }).then(async (res) => ({ status: res.status, raw: await res.text() }));
}

async function eventsByScope(agentId: string): Promise<any[]> {
  return ops({
    operation: "search_by_value", table: "OrgEvent",
    search_attribute: "scope", search_value: agentId, get_attributes: ["id", "kind"],
  });
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  composed = componentWithReplayProbe({ probe: VALIDATOR_PROBE });
  harper = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot });
  installDir = harper.installDir;
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", table: "Agent",
    records: [{ id: A2A.id, name: A2A.id, role: "agent", publicKey: A2A.publicKey, createdAt: new Date().toISOString() }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
  composed?.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("flair#3005 — a missing OrgEvent validator answers org_event_validator_missing", () => {
  test("an A2A message/send with no OrgEvent validator answers 500 with the distinct code and stages nothing", async () => {
    await probe("reset");
    const absent = await probe("validator-absent");
    expect(absent.hadValidator, "the probe must find the table's own validator").toBe(true);
    expect(absent.absent, "the table must expose no validator for this request").toBe(true);

    const res = await sendA2A("validator missing");
    expect(res.status, res.raw.slice(0, 300)).toBe(500);
    expect(JSON.parse(res.raw)).toEqual({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32000, message: "Server error", data: { error: "org_event_validator_missing" } },
    });
    expect((await staged()).filter((row) => row.scope === A2A.id), "no event may reach staging").toHaveLength(0);
    expect(await eventsByScope(A2A.id), "no event may survive").toHaveLength(0);

    const restored = await probe("validator-restore");
    expect(restored.restored, "the validator must be restored for the control").toBe(true);

    // Positive control: with the validator back, the same request lands its event.
    await probe("reset");
    const control = await sendA2A("control message");
    expect(control.status, control.raw.slice(0, 300)).toBe(200);
    expect((await staged()).filter((row) => row.scope === A2A.id), "the control row must reach staging").toHaveLength(1);
    expect(await eventsByScope(A2A.id), "the control event must land").toHaveLength(1);
  }, 120_000);
});
