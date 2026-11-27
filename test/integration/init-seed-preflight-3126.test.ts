// ─── flair#3126 — remote init checks the skill seed before its role, user and Agent writes ───
//
// Real Harper. A `using-flair` row owned by another administrator must refuse a
// remote init as principal B with the seed's own message. A refusal detected by
// the preflight prevents the role, shared-user and Agent writes in
// `finishRemoteInit`. Fabric deployment and administrator provisioning may
// already have occurred; a later seed refusal can follow those writes. After
// the remedy's DELETE the same run succeeds, and its re-run keeps the seed
// row's owner and the assignment count.
//
// `flair init --remote`'s provisioning leg runs in this process with
// `deploy_component` answered locally (the component is already installed) and
// every other request forwarded to the spawned instance. HOME is a scratch
// directory; target URLs are checked for loopback and nondefault ports before
// the CLI runs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { program } from "../../src/cli.js";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle.js";
import { checkUsingFlairSkill, SEED_ASSIGNMENT_ID, SEED_SKILL_ID } from "../../src/lib/skill-seed.js";
import { USING_FLAIR_SKILL_CONTENT, USING_FLAIR_SKILL_TRIGGER } from "../../src/lib/using-flair-skill.js";

const REAL_FETCH = globalThis.fetch;
const sfx = Date.now().toString(36);
const ADMIN_A = `admin-a-${sfx}`;
const ADMIN_B = `admin-b-${sfx}`;
const PASS_A = "admin-a-pass";
const PASS_B = "admin-b-pass";
const AGENT_B = `agent-b-${sfx}`;
const ROW_PATH = `/Memory/${encodeURIComponent(SEED_SKILL_ID)}`;

let harper: HarperInstance;
let scratchHome: string;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const basic = (user: string, pass: string) => "Basic " + btoa(`${user}:${pass}`);

async function ops(body: Record<string, unknown>): Promise<{ status: number; body: any; text: string }> {
  const res = await REAL_FETCH(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic(harper.admin.username, harper.admin.password) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, body: parsed, text };
}

async function roleNames(): Promise<string[]> {
  const res = await ops({ operation: "list_roles" });
  expect(res.status, res.text.slice(0, 200)).toBe(200);
  return ((res.body as any[]) ?? []).map((r) => r.role ?? r.name);
}

async function usernames(): Promise<string[]> {
  const res = await ops({ operation: "list_users" });
  expect(res.status, res.text.slice(0, 200)).toBe(200);
  return ((res.body as any[]) ?? []).map((u) => u.username);
}

async function agentStatus(id: string): Promise<number> {
  const res = await REAL_FETCH(`${harper.httpURL}/Agent/${encodeURIComponent(id)}`, {
    headers: { Authorization: basic(harper.admin.username, harper.admin.password) },
    signal: AbortSignal.timeout(15_000),
  });
  await res.text();
  return res.status;
}

async function memoryRow(): Promise<any> {
  const rows = await ops({
    operation: "search_by_id", database: "flair", table: "Memory", ids: [SEED_SKILL_ID],
    get_attributes: ["id", "agentId", "content"],
  });
  return Array.isArray(rows.body) ? rows.body[0] ?? null : null;
}

async function assignmentRows(): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_id", database: "flair", table: "OrgSkillAssignment", ids: [SEED_ASSIGNMENT_ID],
    get_attributes: ["id", "skillName", "skillRef", "priority"],
  });
  return Array.isArray(rows.body) ? rows.body : [];
}

/** The remedy's DELETE, retried on 409. */
async function deleteRowAsOperator(): Promise<{ status: number; body: string }> {
  let last = { status: 0, body: "" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await REAL_FETCH(`${harper.httpURL}${ROW_PATH}`, {
      method: "DELETE",
      headers: { Authorization: basic(harper.admin.username, harper.admin.password) },
      signal: AbortSignal.timeout(15_000),
    });
    last = { status: res.status, body: await res.text() };
    if (last.status !== 409) return last;
    await new Promise((r) => setTimeout(r, 250 * attempt));
  }
  return last;
}

