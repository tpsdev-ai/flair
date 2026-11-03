/**
 * restore-learned-preflight-2941.test.ts — `flair restore --replace` against a
 * REAL Harper and the REAL built CLI (flair#2941).
 *
 * The server's Soul PUT applies the scope-field rule and then the
 * learned-content rule: a write whose `value` equals a same-agent Memory
 * `content` or MemoryCandidate `claim` is refused (`soul_value_is_learned_content`).
 * Replace mode deletes only the archived ids, so a Memory or candidate row
 * written after the backup survives its deletes and refuses the Soul PUT that
 * follows. A Memory row whose id is in the archive is deleted before the
 * Souls, and a failed Memory DELETE stops the run before any Soul row is
 * deleted.
 *
 * Every case below runs a real `flair backup`, seeds the target with admin
 * credentials, and runs the built CLI under a throwaway HOME. The preflight
 * cases assert the live rows are byte-identical afterwards; that comparison
 * alone does not show which HTTP methods the CLI sent.
 *
 * Build prerequisite: `bun run build && bun run build:cli`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { nodeBin } from "../helpers/node-runtime";
import { tempDir } from "../helpers/temp-dir";
import { HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const CREATED_AT = "2026-10-01T00:00:00.000Z";

let harper: HarperInstance;

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
  const res = await fetch(harper.httpURL + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  await res.text();
  return res.status;
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
  const output = join(tempDir("flair-2941-real-archive-"), name);
  const passFile = join(tempDir("flair-2941-real-secrets-"), "admin-pass");
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

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error("dist/cli.js is missing: run `bun run build:cli` before this file; `bun run build` alone does not build the CLI");
  }
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  assertOwnInstance(harper);
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair restore --replace refuses a learned-content Soul replay before deleting (flair#2941)", () => {
  test("case (i): a Memory written after the backup with matching content stops the run and leaves the live rows unchanged", async () => {
    const home = tempDir("flair-2941-real-home-");
    const agent = "learned-memory-agent";
    const soulId = `${agent}:identity`;
    const memoryId = `${agent}:post-backup`;
    const value = "the text shared by soul value and memory content";

    await seedAgent(agent);
    expect(await operatorPut(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value, durability: "permanent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    const archive = await backup(home, "learned-memory.json", agent);
    expect(await operatorPut(`/Memory/${encodeURIComponent(memoryId)}`, {
      id: memoryId, agentId: agent, content: value, durability: "persistent", createdAt: CREATED_AT,
    })).toBeLessThan(300);

    const before = {
      agent: await row("Agent", agent),
      soul: await row("Soul", soulId),
      memory: await row("Memory", memoryId),
    };

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(1);
    expect(await row("Soul", soulId)).toEqual(before.soul);
    expect(await row("Memory", memoryId)).toEqual(before.memory);
    expect(await row("Agent", agent)).toEqual(before.agent);
    assertNothingDeleted(restored);
    expect(restored.stderr).toContain(`Soul ${soulId}`);
    expect(restored.stderr).toContain("soul_value_is_learned_content");
    expect(restored.stderr).toContain(memoryId);
    expect(restored.stderr).toContain("then re-run");
  }, 300_000);

  test("case (ii): a live MemoryCandidate claim matching an archived Soul value stops the run and leaves the live rows unchanged", async () => {
    const home = tempDir("flair-2941-real-home-");
    const agent = "learned-candidate-agent";
    const soulId = `${agent}:identity`;
    const candidateId = `${agent}:candidate`;
    const value = "the text shared by soul value and candidate claim";

    await seedAgent(agent);
    expect(await operatorPut(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value, durability: "permanent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    const archive = await backup(home, "learned-candidate.json", agent);
    await op({
      operation: "upsert",
      table: "MemoryCandidate",
      records: [{ id: candidateId, agentId: agent, claim: value, generatedAt: CREATED_AT, status: "pending" }],
    });

    const before = {
      soul: await row("Soul", soulId),
      candidate: await row("MemoryCandidate", candidateId),
    };

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(1);
    expect(await row("Soul", soulId)).toEqual(before.soul);
    expect(await row("MemoryCandidate", candidateId)).toEqual(before.candidate);
    assertNothingDeleted(restored);
    expect(restored.stderr).toContain(`Soul ${soulId}`);
    expect(restored.stderr).toContain("soul_value_is_learned_content");
    expect(restored.stderr).toContain(candidateId);
  }, 300_000);

  test("case (iii): a matching Memory whose id is archived is deleted first, so the Soul write is not refused", async () => {
    const home = tempDir("flair-2941-real-home-");
    const agent = "learned-archived-memory-agent";
    const soulId = `${agent}:identity`;
    const memoryId = `${agent}:memory`;
    const value = "the text both archived rows carry";

    await seedAgent(agent);
    expect(await operatorPut(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value, durability: "permanent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    expect(await operatorPut(`/Memory/${encodeURIComponent(memoryId)}`, {
      id: memoryId, agentId: agent, content: value, durability: "persistent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    const archive = await backup(home, "learned-archived-memory.json", agent);

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    // The replace ran: the archived Memory id was deleted before the Soul PUT,
    // so the preflight did not refuse it. The exit status reflects the
    // pre-existing createdAt mismatch on a re-created Soul (flair#2705, out of
    // scope for this change).
    expect(restored.stdout, `${restored.stdout}${restored.stderr}`).toContain("Deleting existing data");
    expect(restored.stderr).not.toContain("soul_value_is_learned_content");
    expect(await row("Soul", soulId)).toMatchObject({ agentId: agent, value });
    expect(await row("Memory", memoryId)).toMatchObject({ agentId: agent, content: value });
  }, 300_000);

  test("case (iv): a replace with nothing refused completes as before", async () => {
    const home = tempDir("flair-2941-real-home-");
    const agent = "learned-clean-agent";
    const memoryId = `${agent}:memory`;

    await seedAgent(agent);
    expect(await operatorPut(`/Memory/${encodeURIComponent(memoryId)}`, {
      id: memoryId, agentId: agent, content: "an ordinary note", durability: "persistent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    const archive = await backup(home, "learned-clean.json", agent);
    await op({ operation: "upsert", table: "Memory", records: [{ id: memoryId, content: "changed after the backup" }] });

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(0);
    expect(restored.stdout).toContain("Restore complete");
    expect(await row("Memory", memoryId)).toMatchObject({ agentId: agent, content: "an ordinary note" });
  }, 300_000);

  test("case (v): a candidate listing that cannot be read refuses with zero writes, and so does a target without the route", async () => {
    const home = tempDir("flair-2941-real-home-");
    const agent = "learned-unreadable-agent";
    const soulId = `${agent}:identity`;
    const value = "a value a candidate listing is needed to clear";

    await seedAgent(agent);
    expect(await operatorPut(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value, durability: "permanent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    const archive = await backup(home, "learned-unreadable.json", agent);

    let candidateMode: "shape" | "404" = "shape";
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/AdminMemoryCandidates/")) {
          const body = candidateMode === "404" ? { error: "not found" } : { candidates: "not-a-list", hasMore: false };
          return new Response(JSON.stringify(body), {
            status: candidateMode === "404" ? 404 : 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const target = new URL(url.pathname + url.search, harper.httpURL);
        const headers = new Headers(req.headers);
        headers.delete("host");
        const res = await fetch(target, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
          signal: AbortSignal.timeout(30_000),
        });
        return new Response(res.body, { status: res.status, headers: res.headers });
      },
    });
    const proxyURL = `http://127.0.0.1:${proxy.port}`;
    if (proxy.port === 9925 || proxy.port === 9926) throw new Error("refusing to run: proxy landed on a production ops port");

    try {
      const before = { agent: await row("Agent", agent), soul: await row("Soul", soulId) };
      const malformed = await runCli(["restore", archive, "--replace", "--url", proxyURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

      expect(malformed.code, `${malformed.stdout}${malformed.stderr}`).toBe(1);
      assertNothingDeleted(malformed);
      expect(malformed.stderr).toContain("AdminMemoryCandidates");
      expect(malformed.stderr).toContain("candidates is not an array");
      expect(await row("Soul", soulId)).toEqual(before.soul);
      expect(await row("Agent", agent)).toEqual(before.agent);

      candidateMode = "404";
      const oldServer = await runCli(["restore", archive, "--replace", "--url", proxyURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

      expect(oldServer.code, `${oldServer.stdout}${oldServer.stderr}`).toBe(1);
      assertNothingDeleted(oldServer);
      expect(oldServer.stderr).toContain("0.63.0");
      expect(await row("Soul", soulId)).toEqual(before.soul);
      expect(await row("Agent", agent)).toEqual(before.agent);
    } finally {
      proxy.stop(true);
    }
  }, 300_000);

  test("case (vi): a Memory DELETE the server refuses stops the run before any Soul row is deleted", async () => {
    const home = tempDir("flair-2941-real-home-");
    const agent = "learned-legacy-member-agent";
    const soulId = `${agent}:identity`;
    const memoryId = `${agent}:legacy.content`;
    const value = "the text shared by the soul and the legacy memory";

    await seedAgent(agent);
    expect(await operatorPut(`/Soul/${encodeURIComponent(soulId)}`, {
      id: soulId, agentId: agent, key: "identity", value, durability: "permanent", createdAt: CREATED_AT,
    })).toBeLessThan(300);
    await op({
      operation: "upsert", table: "Memory",
      records: [{ id: memoryId, agentId: agent, content: value, durability: "persistent", createdAt: CREATED_AT }],
    });
    const archive = await backup(home, "learned-legacy-member.json", agent);

    const before = { soul: await row("Soul", soulId), memory: await row("Memory", memoryId) };

    const restored = await runCli(["restore", archive, "--replace", "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });

    expect(restored.code, `${restored.stdout}${restored.stderr}`).toBe(1);
    expect(await row("Soul", soulId)).toEqual(before.soul);
    expect(await row("Memory", memoryId)).toEqual(before.memory);
    expect(restored.stderr).toContain(memoryId);
    expect(restored.stderr).toContain("no Soul row was deleted");
  }, 300_000);
});
