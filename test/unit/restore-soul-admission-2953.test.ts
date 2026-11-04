/**
 * restore-soul-admission-2953.test.ts — archive admission refuses a Soul row
 * whose agentId is not a non-empty string, before restore can delete anything
 * (flair#2953).
 *
 * The replace preflight in src/commands/restore.ts does not repeat this
 * owner check: rowShapeProblem (src/lib/restore-archive.ts) refuses the row as
 * invalid at /souls/N/agentId, so no restore reaches a write. Each case runs
 * the real parseRestoreArchive and the real restore command with `fetch` as
 * its only write path; a refusal sends no request at all.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { parseRestoreArchive } from "../../src/lib/restore-archive.ts";

const commandPath = join(import.meta.dirname, "../../src/commands/restore.ts");
const commanderPath = join(import.meta.dirname, "../../node_modules/commander/index.js");

type Variant = { label: string; agentId: string | number | undefined };

/** A Soul row with the variant's agentId; undefined omits the field. */
function archiveText({ agentId }: Variant): string {
  const soul: Record<string, unknown> = { id: "soul-1", key: "role", value: "builder" };
  if (agentId !== undefined) soul.agentId = agentId;
  return `${JSON.stringify({ version: 1, agents: [{ id: "agent-a" }], souls: [soul], memories: [] })}\n`;
}

const VARIANTS: Variant[] = [
  { label: "missing", agentId: undefined },
  { label: "empty string", agentId: "" },
  { label: "non-string", agentId: 42 },
];

type Call = { method: string; path: string };

/** Run the restore command in a child process with `fetch` recording every call. */
async function restore(text: string): Promise<{ exitCode: number; stdout: string; stderr: string; calls: Call[] }> {
  const dir = tempDir("flair-restore-soul-admission-2953-");
  const archivePath = join(dir, "old-backup.json");
  const bytes = Buffer.from(text);
  writeFileSync(archivePath, bytes);
  const name = basename(archivePath);
  writeFileSync(`${archivePath}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
  const callsPath = join(dir, "calls.json");
  const driver = join(dir, "driver.ts");
  writeFileSync(driver, `
    import { Command } from ${JSON.stringify(commanderPath)};
    import { bindCli, register } from ${JSON.stringify(commandPath)};
    import { readFileSync, writeFileSync } from "node:fs";
    const callsPath = ${JSON.stringify(callsPath)};
    writeFileSync(callsPath, "[]");
    globalThis.fetch = async (url, options = {}) => {
      const calls = JSON.parse(readFileSync(callsPath, "utf8"));
      calls.push({ method: options.method ?? "GET", path: new URL(String(url)).pathname });
      writeFileSync(callsPath, JSON.stringify(calls));
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

describe("archive admission refuses a Soul row without a non-empty string agentId (flair#2953)", () => {
  for (const variant of VARIANTS) {
    test(`the real admission function refuses an agentId that is ${variant.label}`, () => {
      const parsed = parseRestoreArchive(Buffer.from(archiveText(variant)));
      expect(parsed).toMatchObject({ ok: false, code: "invalid-row", location: "/souls/0/agentId" });
      if (parsed.ok) throw new Error("archive admission accepted a Soul row without a non-empty string agentId");
      expect(parsed.reason).toContain("agentId");
    });

    test(`the restore command refuses an agentId that is ${variant.label} before any request`, async () => {
      const result = await restore(archiveText(variant));
      expect(result.exitCode).not.toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.stdout).not.toContain("Restoring from");
      expect(result.stderr).toContain("(invalid-row at /souls/0/agentId)");
    });
  }
});
