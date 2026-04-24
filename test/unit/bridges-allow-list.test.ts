import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allow, revoke, list, isAllowed } from "../../src/bridges/runtime/allow-list";

function sandbox(): { path: string; cleanup: () => void } {
  const dir = join(tmpdir(), `flair-allow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return {
    path: join(dir, "bridges-allowed.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("allow-list: basic CRUD", () => {
  let sb: ReturnType<typeof sandbox>;
  beforeEach(() => { sb = sandbox(); });
  afterEach(() => sb.cleanup());

  test("isAllowed returns false for an empty list (file absent)", async () => {
    expect(await isAllowed("anything", { path: sb.path })).toBe(false);
  });

  test("allow creates the file and records the entry", async () => {
    const result = await allow("mem0", { path: sb.path });
    expect(result.alreadyAllowed).toBe(false);
    expect(existsSync(sb.path)).toBe(true);
    expect(await isAllowed("mem0", { path: sb.path })).toBe(true);
    const saved = JSON.parse(readFileSync(sb.path, "utf-8"));
    expect(Array.isArray(saved.allowed)).toBe(true);
    expect(saved.allowed[0].name).toBe("mem0");
    expect(saved.allowed[0].allowedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("allow is idempotent — re-adding returns alreadyAllowed", async () => {
    await allow("mem0", { path: sb.path });
    const result = await allow("mem0", { path: sb.path });
    expect(result.alreadyAllowed).toBe(true);
    const entries = await list({ path: sb.path });
    expect(entries).toHaveLength(1);
  });

  test("revoke removes the entry and reports wasAllowed", async () => {
    await allow("mem0", { path: sb.path });
    const result = await revoke("mem0", { path: sb.path });
    expect(result.wasAllowed).toBe(true);
    expect(await isAllowed("mem0", { path: sb.path })).toBe(false);
  });

  test("revoke on a missing entry reports wasAllowed=false, no-op", async () => {
    const result = await revoke("never-allowed", { path: sb.path });
    expect(result.wasAllowed).toBe(false);
  });

  test("list returns entries sorted by name (deterministic file contents)", async () => {
    await allow("zeta", { path: sb.path });
    await allow("alpha", { path: sb.path });
    await allow("middle", { path: sb.path });
    const entries = await list({ path: sb.path });
    expect(entries.map((e) => e.name)).toEqual(["alpha", "middle", "zeta"]);
  });

  test("malformed JSON file is tolerated as an empty list", async () => {
    writeFileSync(sb.path, "{definitely not valid json");
    expect(await isAllowed("anything", { path: sb.path })).toBe(false);
    // A subsequent allow overwrites the corrupt file cleanly.
    await allow("mem0", { path: sb.path });
    expect(await isAllowed("mem0", { path: sb.path })).toBe(true);
  });

  test("entries missing required fields are filtered on read", async () => {
    writeFileSync(sb.path, JSON.stringify({ allowed: [{ name: "ok", allowedAt: new Date().toISOString() }, { name: "bad" }, { foo: "missing name" }] }));
    const entries = await list({ path: sb.path });
    expect(entries.map((e) => e.name)).toEqual(["ok"]);
  });

  test("writes are atomic (no leftover .tmp on success)", async () => {
    await allow("mem0", { path: sb.path });
    const siblings = require("node:fs").readdirSync(require("node:path").dirname(sb.path));
    expect(siblings.filter((f: string) => f.endsWith(".tmp"))).toEqual([]);
  });
});
