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
