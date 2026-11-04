/**
 * admin-memory-candidates-2755.test.ts — the admin-only candidate listing a
 * restore uses (flair#2755), against real Harpers.
 *
 * The route is `GET /AdminMemoryCandidates/{agentId}`. It returns the named
 * agent's candidate ids, refuses a request with no Authorization header (the
 * `/Admin*` path gate's 401) and a verified non-admin agent (AccessViolation
 * 403), honours its `limit`, pages in id order with `after`, and never returns
 * another agent's rows.
 *
 * The restore test starts two instances that hold the same `flair.Instance`
 * row and different MemoryCandidate rows. The restore is aimed at one, with
 * FLAIR_OPS_PORT naming the other's operations port. It must list and delete
 * on the target alone: the target loses its candidate, the other instance
 * keeps its own.
 *
 * Harper's MemoryCandidate primary key stores an empty string or an array of
 * strings as given. A row with such an id that the route reads fails its
 * agent's listing with `candidate_id_unusable`, and a restore that gets that
 * answer writes no target row.
 *
 * Agent ids holding `.`, `_`, a non-ASCII letter, `?`, `/`, `%`, `#`, `&` or
 * `+`, sent with encodeURIComponent as restore sends them, list and page to
 * that agent's rows. With a snapshot root present, `rem restore --agent`
 * refuses each of them except `agent-a_b` by the snapshot id rule
 * (`^[a-zA-Z0-9_-]+$`, listSnapshots in src/rem/snapshot.ts) before it sends a
 * request.
 *
 * An unusable id that sorts after the first pages fails the listing on the
 * first page that reads it (a page reads one row past its limit), after the
 * earlier pages were returned; a restore refused that way on its second page
 * sends no write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { createSnapshot } from "../../src/rem/snapshot.ts";
import { CANDIDATE_LIST_LIMIT } from "../../src/rem/restore.ts";

const CLI = join(process.cwd(), "dist", "cli.js");
const FETCH_LOG_PRELOAD = join(import.meta.dirname, "..", "helpers", "fetch-request-log-preload.ts");
const AGENT_ID = "agent-a";
const OTHER_AGENT_ID = "agent-b";
const MEMORY_ID = "m-restored";
const SOUL_ID = `soul-${AGENT_ID}`;
const createdAt = new Date().toISOString();
/** Agent ids holding `.`, `_`, a non-ASCII letter, or a character encodeURIComponent escapes. */
const ENCODED_AGENT_IDS = ["agent.a", "agent-a_b", "agent-ä", "agent?a", "agent/a", "agent%a", "agent#a", "agent&a+b"];

let adminHarper: HarperInstance;
let other: HarperInstance;
let home: string;
const plainAgent = mkAgent("plain-2755");

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

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

function adminAuth(h: HarperInstance): string {
  return "Basic " + btoa(`${h.admin.username}:${h.admin.password}`);
}

function assertOwnInstance(h: HarperInstance): void {
  for (const raw of [h.httpURL, h.opsURL]) {
    const u = new URL(raw);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}

async function ops(h: HarperInstance, body: Record<string, unknown>): Promise<any[]> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth(h) },
    body: JSON.stringify({ ...body, database: "flair" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as any[];
}

async function candidateIds(h: HarperInstance, agentId: string): Promise<string[]> {
  const rows = await ops(h, {
    operation: "search_by_conditions",
    table: "MemoryCandidate",
    operator: "and",
    conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: agentId }],
    get_attributes: ["id"],
  });
  return rows.map((r) => String(r.id)).sort();
}

/** One agent's Memory, Soul and MemoryCandidate rows, each table's rows serialized and sorted. */
async function agentRows(h: HarperInstance, agentId: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of ["Memory", "Soul", "MemoryCandidate"]) {
    const rows = await ops(h, {
      operation: "search_by_conditions",
      table,
      operator: "and",
      conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: agentId }],
      get_attributes: ["*"],
    });
    out[table] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

async function seedAgent(h: HarperInstance, agent: TestAgent, role: "admin" | "agent"): Promise<void> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth(h) },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{ id: agent.id, name: agent.id, role, admin: role === "admin", publicKey: agent.publicKey, createdAt }],
    }),
  });
  if (!res.ok) throw new Error(`seed ${agent.id} returned ${res.status}: ${await res.text()}`);
}

