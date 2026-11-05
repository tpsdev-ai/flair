/**
 * restore-soul-write-preflight-2953.test.ts — `flair restore --replace`
 * against a REAL Harper and the REAL built CLI (flair#2953).
 *
 * After admission and preflight, a non-dry-run replace attempts the archived
 * Memory DELETEs and, only if that stage completes without failure, the archived
 * Soul DELETEs. There is no rollback snapshot; a failed Soul DELETE is recorded
 * and that row's PUT still runs. The cases here seed through the admin ops route or a
 * resource PUT, and cover these refusals: a skill-assignment row whose source
 * is a filesystem path (including one under the server's TMPDIR), a
 * skill-assignment row with a non-boolean optOut, and a Soul row without a
 * non-empty agentId. Archive admission also refuses before any delete a row id
 * containing a dot and a Soul row with a non-string `value`. Each refusal
 * stops the run with the live rows untouched. A
 * direct server PUT with a numeric `value` shows the server also refuses that
 * row.
 *
 * Build prerequisite: `bun run build && bun run build:cli`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import nacl from "tweetnacl";
import { nodeBin } from "../helpers/node-runtime";
import { tempDir } from "../helpers/temp-dir";
import { HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const CREATED_AT = "2026-10-01T00:00:00.000Z";

let harper: HarperInstance;
let serverTempRoot = "";

interface RunResult { code: number | null; stdout: string; stderr: string }

function assertOwnInstance(h: HarperInstance): void {
  for (const raw of [h.httpURL, h.opsURL]) {
    const u = new URL(raw);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) throw new Error("refusing to run: not an instance this test started");
}

/** Run the built CLI with a throwaway HOME and no ambient Flair settings. */
function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const env = { ...ambient, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...extraEnv } as Record<string, string>;
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin({ env }), [CLI, ...args], { env, timeout: 90_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`flair ${args[0]} ended by ${signal}: ${stdout}${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

const adminAuth = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;

async function op(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify({ database: "flair", ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status, `ops ${body.operation}`).toBe(200);
  return res.json();
}

async function operatorPut(path: string, body: unknown): Promise<number> {
  // A freshly started Harper can answer 503 while a table is still coming up.
  // Retry a bounded number of times and return the last status if never accepted.
  const attempts = 5;
  let status = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(harper.httpURL + path, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: adminAuth() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    await res.text();
    status = res.status;
    if (status !== 503) return status;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return status;
}

/** A direct PUT whose status and body the caller asserts, for expected refusals. */
async function operatorPutResponse(path: string, body: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(harper.httpURL + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.text() };
}

const row = async (table: string, id: string): Promise<any> =>
  (await op({ operation: "search_by_id", table, ids: [id], get_attributes: ["*"] }))[0];

async function seedAgent(agent: string): Promise<void> {
  await op({
    operation: "upsert",
    table: "Agent",
    records: [{ id: agent, name: agent, role: "agent", publicKey: Buffer.from(nacl.sign.keyPair().publicKey).toString("base64"), createdAt: CREATED_AT }],
  });
}

/** A real `flair backup` of `agent`; returns the archive path. */
async function backup(home: string, name: string, agent: string): Promise<string> {
  const output = join(tempDir("flair-2953-real-archive-"), name);
  const passFile = join(tempDir("flair-2953-real-secrets-"), "admin-pass");
  writeFileSync(passFile, `${harper.admin.password}\n`, { mode: 0o600 });
  const result = await runCli([
    "backup", "--url", harper.httpURL, "--ops-target", harper.opsURL, "--admin-pass-file", passFile,
    "--agents", agent, "--output", output,
  ], home);
  expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
  expect(existsSync(`${output}.sha256`)).toBe(true);
  return output;
}

function assertNothingDeleted(result: RunResult): void {
  expect(result.stdout).not.toContain("Deleting existing data");
  expect(result.stdout).not.toContain("Restore complete");
}

/** Edit an archive's JSON and rewrite its digest sidecar. */
function rewriteArchive(archivePath: string, mutate: (archive: any) => void): void {
  const archive = JSON.parse(readFileSync(archivePath, "utf8"));
  mutate(archive);
  const text = `${JSON.stringify(archive, null, 2)}\n`;
  writeFileSync(archivePath, text);
  writeFileSync(`${archivePath}.sha256`, `${createHash("sha256").update(text).digest("hex")}  ${basename(archivePath)}\n`);
}

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error("dist/cli.js is missing: run `bun run build:cli` before this file; `bun run build` alone does not build the CLI");
  }
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  serverTempRoot = mkdtempSync(join(homedir(), ".flair-server-tmp-2953-"));
  harper = await startHarper({ serverEnv: { TMPDIR: serverTempRoot } });
  assertOwnInstance(harper);
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (serverTempRoot) rmSync(serverTempRoot, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("non-dry-run flair restore --replace refuses the Soul write rules it covers before deleting (flair#2953)", () => {
  test("a skill-assignment row with a filesystem source is refused before any delete", async () => {
    const home = tempDir("flair-2953-real-home-");
    const agent = "skill-source-agent";
    const soulId = `${agent}:skill`;
    const source = "/tmp/skills-inspect/a-skill/SKILL.md";

    await seedAgent(agent);
    await op({
      operation: "upsert",
      table: "Soul",
      records: [{
        id: soulId, agentId: agent, key: "skill-assignment", value: "a-skill",
        metadata: JSON.stringify({ source }), durability: "permanent", createdAt: CREATED_AT,
      }],
    });
    const archive = await backup(home, "skill-source.json", agent);
    const before = await row("Soul", soulId);

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(1);
    assertNothingDeleted(restored);
    expect(restored.stderr).toContain(`Soul ${soulId}`);
    expect(restored.stderr).toContain("filesystem path");
    expect(restored.stderr).toContain("restore without --replace");
    expect(restored.stderr).toContain("no rows were deleted");
    expect(await row("Soul", soulId)).toEqual(before);
  }, 300_000);

  test("a filesystem source under the server's TMPDIR is refused before any delete", async () => {
    const home = tempDir("flair-2953-real-home-");
    const agent = "server-temp-agent";
    const soulId = `${agent}:skill`;
    const source = join(serverTempRoot, "skills", "a-skill", "SKILL.md");

    await seedAgent(agent);
    await op({
      operation: "upsert",
      table: "Soul",
      records: [{
        id: soulId, agentId: agent, key: "skill-assignment", value: "a-skill",
        metadata: JSON.stringify({ source }), durability: "permanent", createdAt: CREATED_AT,
      }],
    });
    const archive = await backup(home, "server-temp-source.json", agent);
    const before = await row("Soul", soulId);

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, {
      FLAIR_ADMIN_PASS: harper.admin.password,
      TMPDIR: "/tmp",
    });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(1);
    assertNothingDeleted(restored);
    expect(restored.stderr).toContain(`Soul ${soulId}`);
    expect(restored.stderr).toContain("filesystem path");
    expect(restored.stderr).toContain("restore without --replace");
    expect(restored.stderr).toContain("no rows were deleted");
    expect(await row("Soul", soulId)).toEqual(before);
  }, 300_000);

  test("a skill-assignment row with a non-boolean optOut is refused before any delete", async () => {
    const home = tempDir("flair-2953-real-home-");
    const agent = "skill-optout-agent";
    const soulId = `${agent}:skill`;

    await seedAgent(agent);
    await op({
      operation: "upsert",
      table: "Soul",
      records: [{
        id: soulId, agentId: agent, key: "skill-assignment", value: "a-skill",
        metadata: JSON.stringify({ source: "npm:@example/skills@1.0.0", optOut: "yes" }),
        durability: "permanent", createdAt: CREATED_AT,
      }],
    });
    const archive = await backup(home, "skill-optout.json", agent);
    const before = await row("Soul", soulId);

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(1);
    assertNothingDeleted(restored);
    expect(restored.stderr).toContain(`Soul ${soulId}`);
    expect(restored.stderr).toContain("skill_opt_out_not_boolean");
    expect(restored.stderr).toContain("no rows were deleted");
    expect(await row("Soul", soulId)).toEqual(before);
  }, 300_000);

  test("a Soul row without a usable agentId is refused before any delete", async () => {
    const home = tempDir("flair-2953-real-home-");
    const agent = "ownerless-agent";
    const soulId = `${agent}:identity`;

    await seedAgent(agent);
    expect(await operatorPut(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value: "a durable value", durability: "permanent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    const archive = await backup(home, "ownerless.json", agent);
    // An edited archive: the row is no longer the shape `flair backup` writes.
    rewriteArchive(archive, (parsed) => {
      const soul = (parsed.souls as any[]).find((candidate) => String(candidate.id) === soulId);
      if (!soul) throw new Error(`archive has no Soul ${soulId}`);
      delete soul.agentId;
    });
    const before = await row("Soul", soulId);

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(1);
    assertNothingDeleted(restored);
    // Archive admission refuses the edited row as invalid before the replace
    // preflight or any delete.
    expect(restored.stderr).toContain("invalid-row");
    expect(restored.stderr).toContain("agentId");
    expect(await row("Soul", soulId)).toEqual(before);
  }, 300_000);

  test("an archived Soul id containing a dot is refused before any delete", async () => {
    const home = tempDir("flair-2953-real-home-");
    const agent = "dotted-id-agent";
    const soulId = `${agent}:identity`;

    await seedAgent(agent);
    expect(await operatorPut(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value: "a durable value", durability: "permanent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    const archive = await backup(home, "dotted-id.json", agent);
    // The archived id keeps its record but gains a suffix Harper's path parser
    // strips, so the DELETE would target a row the archive does not hold.
    rewriteArchive(archive, (parsed) => {
      const soul = (parsed.souls as any[]).find((candidate) => String(candidate.id) === soulId);
      if (!soul) throw new Error(`archive has no Soul ${soulId}`);
      soul.id = `${soulId}.json`;
    });
    const before = await row("Soul", soulId);

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(1);
    assertNothingDeleted(restored);
    expect(restored.stderr).toContain("invalid-row");
    expect(restored.stderr).toContain("contains \".\"");
    expect(await row("Soul", soulId)).toEqual(before);
  }, 300_000);

  test("an archived Soul row with a non-string value is refused before any delete", async () => {
    const home = tempDir("flair-2953-real-home-");
    const agent = "schema-value-agent";
    const soulId = `${agent}:identity`;

    await seedAgent(agent);
    expect(await operatorPut(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value: "a durable value", durability: "permanent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    const archive = await backup(home, "schema-value.json", agent);
    rewriteArchive(archive, (parsed) => {
      const soul = (parsed.souls as any[]).find((candidate) => String(candidate.id) === soulId);
      if (!soul) throw new Error(`archive has no Soul ${soulId}`);
      soul.value = 42;
    });
    const before = await row("Soul", soulId);

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(1);
    assertNothingDeleted(restored);
    expect(restored.stderr).toContain("invalid-row");
    expect(restored.stderr).toContain("value is not a string");
    expect(await row("Soul", soulId)).toEqual(before);
  }, 300_000);

  test("the server itself refuses a Soul row whose value is not a string", async () => {
    const agent = "schema-server-agent";
    const soulId = `${agent}:identity`;

    await seedAgent(agent);
    const refused = await operatorPutResponse(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value: 42, durability: "permanent", createdAt: CREATED_AT,
    });

    expect(refused.status, refused.body).toBe(500);
    expect(refused.body).toContain("instruction_version_append_failed");
    expect(await row("Soul", soulId)).toBeUndefined();
  }, 300_000);

  test("a well-formed archive still restores", async () => {
    const home = tempDir("flair-2953-real-home-");
    const agent = "well-formed-agent";
    const soulId = `${agent}:identity`;
    const memoryId = `${agent}:note`;

    await seedAgent(agent);
    expect(await operatorPut(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value: "an ordinary value", durability: "permanent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    expect(await operatorPut(`/Memory/${encodeURIComponent(memoryId)}`, {
      id: memoryId, agentId: agent, content: "an ordinary note", durability: "persistent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    const archive = await backup(home, "well-formed.json", agent);
    // Soul.put() stamps createdAt on a re-create, so an archived createdAt is
    // not restorable (flair#2705). Omit it to exercise the preflight rather
    // than that pre-existing verification mismatch.
    rewriteArchive(archive, (parsed) => {
      const soul = (parsed.souls as any[]).find((candidate) => String(candidate.id) === soulId);
      if (!soul) throw new Error(`archive has no Soul ${soulId}`);
      delete soul.createdAt;
    });

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(0);
    expect(restored.stdout).toContain("Deleting existing data");
    expect(restored.stdout).toContain("Restore complete");
    expect(await row("Soul", soulId)).toMatchObject({ agentId: agent, key: "identity", value: "an ordinary value" });
    expect(await row("Memory", memoryId)).toMatchObject({ agentId: agent, content: "an ordinary note" });
  }, 300_000);
});
