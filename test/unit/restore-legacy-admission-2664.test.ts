/**
 * restore-legacy-admission-2664.test.ts — flair#2664 slice 1c: `flair
 * restore` admits an archive with no digest sidecar only through this host's
 * approval store (src/commands/restore.ts, src/lib/backup-approval-store.ts).
 *
 * Each case seeds the store under a temp HOME with approveArchive (or leaves
 * it empty), writes the archive (with or without a sidecar), and runs the
 * restore command in a child process with `fetch` as its only write path, the
 * way restore-confirmation-2215.test.ts does. A refusal sends no request at
 * all. The refusal cases for a missing approval run in all three modes; the
 * others run in the mode each names (merge unless stated).
 *
 * Admission rule: the store must hold an unrevoked approval for the digest of
 * the bytes read at the archive path, and the stored copy must still hash to
 * it; the rows restored come from that stored copy. A sidecar-backed archive
 * keeps the slice 1b preflight and does not consult the store.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { approveArchive, revokeApproval } from "../../src/lib/backup-approval-store.ts";

const commandPath = join(import.meta.dirname, "../../src/commands/restore.ts");
const commanderPath = join(import.meta.dirname, "../../node_modules/commander/index.js");

const archiveValue = {
  version: 1,
  agents: [{ id: "flint" }],
  souls: [],
  memories: [{ id: "m1", agentId: "flint", content: "legacy note", durability: "persistent" }],
};
const ARCHIVE = Buffer.from(JSON.stringify(archiveValue));
const SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const STOPPED = "restore stopped before any write";

type Call = { method: string; path: string; body?: string };

function home(): { home: string; root: string } {
  const dir = tempDir("flair-restore-legacy-home-2664-");
  return { home: dir, root: join(dir, ".flair", "approved-archives") };
}

function approve(root: string): void {
  approveArchive({ bytes: ARCHIVE, sha256: SHA, admission: "legacy", operator: "operator-x", archiveName: "old.json", now: "2026-10-19T00:00:00.000Z" }, { root });
}

async function restore(homeDir: string, bytes: Buffer, flags: string[] = [], sidecar = false) {
  const dir = tempDir("flair-restore-legacy-2664-");
  const archivePath = join(dir, "old-backup.json");
  writeFileSync(archivePath, bytes);
  if (sidecar) writeFileSync(`${archivePath}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  old-backup.json\n`);
  const callsPath = join(dir, "calls.json");
  const driver = join(dir, "driver.ts");
  writeFileSync(driver, `
    import { Command } from ${JSON.stringify(commanderPath)};
    import { bindCli, register } from ${JSON.stringify(commandPath)};
    import { writeFileSync } from "node:fs";
    const calls = [];
    const rows = new Map();
    writeFileSync(${JSON.stringify(callsPath)}, "[]");
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      const method = options.method ?? "GET";
      calls.push({ method, path, body: options.body });
      writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
      if (method === "PUT") rows.set(path, JSON.parse(options.body));
      if (method === "DELETE") rows.delete(path);
      if (method !== "GET") return new Response(null, { status: 204 });
      return rows.has(path) ? Response.json(rows.get(path)) : new Response(null, { status: 404 });
    };
    bindCli({ resolveHttpPort: () => { throw new Error("unexpected port lookup"); } });
    const program = new Command();
    register(program);
    await program.parseAsync(["restore", ${JSON.stringify(archivePath)}, "--url", "http://restore.invalid", "--admin-pass", "fixture", ...${JSON.stringify(flags)}], { from: "user" });
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const child = Bun.spawn([process.execPath, driver], { env: { ...env, HOME: homeDir, USERPROFILE: homeDir }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const calls: Call[] = JSON.parse(readFileSync(callsPath, "utf8"));
  return { archivePath, stdout, stderr, exitCode, calls };
}

type Result = Awaited<ReturnType<typeof restore>>;

function refusedBeforeAnyRequest(result: Result, ...fragments: string[]): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.calls).toEqual([]);
  expect(result.stdout).not.toContain("Restoring from");
  for (const fragment of fragments) expect(result.stderr).toContain(fragment);
}

describe("restore admits an archive with no sidecar only by an approval on this host (#2664)", () => {
  for (const flags of [[], ["--replace"], ["--dry-run"]]) {
    test(`${flags[0] ?? "merge"}: without an approval it refuses, naming legacy-admit`, async () => {
      const { home: h } = home();
      const result = await restore(h, ARCHIVE, flags);
      refusedBeforeAnyRequest(result, `archive digest sidecar ${result.archivePath}.sha256 not found; ${STOPPED}`,
        `flair backup-approval legacy-admit ${result.archivePath}`);
    });
  }

  test("an unrevoked approval whose stored copy still hashes to the digest admits it, restoring the stored rows", async () => {
    const { home: h, root } = home();
    approve(root);
    const result = await restore(h, ARCHIVE);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Archive SHA-256: ${SHA} (no digest sidecar; approved on this host by operator-x at 2026-10-19T00:00:00.000Z, legacy admission)`);
    expect(result.stdout).toContain("Restore complete");
    const puts = result.calls.filter((call) => call.method === "PUT");
    expect(puts.map((call) => call.path)).toEqual(["/Agent/flint", "/Memory/m1"]);
    expect(JSON.parse(puts[1]!.body!)).toEqual(archiveValue.memories[0]);
  });

  test("--dry-run with an approval sends no request and reports the approval", async () => {
    const { home: h, root } = home();
    approve(root);
    const result = await restore(h, ARCHIVE, ["--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toContain("approved on this host by operator-x");
    expect(result.stdout).toContain("Dry run complete");
  });

  test("a revoked approval refuses, naming legacy-admit", async () => {
    const { home: h, root } = home();
    approve(root);
    revokeApproval(SHA, "operator-y", { root }, "2026-10-20T00:00:00.000Z");
    const result = await restore(h, ARCHIVE, ["--replace"]);
    refusedBeforeAnyRequest(result, "was revoked at 2026-10-20T00:00:00.000Z by operator-y", STOPPED,
      `Approve the archive again on this host with flair backup-approval legacy-admit ${result.archivePath}`);
  });

  for (const flags of [[], ["--replace"], ["--dry-run"]]) {
    test(`${flags[0] ?? "merge"}: a stored copy changed after approval refuses on use`, async () => {
      const { home: h, root } = home();
      approve(root);
      const stored = join(root, "archives", `${SHA}.json`);
      writeFileSync(stored, Buffer.from(ARCHIVE.toString().replace("legacy note", "altered note")));
      chmodSync(stored, 0o600);
      const result = await restore(h, ARCHIVE, flags);
      refusedBeforeAnyRequest(result, `the approved copy ${stored} no longer hashes to ${SHA}`, STOPPED, "legacy-admit");
    });
  }

  test("a stored copy removed after approval refuses on use", async () => {
    const { home: h, root } = home();
    approve(root);
    const stored = join(root, "archives", `${SHA}.json`);
    renameSync(stored, join(tempDir("flair-restore-legacy-moved-2664-"), "moved.json"));
    const result = await restore(h, ARCHIVE);
    refusedBeforeAnyRequest(result, `the approved copy ${stored} is missing`, STOPPED);
  });

  test("an unsafe store refuses without suggesting a new approval", async () => {
    const { home: h, root } = home();
    approve(root);
    chmodSync(root, 0o755);
    const result = await restore(h, ARCHIVE);
    refusedBeforeAnyRequest(result, `approval store directory ${root} has mode 755, not 700`, STOPPED);
    expect(result.stderr).not.toContain("Approve the archive again");
    chmodSync(root, 0o700);
  });

  test("an approval of other bytes does not admit this archive", async () => {
    const { home: h, root } = home();
    approve(root);
    const other = Buffer.from(JSON.stringify({ ...archiveValue, memories: [] }));
    const result = await restore(h, other);
    refusedBeforeAnyRequest(result, "not found", `flair backup-approval legacy-admit ${result.archivePath}`);
  });

  test("a sidecar-backed archive keeps the slice 1b preflight and does not consult the store, even a revoked approval of the same digest", async () => {
    const { home: h, root } = home();
    approve(root);
    revokeApproval(SHA, "operator-y", { root });
    const result = await restore(h, ARCHIVE, [], true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Archive SHA-256: ${SHA} (matches ${result.archivePath}.sha256)`);
    expect(result.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  });
});