async function seedCandidate(h: HarperInstance, id: string, agentId: string, claim: string): Promise<void> {
  await ops(h, {
    operation: "insert",
    table: "MemoryCandidate",
    records: [{ id, agentId, claim, generatedAt: createdAt, status: "pending" }],
  });
}

/** With `fetchLog`, the CLI loads the request-log preload, which appends each `fetch` it sends to that file. */
function runRestore(h: HarperInstance, opsSide: HarperInstance, date: string, fetchLog?: string, agentId = AGENT_ID): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    FLAIR_URL: h.httpURL,
    FLAIR_OPS_PORT: new URL(opsSide.opsURL).port,
    FLAIR_OPS_TARGET: undefined,
    FLAIR_TARGET: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_ADMIN_PASS: undefined,
    FLAIR_ADMIN_USER: undefined,
    HDB_ADMIN_PASSWORD: undefined,
    FLAIR_AGENT_ID: undefined,
    FLAIR_TEST_FETCH_LOG: fetchLog,
    NO_COLOR: "1",
  };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const preload = fetchLog ? ["--import", pathToFileURL(FETCH_LOG_PRELOAD).href] : [];
  const child = Bun.spawn(
    [nodeBin({ env: childEnv as Record<string, string> }), ...preload, CLI, "rem", "restore", date, "--agent", agentId, "--apply", "--admin-pass", h.admin.password],
    { env: childEnv as Record<string, string>, timeout: 90_000, stdout: "pipe", stderr: "pipe" },
  );
  return (async () => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    return { code, stdout, stderr };
  })();
}

