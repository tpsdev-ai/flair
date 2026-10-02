import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const commandPath = join(import.meta.dirname, "../../src/commands/restore.ts");
const commanderPath = join(import.meta.dirname, "../../node_modules/commander/index.js");
const archive = {
  version: 1,
  agents: [{ id: "flint" }, { id: "kern" }],
  souls: [{ id: "flint:soul", agentId: "flint" }, { id: "kern:soul", agentId: "kern" }],
  memories: [{ id: "m/1?#%", agentId: "flint" }, { id: "m2", agentId: "kern" }],
};
const memoryPath = "/Memory/m%2F1%3F%23%25";
type Fault = { method: string; path: string; status?: number; body?: unknown; error?: string; raw?: string };

async function run(faults: Fault[] = [], backup: unknown = archive, flags: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "restore-2215-"));
  try {
    writeFileSync(join(dir, "archive.json"), JSON.stringify(backup));
    writeFileSync(join(dir, "driver.ts"), `
      import { Command } from ${JSON.stringify(commanderPath)};
      import { bindCli, register } from ${JSON.stringify(commandPath)};
      import { writeFileSync } from "node:fs";
      const archive = ${JSON.stringify(archive)};
      const faults = ${JSON.stringify(faults)};
      const calls = [];
      const rows = new Map(Object.entries({ Agent: archive.agents, Soul: archive.souls, Memory: archive.memories })
        .flatMap(([name, records]) => records.map(row => [name + "/" + row.id, row])));
      const saveRows = () => writeFileSync(${JSON.stringify(join(dir, "rows.json"))}, JSON.stringify([...rows]));
      saveRows();
      globalThis.fetch = async (url, options = {}) => {
        const path = new URL(String(url)).pathname;
        const method = options.method ?? "GET";
        calls.push({ method, path, auth: options.headers.Authorization, body: options.body });
        writeFileSync(${JSON.stringify(join(dir, "calls.json"))}, JSON.stringify(calls));
        const fault = faults.find(f => f.path === path && f.method === method);
        if (fault?.error) throw new Error(fault.error);
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
    let calls: Array<{ method: string; path: string; auth: string; body: string }> = [];
    try { calls = JSON.parse(readFileSync(join(dir, "calls.json"), "utf8")); } catch {}
    const rows = new Map<string, unknown>(JSON.parse(readFileSync(join(dir, "rows.json"), "utf8")));
    return { stdout, stderr, exitCode, calls, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function refused(result: Awaited<ReturnType<typeof run>>, ...names: string[]) {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).not.toContain("Restore complete");
  for (const name of names) expect(result.stderr).toContain(name);
}

describe("restore confirms archived IDs (#2215)", () => {
  test("one Memory PUT failure names its ID even when a pre-existing row reads back", async () => {
    refused(await run([{ method: "PUT", path: memoryPath, status: 500 }]), "m/1?#%", "flint", "PUT", "500");
  });

  test("reports partial failures across agents, souls and memories and verifies every ID", async () => {
    const result = await run([
      { method: "PUT", path: "/Agent/flint", error: "connection lost" },
      { method: "PUT", path: "/Soul/kern%3Asoul", status: 403 },
      { method: "PUT", path: "/Memory/m2", status: 500 },
      { method: "GET", path: memoryPath, status: 404 },
    ]);
    refused(result, "flint", "unavailable", "kern:soul", "403", "m2", "500", "m/1?#%", "404");
    expect(result.calls.filter(call => call.method === "PUT")).toHaveLength(6);
    expect(result.calls.filter(call => call.method === "GET")).toHaveLength(6);
  });

  for (const collection of ["agents", "souls", "memories"]) {
    test(`refuses non-array ${collection} before writes`, async () => {
      const result = await run([], { ...archive, [collection]: { length: 0 } });
      refused(result, "not an array");
      expect(result.calls).toEqual([]);
    });
  }

  for (const fault of [
    { status: 404 }, { status: 503 }, { error: "read disconnected" }, { raw: "invalid JSON" },
    { body: null }, { body: [] }, { body: [{ id: "m/1?#%", agentId: "flint" }] },
    { body: { id: "wrong", agentId: "flint" } }, { body: { id: "m/1?#%", agentId: "kern" } },
  ]) {
    test(`refuses unconfirmed Memory read: ${JSON.stringify(fault)}`, async () => {
      refused(await run([{ method: "GET", path: memoryPath, ...fault }]), "m/1?#%", "flint", "verification failed");
    });
  }

  for (const path of ["/Agent/kern", "/Soul/kern%3Asoul"]) {
    test(`verifies ${path}`, async () => {
      refused(await run([{ method: "GET", path, status: 404 }]), "kern", "404");
    });
  }

  test("all-good merge confirms every ID with Basic auth, after souls precede memories", async () => {
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Restore complete");
    expect(result.calls.map(call => call.method)).toEqual([...Array(6).fill("PUT"), ...Array(6).fill("GET")]);
    expect(result.calls.slice(0, 6).map(call => call.path)).toEqual([
      "/Agent/flint", "/Agent/kern", "/Soul/flint%3Asoul", "/Soul/kern%3Asoul", memoryPath, "/Memory/m2",
    ]);
    expect(result.calls.slice(6).map(call => call.path)).toEqual(result.calls.slice(0, 6).map(call => call.path));
    expect(result.calls.every(call => call.auth === `Basic ${Buffer.from("admin:fixture").toString("base64")}`)).toBe(true);
    expect(JSON.parse(result.calls.find(call => call.path === memoryPath)!.body)).toEqual(archive.memories[0]);
  });

  test("replace restores an earlier deleted row after the second deletion fails", async () => {
    const result = await run([{ method: "DELETE", path: "/Soul/kern%3Asoul", status: 500 }], archive, ["--replace"]);
    expect(result.rows.get("Soul/flint:soul")).toEqual(archive.souls[0]);
    refused(result, "kern:soul", "kern", "DELETE", "500");
    expect(result.calls.slice(0, 2).map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "DELETE", path: "/Soul/flint%3Asoul" },
      { method: "DELETE", path: "/Soul/kern%3Asoul" },
    ]);
    expect(result.calls.filter(call => call.method === "DELETE")).toHaveLength(4);
    expect(result.calls.filter(call => call.method === "PUT")).toHaveLength(6);
    expect(result.calls.filter(call => call.method === "GET")).toHaveLength(6);
  });

  for (const method of ["DELETE", "PUT", "GET"]) {
    for (const kind of ["response", "throw"]) {
      test(`${method} ${kind} diagnostics omit server secrets`, async () => {
        const secret = "RESTORE_SECRET_SENTINEL_2221";
        const fault = kind === "response" ? { status: 503, raw: secret } : { error: secret };
        const result = await run([{ method, path: memoryPath, ...fault }], archive, ["--replace"]);
        expect(result.stdout).not.toContain(secret);
        expect(result.stderr).not.toContain(secret);
        refused(result, "m/1?#%", "flint", method, kind === "response" ? "503" : "unavailable");
      });
    }
  }

  test("verification JSON errors omit response secrets and retain HTTP status", async () => {
    const secret = "RESTORE_SECRET_SENTINEL_2221";
    const result = await run([{ method: "GET", path: memoryPath, raw: secret }]);
    refused(result, "m/1?#%", "flint", "GET", "200");
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  });

  test("replace accepts already-absent rows then verifies all restored IDs", async () => {
    const result = await run([{ method: "DELETE", path: memoryPath, status: 404 }], archive, ["--replace"]);
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter(call => call.method === "DELETE")).toHaveLength(4);
    expect(result.calls.filter(call => call.method === "GET")).toHaveLength(6);
  });

  test("dry run sends no requests", async () => {
    const result = await run([], archive, ["--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).not.toContain("Restore complete");
  });

  test("invalid archived row names its position and sends no requests", async () => {
    const result = await run([], { ...archive, memories: [null] });
    refused(result, "Memory row 0", "missing ID");
    expect(result.calls).toEqual([]);
  });
});
