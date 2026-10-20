/**
 * a2a-tasks-list-beads-2688.test.ts — A2A `tasks/list` over real Beads files,
 * against a real Harper.
 *
 * `tasks/list` reads the instance's task board from `~/ops/.beads` on the
 * Flair host. The Harper child runs with HOME set to its own temporary install
 * directory (test/helpers/harper-lifecycle.ts), so this file writes actual
 * Beads files under `<installDir>/ops/.beads` and nothing outside it.
 *
 * What is pinned, through signed HTTP:
 *   - an authenticated caller can request the unfiltered board;
 *   - `params.agentId` filters by assignee and is not matched to the caller;
 *     `params.status` filters by the mapped A2A status;
 *   - the source is the `.yaml`/`.yml` files under `issues/` when at least one
 *     exists, otherwise `issues.jsonl`; the two sources are never combined;
 *   - an anonymous request is refused and carries no board content.
 *
 * Mutation: make the reader return the YAML issues together with the JSONL
 * issues → "reads only the YAML issue files once any exist ..." fails.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }

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

let harper: HarperInstance;
const A = mkAgent("a2atasks-a");

function assertOwnInstance(h: HarperInstance): void {
  for (const u of [new URL(h.httpURL), new URL(h.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}

/** The Beads root the Harper child reads: `$HOME/ops/.beads`, HOME being the instance's own install dir. */
function beadsRoot(): string {
  return join(harper.installDir, "ops", ".beads");
}

const JSONL_ISSUES = [
  { id: "bd-j1", title: "jsonl one", status: "open", assignee: "alice", updated_at: "2026-10-19T10:00:01Z" },
  { id: "bd-j2", title: "jsonl two", status: "closed", assignee: "bob", updated_at: "2026-10-19T10:00:02Z" },
  { id: "bd-j3", title: "jsonl three", status: "blocked", assignee: "Alice", updated_at: "2026-10-19T10:00:03Z" },
];

function writeJsonl(): void {
  mkdirSync(beadsRoot(), { recursive: true });
  writeFileSync(join(beadsRoot(), "issues.jsonl"), JSONL_ISSUES.map((i) => JSON.stringify(i)).join("\n") + "\n");
}

function writeYaml(): void {
  const dir = join(beadsRoot(), "issues");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bd-y1.yaml"), [
    "id: bd-y1", "title: yaml one", "status: in_progress", "assignee: alice", "updated_at: 2026-10-19T11:00:01Z", "",
  ].join("\n"));
  writeFileSync(join(dir, "bd-y2.yml"), [
    "id: bd-y2", "title: yaml two", "status: done", "assignee: carol", "updated_at: 2026-10-19T11:00:02Z", "",
  ].join("\n"));
  // Not an issue file: ignored by the reader.
  writeFileSync(join(dir, "notes.txt"), "id: bd-not-an-issue\n");
}

let rpcSeq = 0;

async function tasksList(agent: TestAgent | null, params: Record<string, unknown>): Promise<{ rpcId: number; status: number; body: string }> {
  const rpcId = ++rpcSeq;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (agent) headers.Authorization = ed25519Header(agent, "POST", "/a2a");
  const res = await fetch(`${harper.httpURL}/a2a`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tasks/list", params }),
  });
  return { rpcId, status: res.status, body: await res.text() };
}

async function taskIds(agent: TestAgent, params: Record<string, unknown>): Promise<string[]> {
  const { rpcId, body } = await tasksList(agent, params);
  const answer = JSON.parse(body);
  expect(answer.id).toBe(rpcId);
  expect(answer.error, body.slice(0, 300)).toBeUndefined();
  expect(answer.result.type).toBe("tasks");
  return answer.result.tasks.map((t: any) => t.id);
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: A.id, name: A.id, role: "agent", publicKey: A.publicKey, createdAt: new Date().toISOString() }],
    }),
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
  writeJsonl();
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS + 10_000);

describe("A2A tasks/list reads the instance's Beads board", () => {
  it("an authenticated caller can request the unfiltered board (issues.jsonl when there are no YAML issue files)", async () => {
    const { rpcId, body } = await tasksList(A, {});
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        type: "tasks",
        // Newest updatedAt first; Beads statuses mapped to A2A states.
        tasks: [
          { id: "bd-j3", title: "jsonl three", status: "input-required", assignee: "Alice", updatedAt: "2026-10-19T10:00:03Z" },
          { id: "bd-j2", title: "jsonl two", status: "completed", assignee: "bob", updatedAt: "2026-10-19T10:00:02Z" },
          { id: "bd-j1", title: "jsonl one", status: "working", assignee: "alice", updatedAt: "2026-10-19T10:00:01Z" },
        ],
      },
    });
  }, 20_000);

  it("params.agentId filters by assignee (case-insensitive) and is not matched to the caller; params.status filters by mapped status", async () => {
    // The caller is a2atasks-a; naming other assignees is answered, not refused.
    expect(await taskIds(A, { agentId: "alice" })).toEqual(["bd-j3", "bd-j1"]);
    expect(await taskIds(A, { agentId: "BOB" })).toEqual(["bd-j2"]);
    expect(await taskIds(A, { agentId: A.id })).toEqual([]);
    expect(await taskIds(A, { status: "completed" })).toEqual(["bd-j2"]);
    expect(await taskIds(A, { status: "working" })).toEqual(["bd-j1"]);
    expect(await taskIds(A, { agentId: "alice", status: "input-required" })).toEqual(["bd-j3"]);
  }, 20_000);

  it("reads only the YAML issue files once any exist, and does not combine them with issues.jsonl", async () => {
    writeYaml();
    expect(await taskIds(A, {})).toEqual(["bd-y2", "bd-y1"]);
    expect(await taskIds(A, { agentId: "alice" })).toEqual(["bd-y1"]);
    expect(await taskIds(A, { status: "completed" })).toEqual(["bd-y2"]);
  }, 20_000);

  it("an anonymous request is refused and carries no board content", async () => {
    const { rpcId, body } = await tasksList(null, {});
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      id: rpcId,
      error: { code: -32001, message: "Unauthorized", data: { detail: "POST /a2a requires TPS-Ed25519 or admin Basic auth" } },
    });
    for (const marker of ["bd-j1", "bd-j2", "bd-j3", "bd-y1", "bd-y2", "jsonl", "yaml one", "alice"]) {
      expect(body).not.toContain(marker);
    }
  }, 20_000);
});