/** Answer `deploy_component` locally; forward everything else to the instance. */
async function withDeployStub<T>(fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const bodyText = typeof init?.body === "string" ? init.body : null;
    let operation: string | undefined;
    try { operation = bodyText === null ? undefined : JSON.parse(bodyText)?.operation; } catch { operation = undefined; }
    if (operation === "deploy_component") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return REAL_FETCH(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

/** The CLI's `flair init --remote` action, with its exits captured. */
async function runInit(): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  const saved = {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, FLAIR_TARGET: process.env.FLAIR_TARGET,
    FLAIR_OPS_TARGET: process.env.FLAIR_OPS_TARGET, FLAIR_ADMIN_USER: process.env.FLAIR_ADMIN_USER,
    FLAIR_ADMIN_PASS: process.env.FLAIR_ADMIN_PASS, FLAIR_CLUSTER_ADMIN_USER: process.env.FLAIR_CLUSTER_ADMIN_USER,
    FLAIR_CLUSTER_ADMIN_PASS: process.env.FLAIR_CLUSTER_ADMIN_PASS, ROOTPATH: process.env.ROOTPATH,
  };
  const orig = { exit: process.exit, log: console.log, error: console.error, warn: console.warn };
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  process.env.HOME = scratchHome;
  process.env.USERPROFILE = scratchHome;
  for (const key of ["FLAIR_TARGET", "FLAIR_OPS_TARGET", "FLAIR_ADMIN_USER", "FLAIR_ADMIN_PASS", "FLAIR_CLUSTER_ADMIN_USER", "FLAIR_CLUSTER_ADMIN_PASS", "ROOTPATH"]) delete process.env[key];
  console.log = (...parts: unknown[]) => { stdout += parts.map((p) => String(p)).join(" ") + "\n"; };
  console.error = (...parts: unknown[]) => { stderr += parts.map((p) => String(p)).join(" ") + "\n"; };
  console.warn = (...parts: unknown[]) => { stderr += parts.map((p) => String(p)).join(" ") + "\n"; };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  try {
    await withDeployStub(() => program.parseAsync(["node", "flair", "init",
      "--target", harper.httpURL, "--ops-target", harper.opsURL, "--remote", "--force",
      "--cluster-admin-user", ADMIN_B, "--cluster-admin-pass", PASS_B,
      "--flair-admin-pass", "flair-admin-pass-b", "--agent-id", AGENT_B,
      "--keys-dir", join(scratchHome, "keys"),
    ]));
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("process.exit")) throw err;
  } finally {
    process.exit = orig.exit;
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { exitCode, stdout, stderr };
}

describe("flair#3126 — remote init checks the skill seed before its role, user and Agent writes", () => {
  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);
    scratchHome = mkdtempSync(join(tmpdir(), "flair-3126-"));
    for (const [username, password] of [[ADMIN_A, PASS_A], [ADMIN_B, PASS_B]]) {
      const res = await ops({ operation: "add_user", username, password, role: "super_user", active: true });
      expect([200, 409], `add_user ${username}: ${res.text.slice(0, 200)}`).toContain(res.status);
    }
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (scratchHome) { try { rmSync(scratchHome, { recursive: true, force: true }); } catch { /* best effort */ } }
  }, HARPER_STOP_BUDGET_MS);

  test("checkUsingFlairSkill with neither seed row present sends only GETs and writes neither row", async () => {
    const methods: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      methods.push(init?.method ?? "GET");
      return REAL_FETCH(input, init);
    }) as typeof fetch;
    try {
      const outcome = await checkUsingFlairSkill({ baseUrl: harper.httpURL, user: ADMIN_B, pass: PASS_B });
      expect(outcome.kind, JSON.stringify(outcome)).toBe("ok");
    } finally {
      globalThis.fetch = prev;
    }
    expect(await memoryRow()).toBeNull();
    expect(await assignmentRows()).toEqual([]);
    expect(methods.length).toBeGreaterThan(0);
    expect([...new Set(methods)]).toEqual(["GET"]);
  }, 120_000);

  test("a foreign-owned row refuses the run before the role, shared-user and Agent writes", async () => {
    const inserted = await ops({
      operation: "insert", database: "flair", table: "Memory",
      records: [{
        id: SEED_SKILL_ID, agentId: ADMIN_A, content: USING_FLAIR_SKILL_CONTENT, trigger: USING_FLAIR_SKILL_TRIGGER,
        tags: ["skill"], durability: "persistent", visibility: "shared", archived: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    });
    expect(inserted.status, inserted.text.slice(0, 300)).toBe(200);
    const run = await runInit();
    expect(run.exitCode, run.stdout + run.stderr).toBe(1);
    expect(run.stderr).toContain("Error: the using-flair skill seed was refused — ");
    expect(run.stderr).toContain(`the "${SEED_SKILL_ID}" Memory row is owned by "${ADMIN_A}", not the operator "${ADMIN_B}"`);
    expect(run.stderr).toContain(`DELETE ${ROW_PATH}`);

    expect(await roleNames()).not.toContain("flair_pair_initiator");
    expect(await roleNames()).not.toContain("flair_agent");
    expect(await usernames()).not.toContain("flair-agent");
    expect(await agentStatus(AGENT_B)).toBe(404);

    expect((await memoryRow())?.agentId).toBe(ADMIN_A);
    expect(await assignmentRows()).toEqual([]);
  }, 240_000);

  test("after the remedy's DELETE the same run succeeds, and its re-run keeps the seed row's owner and the assignment count", async () => {
    const deleted = await deleteRowAsOperator();
    expect(deleted.status, deleted.body.slice(0, 300)).toBeLessThan(300);

    const seeded = await runInit();
    expect(seeded.exitCode ?? 0, seeded.stdout + seeded.stderr).toBe(0);
    expect((await memoryRow())?.agentId).toBe(ADMIN_B);
    expect((await assignmentRows()).length).toBe(1);
    expect(await roleNames()).toContain("flair_agent");
    expect(await usernames()).toContain("flair-agent");

    const again = await runInit();
    expect(again.exitCode ?? 0, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain("already current");
    expect((await memoryRow())?.agentId).toBe(ADMIN_B);
    expect((await assignmentRows()).length).toBe(1);
  }, 300_000);
});
