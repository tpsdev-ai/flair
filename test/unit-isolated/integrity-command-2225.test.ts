import { expect, test } from "bun:test";
import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir";
import { bindIntegrityCli, register } from "../../src/commands/integrity";
import { emptyCheckpoint } from "../../src/lib/memory-integrity";

test("malformed successful Memory responses are UNKNOWN and never advance even with --accept", async () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const path = join(tempDir("flair-integrity-malformed-"), "checkpoint.json");
  const original = JSON.stringify(emptyCheckpoint("baseline", [{ id: "m", durability: "permanent" }]));
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "admin" });
    process.exit = ((code: number) => { throw new Error(`exit:${code}`); }) as typeof process.exit;
    for (const row of [null, {}, { id: 42 }, { id: "" }]) {
      writeFileSync(path, original);
      let output = "";
      process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
      globalThis.fetch = (async (_url: any, init: any) => {
        const { table } = JSON.parse(init.body);
        return new Response(JSON.stringify(table === "Memory" ? [row] : []));
      }) as typeof fetch;
      const program = new Command();
      register(program);
      await expect(program.parseAsync(["integrity", "check", "--json", "--accept", "--checkpoint", path, "--admin-pass", "secret"], { from: "user" })).rejects.toThrow("exit:3");
      expect(JSON.parse(output).status).toBe("unknown");
      expect(JSON.parse(output).checkpointWritten).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(original);
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
  }
});

test("UNKNOWN human output reports unavailable corpus counts", async () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalLog = console.log;
  let output = "";
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "admin" });
    globalThis.fetch = (async () => { throw new Error("read failed"); }) as unknown as typeof fetch;
    process.exit = ((code: number) => { throw new Error(`exit:${code}`); }) as typeof process.exit;
    console.log = (value) => { output += String(value); };
    const program = new Command();
    register(program);
    await expect(program.parseAsync(["integrity", "check", "--admin-pass", "secret"], { from: "user" })).rejects.toThrow("exit:3");
    expect(output).toContain("corpus: unavailable");
    expect(output).not.toContain("0 rows");
    expect(output).toContain("read failed");
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    console.log = originalLog;
  }
});

test("the command reads incarnation fields and reports a named loss without count drift", async () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const path = join(tempDir("flair-integrity-incarnation-"), "checkpoint.json");
  const instanceToken = "2026-10-02";
  const checkpoint = JSON.stringify(emptyCheckpoint("baseline", [{ id: "m", durability: "permanent", instanceToken }]));
  try {
    bindIntegrityCli({ resolveOpsPort: () => 19925, resolveAdminUser: () => "admin" });
    process.exit = ((code: number) => { throw new Error(`exit:${code}`); }) as typeof process.exit;
    for (const memoryInstanceToken of ["2026-10-01", instanceToken]) {
      for (const json of [true, false]) {
        writeFileSync(path, checkpoint);
        let output = "";
        process.stdout.write = ((value: any) => { output += String(value); return true; }) as typeof process.stdout.write;
        console.log = (value) => { output += String(value); };
        globalThis.fetch = (async (_url: any, init: any) => {
          const { table, get_attributes } = JSON.parse(init.body);
          expect(get_attributes).toContain(table === "Memory" ? "instanceToken" : "memoryInstanceToken");
          return new Response(JSON.stringify(table === "Memory" ? [] : [{ id: "d", memoryId: "m", memoryInstanceToken, at: "deleted" }]));
        }) as typeof fetch;
        const program = new Command();
        register(program);
        const healthy = memoryInstanceToken === instanceToken;
        await expect(program.parseAsync(["integrity", "check", ...(json ? ["--json"] : []), "--checkpoint", path, "--admin-pass", "secret"], { from: "user" })).rejects.toThrow(`exit:${healthy ? 0 : 2}`);
        if (json) {
          const verdict = JSON.parse(output);
          expect(verdict.status).toBe(healthy ? "healthy" : "alert");
          expect(verdict.losses).toEqual(healthy ? [] : [{ id: "m", tier: "permanent" }]);
          expect(verdict.unexplainedDecrease).toEqual({});
        } else {
          expect(output).toContain(healthy ? "history-backed attribution(s)" : "UNEXPLAINED durable row loss(es)");
          expect(output).not.toContain("not accounted for by the id set");
          expect(output).not.toContain("deliberate delete");
        }
        if (!healthy) expect(readFileSync(path, "utf8")).toBe(checkpoint);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
});