/** The requests a `runRestore` fetch log holds; a run that sent none leaves no file. */
function requestsIn(fetchLog: string): Array<{ method: string; host: string; path: string }> {
  let text: string;
  try {
    text = readFileSync(fetchLog, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function restoreSnapshotStem(agentId: string, memoryId: string): Promise<string> {
  const created = await createSnapshot({
    agentId,
    flairVersion: "0.0.0-test",
    memories: [{ id: memoryId, agentId, content: "restored memory", durability: "persistent", createdAt }],
    soul: { id: `soul-${agentId}`, agentId, key: "identity", value: "restored soul", createdAt },
    pendingCandidateCount: null,
    rootOverride: join(home, ".flair", "snapshots"),
  });
  return basename(created.path).replace(/\.tar\.gz$/, "");
}

beforeAll(async () => {
  adminHarper = await startHarper();
  assertOwnInstance(adminHarper);
  await seedAgent(adminHarper, mkAgent("admin-2755"), "admin");
  await seedAgent(adminHarper, plainAgent, "agent");
  await seedCandidate(adminHarper, "c-a-1", AGENT_ID, "first candidate");
  await seedCandidate(adminHarper, "c-a-2", AGENT_ID, "second candidate");
  await seedCandidate(adminHarper, "c-a-3", AGENT_ID, "third candidate");
  await seedCandidate(adminHarper, "c-b-1", OTHER_AGENT_ID, "another agent's candidate");
  await ops(adminHarper, {
    operation: "insert",
    table: "MemoryCandidate",
    records: [
      // Each candidate id carries its agent id, so the after cursor holds the same characters.
      ...ENCODED_AGENT_IDS.flatMap((agentId) =>
        [3, 5, 1, 4, 2].map((n) => ({ id: `c-${agentId}-${n}`, agentId, claim: `candidate ${n}`, generatedAt: createdAt, status: "pending" }))),
      // The agent an unencoded agent?a path names.
      { id: "c-agent-1", agentId: "agent", claim: "prefix agent candidate", generatedAt: createdAt, status: "pending" },
    ],
  });
  home = mkdtempSync(join(tmpdir(), "flair-2755-real-"));
  mkdirSync(join(home, ".flair"), { recursive: true });
}, 300_000);

afterAll(async () => {
  try {
    await stopHarpers([adminHarper, other]);
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
    for (const h of [adminHarper, other]) {
      if (h?.installDir?.startsWith(tmpdir())) rmSync(h.installDir, { recursive: true, force: true });
    }
  }
}, HARPER_STOP_BUDGET_MS * 2);

describe("flair#2755 — admin-only candidate listing", () => {
  const path = (agentId: string, query = "") => `/AdminMemoryCandidates/${agentId}${query}`;

  test("returns only the named agent's candidate ids, with the requested bound", async () => {
    const all = await fetch(`${adminHarper.httpURL}${path(AGENT_ID)}`, { headers: { Authorization: adminAuth(adminHarper) } });
    expect(all.status).toBe(200);
    const body = await all.json() as any;
    expect(body.hasMore).toBe(false);
    expect(body.candidates.map((c: any) => c.id).sort()).toEqual(["c-a-1", "c-a-2", "c-a-3"]);
    for (const row of body.candidates) expect(Object.keys(row)).toEqual(["id"]);

    const bounded = await fetch(`${adminHarper.httpURL}${path(AGENT_ID, "?limit=2")}`, { headers: { Authorization: adminAuth(adminHarper) } });
    expect(bounded.status).toBe(200);
    const page = await bounded.json() as any;
    expect(page.candidates).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.candidates.every((c: any) => c.id.startsWith("c-a-"))).toBe(true);
  });

  test("pages one agent's ids in id order with after, each id exactly once, and refuses a malformed after with 400", async () => {
    const pagedAgent = "agent-paged";
    // Inserted out of id order, so the order the pages return is the route's.
    for (const id of ["p-3", "p-1", "p-5", "p-2", "p-4"]) await seedCandidate(adminHarper, id, pagedAgent, `paged ${id}`);
    const page = async (query: string) => {
      const res = await fetch(`${adminHarper.httpURL}${path(pagedAgent, query)}`, { headers: { Authorization: adminAuth(adminHarper) } });
      expect(res.status).toBe(200);
      return await res.json() as any;
    };

    expect(await page("?limit=2")).toEqual({ candidates: [{ id: "p-1" }, { id: "p-2" }], hasMore: true });
    expect(await page("?limit=2&after=p-2")).toEqual({ candidates: [{ id: "p-3" }, { id: "p-4" }], hasMore: true });
    expect(await page("?limit=2&after=p-4")).toEqual({ candidates: [{ id: "p-5" }], hasMore: false });

    for (const query of ["?limit=2&after=", "?limit=2&after=p-1&after=p-2"]) {
      const res = await fetch(`${adminHarper.httpURL}${path(pagedAgent, query)}`, { headers: { Authorization: adminAuth(adminHarper) } });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toBe("invalid_after");
    }
  });

  test("refuses a request with no Authorization header with the admin path gate's 401", async () => {
    const res = await fetch(`${adminHarper.httpURL}${path(AGENT_ID)}`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Authentication required.");
  });

  test("refuses a verified non-admin agent with 403", async () => {
    const requestPath = path(AGENT_ID);
    const res = await fetch(`${adminHarper.httpURL}${requestPath}`, {
      headers: { Authorization: ed25519Header(plainAgent, "GET", requestPath) },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.code).toBe("AccessViolation");
    expect(body.status).toBe(403);
  });

  test("Harper stores an empty or an array MemoryCandidate id, and the route fails that agent's listing", async () => {
    const base = { claim: "unusable id", generatedAt: createdAt, status: "pending" };
    const insert = (record: Record<string, unknown>) =>
      fetch(adminHarper.opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: adminAuth(adminHarper) },
        body: JSON.stringify({ operation: "insert", database: "flair", table: "MemoryCandidate", records: [{ ...base, ...record }] }),
        signal: AbortSignal.timeout(15_000),
      });
    const idsOf = (agentId: string) =>
      ops(adminHarper, {
        operation: "search_by_conditions",
        table: "MemoryCandidate",
        operator: "and",
        conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: agentId }],
        get_attributes: ["id"],
      });
    const list = (agentId: string) => fetch(`${adminHarper.httpURL}${path(agentId)}`, { headers: { Authorization: adminAuth(adminHarper) } });

    // The primary key refuses a number and a boolean, and generates a string id for a missing one.
    expect((await insert({ id: 7, agentId: "agent-number-id" })).status).toBe(400);
    expect((await insert({ id: true, agentId: "agent-boolean-id" })).status).toBe(400);
    expect((await insert({ agentId: "agent-missing-id" })).status).toBe(200);
    const generated = await idsOf("agent-missing-id");
    expect(generated).toHaveLength(1);
    expect(typeof generated[0].id).toBe("string");
    expect(generated[0].id.length).toBeGreaterThan(0);
    const listed = await list("agent-missing-id");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ candidates: [{ id: generated[0].id }], hasMore: false });

    // It stores an empty string and an array of strings as given.
    expect((await insert({ id: "", agentId: "agent-empty-id" })).status).toBe(200);
    expect((await insert({ id: ["unusable", "2755"], agentId: "agent-array-id" })).status).toBe(200);
    expect(await idsOf("agent-empty-id")).toEqual([{ id: "" }]);
    expect(await idsOf("agent-array-id")).toEqual([{ id: ["unusable", "2755"] }]);
    for (const agentId of ["agent-empty-id", "agent-array-id"]) {
      const res = await list(agentId);
      expect(res.status).toBe(500);
      expect((await res.json() as any).error).toBe("candidate_id_unusable");
    }
  });

  test("with two instances holding the same Instance row, a restore lists and deletes on its target only", async () => {
    other = await startHarper();
    assertOwnInstance(other);

    const instanceRow = {
      id: "instance-shared-2755",
      publicKey: "seed-pub-2755",
      role: "hub",
      status: "active",
      createdAt,
    };
    await ops(adminHarper, { operation: "insert", table: "Instance", records: [instanceRow] });
    await ops(other, { operation: "insert", table: "Instance", records: [instanceRow] });

    // The target starts with a candidate and drifted rows; the other instance
    // holds a different candidate for the same agent.
    await seedCandidate(adminHarper, "c-on-target", AGENT_ID, "target candidate");
    await seedCandidate(other, "c-on-other", AGENT_ID, "other candidate");
    await ops(adminHarper, {
      operation: "insert",
      table: "Memory",
      records: [{ id: "m-drifted", agentId: AGENT_ID, content: "drifted", durability: "persistent", createdAt }],
    });
    await ops(other, {
      operation: "insert",
      table: "Memory",
      records: [{ id: "m-on-other", agentId: AGENT_ID, content: "other instance memory", durability: "persistent", createdAt }],
    });

    const created = await createSnapshot({
      agentId: AGENT_ID,
      flairVersion: "0.0.0-test",
      memories: [{ id: MEMORY_ID, agentId: AGENT_ID, content: "restored memory", durability: "persistent", createdAt }],
      soul: { id: SOUL_ID, agentId: AGENT_ID, key: "identity", value: "restored soul", createdAt },
      pendingCandidateCount: null,
      rootOverride: join(home, ".flair", "snapshots"),
    });
    const stem = basename(created.path).replace(/\.tar\.gz$/, "");

    const result = await runRestore(adminHarper, other, stem);
    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Status:       completed");

    expect(await candidateIds(adminHarper, AGENT_ID)).toEqual([]);
    expect(await candidateIds(other, AGENT_ID)).toEqual(["c-on-other"]);

    const targetMemories = await ops(adminHarper, {
      operation: "search_by_conditions",
      table: "Memory",
      operator: "and",
      conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: AGENT_ID }],
      get_attributes: ["id", "content"],
    });
    expect(targetMemories).toEqual([{ id: MEMORY_ID, content: "restored memory" }]);

    const otherMemories = await ops(other, {
      operation: "search_by_conditions",
      table: "Memory",
      operator: "and",
      conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: AGENT_ID }],
      get_attributes: ["id", "content"],
    });
    expect(otherMemories).toEqual([{ id: "m-on-other", content: "other instance memory" }]);
  }, 300_000);

  test("a restore whose candidate listing answers candidate_id_unusable sends no write and leaves the target's rows as they were", async () => {
    await seedCandidate(adminHarper, "c-usable-2755", AGENT_ID, "usable candidate");
    await ops(adminHarper, {
      operation: "insert",
      table: "MemoryCandidate",
      records: [{ id: ["unusable", AGENT_ID], agentId: AGENT_ID, claim: "unusable id", generatedAt: createdAt, status: "pending" }],
    });
    await ops(adminHarper, {
      operation: "upsert",
      table: "Memory",
      records: [{ id: "m-drift-unusable", agentId: AGENT_ID, content: "drifted", durability: "persistent", createdAt }],
    });
    const agentState = async () => {
      const out: Record<string, unknown[]> = {};
      for (const table of ["Memory", "Soul", "MemoryCandidate"]) {
        const rows = await ops(adminHarper, {
          operation: "search_by_conditions",
          table,
          operator: "and",
          conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: AGENT_ID }],
          get_attributes: ["*"],
        });
        out[table] = rows.map((r) => JSON.stringify(r)).sort();
      }
      return out;
    };
    const before = await agentState();
    expect(before.MemoryCandidate).toHaveLength(2);

    const created = await createSnapshot({
      agentId: AGENT_ID,
      flairVersion: "0.0.0-test",
      memories: [{ id: MEMORY_ID, agentId: AGENT_ID, content: "restored memory", durability: "persistent", createdAt }],
      soul: { id: SOUL_ID, agentId: AGENT_ID, key: "identity", value: "restored soul", createdAt },
      pendingCandidateCount: null,
      rootOverride: join(home, ".flair", "snapshots"),
    });
    const stem = basename(created.path).replace(/\.tar\.gz$/, "");
    const fetchLog = join(home, "unusable-id-fetch-log.jsonl");

    const result = await runRestore(adminHarper, adminHarper, stem, fetchLog);

    const requests = readFileSync(fetchLog, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(requests.some((r) => r.path === `/AdminMemoryCandidates/${AGENT_ID}`)).toBe(true);
    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).not.toBe(0);
    expect(result.stdout).toContain(`the target's MemoryCandidate listing for agent ${AGENT_ID} could not be read completely`);
    expect(result.stdout).toContain("No target rows were deleted or written.");
    expect(await agentState()).toEqual(before);
  }, 300_000);

  test("encoded agent ids page their own candidates completely, in id order", async () => {
    for (const agentId of ENCODED_AGENT_IDS) {
      const listed: string[] = [];
      const hasMore: boolean[] = [];
      let after: string | undefined;
      for (let page = 1; page <= 3; page++) {
        const query = `?limit=2${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`;
        const res = await fetch(`${adminHarper.httpURL}${path(encodeURIComponent(agentId), query)}`, { headers: { Authorization: adminAuth(adminHarper) } });
        expect(res.status, `${agentId} page ${page}`).toBe(200);
        const body = await res.json() as any;
        listed.push(...body.candidates.map((c: any) => c.id));
        hasMore.push(body.hasMore);
        after = body.candidates.at(-1)?.id;
      }
      expect(listed, agentId).toEqual([1, 2, 3, 4, 5].map((n) => `c-${agentId}-${n}`));
      expect(hasMore, agentId).toEqual([true, true, false]);
    }
  }, 60_000);

  test("rem restore admits agent-a_b and refuses the other encoded ids by the snapshot id rule before any request", async () => {
    const acceptedLog = join(home, "agent-a_b-fetch-log.jsonl");
    const accepted = await runRestore(adminHarper, adminHarper, await restoreSnapshotStem("agent-a_b", "m-restored-a_b"), acceptedLog, "agent-a_b");
    expect(accepted.code, `stdout:\n${accepted.stdout}\nstderr:\n${accepted.stderr}`).toBe(0);
    expect(accepted.stdout).toContain("Status:       completed");
    const sent = requestsIn(acceptedLog).map((r) => `${r.method} ${r.path}`);
    expect(sent.filter((r) => r.includes(" /AdminMemoryCandidates/"))).toEqual(["GET /AdminMemoryCandidates/agent-a_b"]);
    expect(sent.filter((r) => r.includes(" /MemoryCandidate/")).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `DELETE /MemoryCandidate/c-agent-a_b-${n}`));
    expect(await candidateIds(adminHarper, "agent-a_b")).toEqual([]);
    for (const agentId of ENCODED_AGENT_IDS.filter((id) => id !== "agent-a_b")) {
      expect(await candidateIds(adminHarper, agentId)).toEqual([1, 2, 3, 4, 5].map((n) => `c-${agentId}-${n}`));
    }
    expect(await candidateIds(adminHarper, "agent")).toEqual(["c-agent-1"]);

    // The snapshot root exists here, so listSnapshots (src/rem/snapshot.ts) refuses an id outside
    // ^[a-zA-Z0-9_-]+$ before restore resolves its target.
    for (const [i, agentId] of ENCODED_AGENT_IDS.filter((id) => id !== "agent-a_b").entries()) {
      const fetchLog = join(home, `refused-agent-${i}-fetch-log.jsonl`);
      const refused = await runRestore(adminHarper, adminHarper, "2026", fetchLog, agentId);
      expect(refused.code, `${agentId}\nstdout:\n${refused.stdout}\nstderr:\n${refused.stderr}`).toBe(1);
      expect(refused.stderr).toContain(`Error: invalid agent id: ${agentId}`);
      expect(requestsIn(fetchLog)).toEqual([]);
    }
  }, 300_000);

  test("an unusable id read on the third page fails that page, after the first two were returned", async () => {
    const agentId = "agent-later-route";
    await ops(adminHarper, {
      operation: "insert",
      table: "MemoryCandidate",
      records: [
        ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `later-r-${n}`, agentId, claim: `later ${n}`, generatedAt: createdAt, status: "pending" })),
        // An array id; its first element sorts after every later-r-* id.
        { id: ["later-s", "2836"], agentId, claim: "unusable id", generatedAt: createdAt, status: "pending" },
      ],
    });
    const page = (query: string) => fetch(`${adminHarper.httpURL}${path(agentId, query)}`, { headers: { Authorization: adminAuth(adminHarper) } });

    const first = await page("?limit=2");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ candidates: [{ id: "later-r-1" }, { id: "later-r-2" }], hasMore: true });
    const second = await page("?limit=2&after=later-r-2");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ candidates: [{ id: "later-r-3" }, { id: "later-r-4" }], hasMore: true });
    const third = await page("?limit=2&after=later-r-4");
    expect(third.status).toBe(500);
    expect((await third.json() as any).error).toBe("candidate_id_unusable");
  }, 60_000);

  test("a restore whose second candidate page answers candidate_id_unusable sends no delete or write", async () => {
    const agentId = "agent-later-restore";
    const usable = Array.from({ length: CANDIDATE_LIST_LIMIT + 20 }, (_, i) => `later-p-${String(i + 1).padStart(4, "0")}`);
    await ops(adminHarper, {
      operation: "insert",
      table: "MemoryCandidate",
      records: [
        ...usable.map((id) => ({ id, agentId, claim: `later ${id}`, generatedAt: createdAt, status: "pending" })),
        // An array id; its first element sorts after every later-p-* id.
        { id: ["later-q", "2836"], agentId, claim: "unusable id", generatedAt: createdAt, status: "pending" },
      ],
    });
    await ops(adminHarper, {
      operation: "upsert",
      table: "Memory",
      records: [{ id: "m-drift-later", agentId, content: "drifted", durability: "persistent", createdAt }],
    });

    // At restore's page size, the first page answers and the second is refused.
    const listPage = (query: string) =>
      fetch(`${adminHarper.httpURL}${path(agentId, query)}`, { headers: { Authorization: adminAuth(adminHarper) }, signal: AbortSignal.timeout(15_000) });
    const first = await listPage(`?limit=${CANDIDATE_LIST_LIMIT}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ candidates: usable.slice(0, CANDIDATE_LIST_LIMIT).map((id) => ({ id })), hasMore: true });
    const second = await listPage(`?limit=${CANDIDATE_LIST_LIMIT}&after=${usable[CANDIDATE_LIST_LIMIT - 1]}`);
    expect(second.status).toBe(500);
    expect((await second.json() as any).error).toBe("candidate_id_unusable");

    const before = await agentRows(adminHarper, agentId);
    expect(before.MemoryCandidate).toHaveLength(usable.length + 1);
    const fetchLog = join(home, "later-page-fetch-log.jsonl");
    const result = await runRestore(adminHarper, adminHarper, await restoreSnapshotStem(agentId, "m-restored-later"), fetchLog, agentId);

    const requests = requestsIn(fetchLog);
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(requests.filter((r) => r.path === `/AdminMemoryCandidates/${agentId}`)).toHaveLength(2);
    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).not.toBe(0);
    expect(result.stdout).toContain(`the target's MemoryCandidate listing for agent ${agentId} could not be read completely: GET /AdminMemoryCandidates answered candidate_id_unusable`);
    expect(result.stdout).toContain("No target rows were deleted or written.");
    expect(await agentRows(adminHarper, agentId)).toEqual(before);
  }, 300_000);
});
