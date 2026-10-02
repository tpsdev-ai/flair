import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const commandPath = join(import.meta.dirname, "../../src/commands/restore.ts");
const commanderPath = join(import.meta.dirname, "../../node_modules/commander/index.js");

type Fault = { method: string; path: string; status?: number; body?: unknown; raw?: string };

/**
 * Drive `flair restore` against an in-process fake server. The server stores
 * each PUT body verbatim and serves it on GET, unless a fault overrides the
 * response — which is how a test models a row whose stored content does not
 * match the archive (a stale row at the same ID and owner).
 */
async function run(backup: unknown, faults: Fault[] = [], flags: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "restore-2226-"));
  try {
    writeFileSync(join(dir, "archive.json"), JSON.stringify(backup));
    writeFileSync(join(dir, "driver.ts"), `
      import { Command } from ${JSON.stringify(commanderPath)};
      import { bindCli, register } from ${JSON.stringify(commandPath)};
      import { writeFileSync } from "node:fs";
      const archive = ${JSON.stringify(backup)};
      const faults = ${JSON.stringify(faults)};
      const calls = [];
      const rows = new Map(Object.entries({ Agent: archive.agents, Soul: archive.souls, Memory: archive.memories })
        .flatMap(([name, records]) => records.map(row => [name + "/" + row.id, row])));
      const saveRows = () => writeFileSync(${JSON.stringify(join(dir, "rows.json"))}, JSON.stringify([...rows]));
      saveRows();
      globalThis.fetch = async (url, options = {}) => {
        const path = new URL(String(url)).pathname;
        const method = options.method ?? "GET";
        calls.push({ method, path });
        writeFileSync(${JSON.stringify(join(dir, "calls.json"))}, JSON.stringify(calls));
        const fault = faults.find(f => f.path === path && f.method === method);
        if (fault?.error) throw new Error(String(fault.error));
        if (fault) return new Response(fault.raw ?? JSON.stringify("body" in fault ? fault.body : { error: "fixture failure" }), { status: fault.status ?? 200 });
        const [_, name, id] = path.split("/");
        const key = name + "/" + decodeURIComponent(id);
        if (method === "DELETE") rows.delete(key);
        if (method === "PUT") rows.set(key, JSON.parse(options.body));
        saveRows();
        if (method !== "GET") return new Response(null, { status: 204 });
        return rows.has(key) ? Response.json(rows.get(key)) : new Response(null, { status: 404 });
      };
      bindCli({ resolveHttpPort: () => { throw new Error("unexpected port lookup"); } });
      const program = new Command();
      register(program);
      await program.parseAsync(["restore", ${JSON.stringify(join(dir, "archive.json"))}, "--url", "http://restore.invalid", "--admin-pass", "fixture", ...${JSON.stringify(flags)}], { from: "user" });
    `);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
    const child = Bun.spawn([process.execPath, join(dir, "driver.ts")], {
      env: { ...env, HOME: dir, USERPROFILE: dir }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    let calls: Array<{ method: string; path: string }> = [];
    try { calls = JSON.parse(readFileSync(join(dir, "calls.json"), "utf8")); } catch {}
    return { stdout, stderr, exitCode, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function refused(result: Awaited<ReturnType<typeof run>>, ...names: string[]) {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).not.toContain("Restore complete");
  for (const name of names) expect(result.stderr).toContain(name);
}

const agent = { id: "flint" };

describe("restore verifies preserved content (#2226)", () => {
  test("a stale row at the same ID and owner fails, naming the field and never its value", async () => {
    const archive = {
      version: 1, agents: [agent], souls: [],
      memories: [{ id: "m1", agentId: "flint", content: "ARCHIVED", tags: ["a", "b"] }],
    };
    const stale = { id: "m1", agentId: "flint", content: "STALE", tags: ["a", "b"] };
    const result = await run(archive, [{ method: "GET", path: "/Memory/m1", body: stale }]);
    refused(result, "m1", "flint", "content");
    expect(result.stdout).not.toContain("STALE");
    expect(result.stderr).not.toContain("STALE");
    expect(result.stdout).not.toContain("ARCHIVED");
    expect(result.stderr).not.toContain("ARCHIVED");
  });

  test("a mismatching array field is named", async () => {
    const archive = {
      version: 1, agents: [agent], souls: [],
      memories: [{ id: "m1", agentId: "flint", content: "same", tags: ["a"] }],
    };
    const stale = { id: "m1", agentId: "flint", content: "same", tags: ["a", "b"] };
    refused(await run(archive, [{ method: "GET", path: "/Memory/m1", body: stale }]), "m1", "flint", "tags");
  });

  test("a stale Soul value fails, naming the field", async () => {
    const archive = {
      version: 1, agents: [agent], memories: [],
      souls: [{ id: "flint:role", agentId: "flint", key: "role", value: "ARCHIVED" }],
    };
    const stale = { id: "flint:role", agentId: "flint", key: "role", value: "STALE" };
    refused(await run(archive, [{ method: "GET", path: "/Soul/flint%3Arole", body: stale }]), "flint:role", "flint", "value");
  });

  test("restamped fields (updatedAt, provenance, token, hit stats) do not cause a false mismatch", async () => {
    const archived = {
      id: "m1", agentId: "flint", content: "same", createdAt: "2020-01-01T00:00:00.000Z",
      tags: ["a"], durability: "standard", visibility: "private",
    };
    const archive = { version: 1, agents: [agent], souls: [], memories: [archived] };
    // What the server returns after the PUT: same preserved content, every
    // restamped/derived field changed (updatedAt, provenance, instanceToken,
    // the MemoryHitStat overlay, the safety rescan).
    const restored = {
      ...archived,
      updatedAt: "2026-10-02T00:00:00.000Z",
      provenance: '{"v":1,"verified":{"agentId":"flint","timestamp":"2026-10-02T00:00:00.000Z","receivedAt":"2026-10-02T00:00:00.000Z"}}',
      instanceToken: "9d2f0f6e-0000-0000-0000-000000000000",
      originatorInstanceId: "target-instance",
      retrievalCount: 42,
      lastRetrieved: "2026-10-02T00:00:00.000Z",
      _safetyFlags: null,
    };
    const result = await run(archive, [{ method: "GET", path: "/Memory/m1", body: restored }]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Restore complete");
  });

  test("a secret in a mismatching field never reaches stdout or stderr", async () => {
    const secret = "RESTORE_SECRET_SENTINEL_2226";
    const archive = {
      version: 1, agents: [agent], souls: [],
      memories: [{ id: "m1", agentId: "flint", content: "ok", summary: "ok" }],
    };
    const stale = { id: "m1", agentId: "flint", content: "ok", summary: secret };
    const result = await run(archive, [{ method: "GET", path: "/Memory/m1", body: stale }]);
    refused(result, "m1", "flint", "summary");
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  });

  test("a differing server-derived embedding is not a content mismatch", async () => {
    // embedding/embeddingModel are recomputed by the write path when absent and
    // stored at reduced precision, so restore does not compare them.
    const archive = {
      version: 1, agents: [agent], souls: [],
      memories: [{ id: "m1", agentId: "flint", content: "same", embedding: [0.1, 0.2], embeddingModel: "old-model" }],
    };
    const restored = { id: "m1", agentId: "flint", content: "same", embedding: [0.5, 0.6], embeddingModel: "new-model" };
    const result = await run(archive, [{ method: "GET", path: "/Memory/m1", body: restored }]);
    expect(result.exitCode).toBe(0);
  });

  test("the archive's omitted columns are not demanded back", async () => {
    // A legacy archived row has no `summary`; a restored row that adds none
    // (or a null) must still pass.
    const archive = {
      version: 1, agents: [agent], souls: [],
      memories: [{ id: "m1", agentId: "flint", content: "same" }],
    };
    const restored = { id: "m1", agentId: "flint", content: "same", summary: null, updatedAt: "2026-10-02T00:00:00.000Z" };
    const result = await run(archive, [{ method: "GET", path: "/Memory/m1", body: restored }]);
    expect(result.exitCode).toBe(0);
  });

  test("an all-preserved match still passes end to end", async () => {
    const result = await run({
      version: 1, agents: [agent], souls: [{ id: "flint:role", agentId: "flint", key: "role", value: "r" }],
      memories: [{ id: "m1", agentId: "flint", content: "c" }],
    });
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter(c => c.method === "GET")).toHaveLength(3);
  });
});
