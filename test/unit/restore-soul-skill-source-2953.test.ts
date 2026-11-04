/**
 * restore-soul-skill-source-2953.test.ts — `flair restore --replace` refuses an
 * archived skill-assignment Soul row whose source is a filesystem path, before
 * any delete, because the server's durability verdict for such a source
 * depends on the server's environment (flair#2953).
 *
 * Each case runs the real restore command in a child process with `fetch` as
 * its only write path. The first case uses a path this process would call
 * durable; the second uses a non-path source, which the copied rule still
 * decides.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

const commandPath = join(import.meta.dirname, "../../src/commands/restore.ts");
const commanderPath = join(import.meta.dirname, "../../node_modules/commander/index.js");

type Call = { method: string; path: string };

function archiveText(source: string): string {
  const soul = {
    id: "soul-a",
    agentId: "agent-a",
    key: "skill-assignment",
    value: "a-skill",
    metadata: JSON.stringify({ source }),
  };
  return `${JSON.stringify({ version: 1, agents: [{ id: "agent-a", name: "agent-a" }], souls: [soul], memories: [] })}\n`;
}

/** Run the restore command in a child process with `fetch` recording every call. */
async function restore(source: string): Promise<{ exitCode: number; stdout: string; stderr: string; calls: Call[] }> {
  const dir = tempDir("flair-restore-soul-skill-source-2953-");
  const archivePath = join(dir, "old-backup.json");
  const bytes = Buffer.from(archiveText(source));
  writeFileSync(archivePath, bytes);
  writeFileSync(`${archivePath}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  old-backup.json\n`);
  const callsPath = join(dir, "calls.json");
  const driver = join(dir, "driver.ts");
  writeFileSync(driver, `
    import { Command } from ${JSON.stringify(commanderPath)};
    import { bindCli, register } from ${JSON.stringify(commandPath)};
    import { readFileSync, writeFileSync } from "node:fs";
    const callsPath = ${JSON.stringify(callsPath)};
    writeFileSync(callsPath, "[]");
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? "GET";
      const path = new URL(String(url)).pathname;
      const calls = JSON.parse(readFileSync(callsPath, "utf8"));
      calls.push({ method, path });
      writeFileSync(callsPath, JSON.stringify(calls));
      if (path.startsWith("/Memory/") || path === "/Memory") {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path.startsWith("/AdminMemoryCandidates/")) {
        return new Response(JSON.stringify({ candidates: [], hasMore: false }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    };
    bindCli({ resolveHttpPort: () => { throw new Error("unexpected port lookup"); } });
    const program = new Command();
    register(program);
    await program.parseAsync(["restore", ${JSON.stringify(archivePath)}, "--replace", "--url", "http://restore.invalid", "--admin-pass", "fixture"], { from: "user" });
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const child = Bun.spawn([process.execPath, driver], { env: { ...env, HOME: dir, USERPROFILE: dir }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr, calls: JSON.parse(readFileSync(callsPath, "utf8")) };
}

describe("restore --replace refuses a filesystem skill source before any delete (flair#2953)", () => {
  test("a source the CLI would call durable is refused", async () => {
    const result = await restore("/flair-durable-skills/a-skill/SKILL.md");

    expect(result.exitCode).not.toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).not.toContain("Deleting existing data");
    expect(result.stderr).toContain("Soul soul-a");
    expect(result.stderr).toContain("filesystem path");
    expect(result.stderr).toContain("restore without --replace");
    expect(result.stderr).toContain("edit that row's source in the archive");
    expect(result.stderr).toContain("no rows were deleted");
  });

  test("a non-path source still passes the preflight", async () => {
    const result = await restore("npm:@example/skills@1.0.0");

    expect(result.stdout).toContain("Deleting existing data");
    expect(result.calls).toContainEqual({ method: "DELETE", path: "/Soul/soul-a" });
    expect(result.stderr).not.toContain("filesystem path");
  });
});
