import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparePreservedFields } from "../../src/lib/restore-verify.ts";

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
  test("content still differing after PUT fails without logging the content values", async () => {
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

  test("a changed own __proto__ key in meta fails restore", async () => {
    const archived = { id: "m1", agentId: "flint", meta: JSON.parse('{"__proto__":{"x":1}}') };
    const restored = { ...archived, meta: JSON.parse('{"__proto__":{"x":2}}') };
    expect(comparePreservedFields("Memory", archived, restored)).toEqual(["meta"]);
    const archive = { version: 1, agents: [agent], souls: [], memories: [archived] };
    refused(await run(archive, [{ method: "GET", path: "/Memory/m1", body: restored }]), "m1", "meta");
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
    // Simulated GET response after PUT.
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

  test("generation with an absent embedding passes", async () => {
    const archive = {
      version: 1, agents: [agent], souls: [],
      memories: [{ id: "m1", agentId: "flint", content: "same", embeddingModel: "old-model" }],
    };
    const restored = { id: "m1", agentId: "flint", content: "same", embedding: [0.5, 0.6], embeddingModel: "new-model" };
    const result = await run(archive, [{ method: "GET", path: "/Memory/m1", body: restored }]);
    expect(result.exitCode).toBe(0);
  });

  for (const [field, value] of [
    ["embedding", [0.5, 0.6]],
    ["embeddingModel", "corrupted-model"],
    ["_safetyFlags", ["corrupted-flag"]],
  ] as const) {
    test(`supplied ${field} corruption after PUT fails verification`, async () => {
      const archived = {
        id: "m1", agentId: "flint", content: "", summary: "",
        embedding: [0.1, 0.2], embeddingModel: "archived-model", _safetyFlags: ["archived-flag"],
      };
      const restored = { ...archived, [field]: value };
      expect(comparePreservedFields("Memory", archived, restored)).toEqual([field]);
      const archive = { version: 1, agents: [agent], souls: [], memories: [archived] };
      refused(await run(archive, [{ method: "GET", path: "/Memory/m1", body: restored }]), "m1", field);
    });
  }

  test("a supplied embedding and model pass unchanged with nonempty content", async () => {
    const archived = { id: "m1", agentId: "flint", content: "same", embedding: [0.1, 0.2], embeddingModel: "archived-model" };
    const archive = { version: 1, agents: [agent], souls: [], memories: [archived] };
    expect((await run(archive)).exitCode).toBe(0);
    for (const field of ["embedding", "embeddingModel"]) {
      const restored = { ...archived, [field]: field === "embedding" ? [0.3, 0.2] : "changed-model" };
      refused(await run(archive, [{ method: "GET", path: "/Memory/m1", body: restored }]), field);
    }
  });

  test("without embedding text, a supplied model remains compared", async () => {
    const archived = { id: "m1", agentId: "flint", content: "", embedding: null, embeddingModel: "archived-model" };
    const archive = { version: 1, agents: [agent], souls: [], memories: [archived] };
    refused(await run(archive, [{ method: "GET", path: "/Memory/m1", body: { ...archived, embeddingModel: "changed-model" } }]), "embeddingModel");
  });

  test("skill trigger generation and scans can change derived fields", async () => {
    const archived = {
      id: "m1", agentId: "flint", content: "", summary: "", tags: ["skill"], trigger: "when reviewing",
      embedding: null, embeddingModel: "old-model", _safetyFlags: ["archived-flag"],
    };
    const restored = { ...archived, embedding: [0.5, 0.6], embeddingModel: "generated-model", _safetyFlags: ["skill:flag"] };
    const archive = { version: 1, agents: [agent], souls: [], memories: [archived] };
    expect((await run(archive, [{ method: "GET", path: "/Memory/m1", body: restored }])).exitCode).toBe(0);
  });

  test("a skill without scan text preserves flags", () => {
    const archived = { content: "", summary: "", trigger: "", tags: ["skill"], _safetyFlags: ["archived-flag"] };
    expect(comparePreservedFields("Memory", archived, { ...archived, _safetyFlags: null })).toEqual(["_safetyFlags"]);
  });

  test("a missing nested key differs from a null nested value", () => {
    expect(comparePreservedFields("Memory", { meta: { nested: null } }, { meta: {} })).toEqual(["meta"]);
    expect(comparePreservedFields("Memory", { meta: null }, {})).toEqual([]);
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
