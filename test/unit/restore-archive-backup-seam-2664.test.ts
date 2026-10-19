/**
 * restore-archive-backup-seam-2664.test.ts — flair#2664 slice 1a: the file the
 * real `flair backup` command publishes is parsed and checked by the restore
 * validator.
 *
 * Each case runs src/commands/backup.ts in a child process, the way
 * test/unit/backup-fail-closed-2214.test.ts does: `fetch` is replaced with a
 * fixture source for the REST and operations origins (`*.invalid`, no
 * network), and HOME and --output point into a throwaway directory. The test
 * then reads the published file's exact bytes, passes them to
 * parseRestoreArchive, and passes the parsed archive it returns to
 * validateRestoreSelection.
 *
 * Two fixture sources:
 * - "served" returns each stored Memory row through applyPromotionBinding,
 *   the read accessor the admin collection GET applies (resources/Memory.ts
 *   search()). A verdict without a matching binding hash reaches the archive
 *   with its four promotion fields cleared.
 * - "unchanged" returns stored rows as they are, as a server from before
 *   promotion bindings did; its archives carry verdicts with no hash.
 *
 * Slice 1b: each case's backup run publishes `<archive>.sha256` beside the
 * archive. One case checks that the sidecar holds the SHA-256 of the file's
 * exact bytes and that readBackupArtifact (the restore preflight) admits the
 * pair; another runs the real `shasum -a 256 -c` on the pair and on a changed
 * archive (skipped only where `shasum` is not installed; the checksum-tools
 * test fails on Linux and macOS when it is missing).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { parseRestoreArchive, validateRestoreSelection } from "../../src/lib/restore-archive.ts";
import { readBackupArtifact } from "../../src/lib/backup-artifact.ts";
import { findChecksumTools, runChecksumTool } from "../helpers/checksum-tools.ts";
import { promotionContentHash } from "../../src/lib/promotion-content-hash.ts";
import { applyPromotionBinding } from "../../resources/promotion-binding.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PROMOTED_AT = "2026-10-02T00:00:00.000Z";
const CREATED_AT = "2026-10-01T00:00:00.000Z";

type Row = Record<string, unknown> & { id: string };
type OwnedRow = Row & { agentId: string };

const agents: Row[] = [{ id: "flint", name: "Flint" }, { id: "kern", name: "Kern" }];
const souls: OwnedRow[] = [{ id: "flint:identity", agentId: "flint", key: "identity", value: "Flint" }];

const reviewed = `Reviewed lesson ${String.fromCodePoint(0xe9, 0x20, 0x2713)}`;
/** Stored Memory rows, as the table holds them. */
const stored: OwnedRow[] = [
  {
    id: "m-bound", agentId: "flint", content: reviewed, durability: "persistent", createdAt: CREATED_AT,
    tags: ["lesson"], embedding: [0.25, 0.5], promotionStatus: "approved", promotedAt: PROMOTED_AT,
    promotedBy: "kern", promotionContentHash: promotionContentHash(reviewed),
  },
  {
    id: "m-legacy", agentId: "flint", content: "Approved before bindings", durability: "persistent", createdAt: CREATED_AT,
    promotionStatus: "approved", promotedAt: PROMOTED_AT, promotedBy: "kern", promotionContentHash: null,
  },
  {
    id: "m-plain", agentId: "kern", content: "Unreviewed note", durability: "standard", createdAt: CREATED_AT,
    promotionStatus: null, promotedAt: null, promotedBy: null, promotionContentHash: null,
  },
];
/** A verdict whose hash binds text other than the row's content. */
const stale: OwnedRow = {
  id: "m-stale", agentId: "kern", content: "Edited after review", durability: "persistent", createdAt: CREATED_AT,
  promotionStatus: "approved", promotedAt: PROMOTED_AT, promotedBy: "kern",
  promotionContentHash: promotionContentHash("Original reviewed text"),
};

/** The child: the real backup command against the fixture source. */
const CHILD = `
import { readFileSync } from "node:fs";
const env = process.env;
const fixture = JSON.parse(readFileSync(env.RESTORE_SEAM_FIXTURE, "utf8"));
const auth = "Basic " + Buffer.from("admin:test-pass").toString("base64");
const owned = (table) => (table === "Memory" ? fixture.memories : fixture.souls);
globalThis.fetch = async (url, init = {}) => {
  if (init.headers?.Authorization !== auth) throw new Error("incorrect auth");
  if (!init.signal) throw new Error("missing timeout signal");
  const u = new URL(String(url));
  if (u.origin === "http://ops.invalid") {
    const body = JSON.parse(String(init.body));
    const rows = body.table === "Agent" ? fixture.agents : owned(body.table);
    if (body.operation === "describe_table" && body.exact_count === true) return Response.json({ record_count: rows.length });
    if (body.operation === "search_by_value") {
      return Response.json(rows.map((r) => (body.table === "Agent" ? { id: r.id } : { id: r.id, agentId: r.agentId })));
    }
    throw new Error("unexpected ops operation " + body.operation);
  }
  if (u.origin !== "http://backup.invalid") throw new Error("unexpected target " + u.origin);
  if (u.pathname === "/Agent/" && u.search === "") return Response.json(fixture.agents);
  const table = u.pathname === "/Memory/" ? "Memory" : u.pathname === "/Soul/" ? "Soul" : undefined;
  const agentId = u.searchParams.get("agentId");
  if (table && agentId !== null) return Response.json(owned(table).filter((r) => r.agentId === agentId));
  throw new Error("unexpected request " + u.pathname + u.search);
};
const { Command } = await import(env.RESTORE_SEAM_COMMANDER);
const { bindCli, register } = await import(env.RESTORE_SEAM_BACKUP);
const { resolveOpsTarget } = await import(env.RESTORE_SEAM_CLI);
bindCli({
  addSharedCredentialOptions(command) { return command.option("--admin-pass <pass>").option("--admin-user <user>"); },
  applyAdminPassFile() {},
  resolveHttpPort() { throw new Error("unexpected local port resolution"); },
  resolveOpsPort() { throw new Error("unexpected local ops port resolution"); },
  resolveOpsTarget,
  resolveOpsUrlFromTarget() { return "http://ops.invalid"; },
});
const program = new Command();
register(program);
try { await program.parseAsync(process.argv); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`;

/** Run the real backup command against `memories`; return the published file's bytes. */
async function backupBytes(memories: OwnedRow[]): Promise<Buffer> {
  return (await backupArtifact(memories)).bytes;
}

/** Run the real backup command against `memories`; return the published files. */
async function backupArtifact(memories: OwnedRow[]): Promise<{ output: string; bytes: Buffer; sidecar: string; stderr: string }> {
  const home = tempDir("flair-restore-seam-2664-");
  const output = join(home, "archive.json");
  const fixturePath = join(home, "fixture.json");
  const script = join(home, "run.ts");
  writeFileSync(fixturePath, JSON.stringify({ agents, memories, souls }));
  writeFileSync(script, CHILD);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const child = Bun.spawn([process.execPath, script, "backup", "--url", "http://backup.invalid", "--admin-pass", "test-pass", "--output", output], {
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      RESTORE_SEAM_FIXTURE: fixturePath,
      RESTORE_SEAM_COMMANDER: import.meta.resolve("commander"),
      RESTORE_SEAM_BACKUP: join(ROOT, "src/commands/backup.ts"),
      RESTORE_SEAM_CLI: join(ROOT, "src/cli.ts"),
    },
    stdout: "pipe",
    stderr: "pipe",
    // The child's own deadline, inside the case budget: a hung backup is
    // reported with its output instead of as a bare case timeout.
    timeout: 30_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`backup exited ${exitCode}: ${stdout}${stderr}`);
  expect(stderr).toContain("Backup complete");
  return { output, bytes: readFileSync(output), sidecar: readFileSync(`${output}.sha256`, "latin1"), stderr };
}

function kinds(result: ReturnType<typeof validateRestoreSelection>): Record<string, string> {
  if (!result.ok) throw new Error(`expected the selection to validate: ${JSON.stringify(result.failures)}`);
  return Object.fromEntries(result.entries.map((entry) => [entry.id, entry.kind]));
}

describe("the real flair backup output passes through the restore validator", () => {
  test("the sidecar beside the archive holds the SHA-256 of the file's exact bytes, and the restore preflight admits the pair", async () => {
    const { output, bytes, sidecar, stderr } = await backupArtifact([...stored, stale]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(sidecar).toBe(`${digest}  archive.json\n`);
    expect(stderr).toContain(`${digest} (${output}.sha256)`);
    const verified = readBackupArtifact(output);
    if (!verified.ok) throw new Error(`expected the published pair to verify: ${verified.reason}`);
    expect(verified.sha256).toBe(digest);
    expect(verified.archive).toEqual(JSON.parse(bytes.toString("utf8")));
  }, 60_000);

  const shasum = findChecksumTools().shasum;
  test.skipIf(shasum === undefined)("the real shasum -a 256 -c accepts the published pair and rejects a changed archive", async () => {
    const { output } = await backupArtifact([...stored, stale]);
    const intact = runChecksumTool(shasum!, dirname(output), "archive.json.sha256");
    expect(intact.status, intact.output).toBe(0);
    expect(intact.output).toContain("archive.json: OK");
    appendFileSync(output, "\n");
    const changed = runChecksumTool(shasum!, dirname(output), "archive.json.sha256");
    expect(changed.status, changed.output).not.toBe(0);
    expect(changed.output).toContain("FAILED");
  }, 60_000);

  test("served rows: the digest is the file's SHA-256 and each row keeps the verdict the archive carries", async () => {
    const served = [...stored, stale].map((row) => applyPromotionBinding(row));
    const bytes = await backupBytes(served);
    const result = parseRestoreArchive(bytes);
    if (!result.ok) throw new Error(`expected the backup file to parse: ${result.code} ${result.reason} at ${result.location}`);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.archive).toEqual(JSON.parse(bytes.toString("utf8")));
    expect(result.archive).toMatchObject({ version: 1, source: "http://backup.invalid", agents, souls });
    expect(result.archive.memories).toEqual(served);

    const archived = Object.fromEntries(result.archive.memories.map((row) => [row.id, row]));
    expect(archived["m-bound"]).toMatchObject({ promotionStatus: "approved", promotedBy: "kern", promotionContentHash: promotionContentHash(reviewed) });
    for (const id of ["m-legacy", "m-stale"]) {
      expect(archived[id]).toMatchObject({ promotionStatus: null, promotedAt: null, promotedBy: null, promotionContentHash: null });
    }

    expect(kinds(validateRestoreSelection(result.archive))).toEqual({
      "m-bound": "bound",
      "m-legacy": "unpromoted",
      "m-plain": "unpromoted",
      "m-stale": "unpromoted",
    });
  }, 60_000);

  test("unchanged rows: a verdict with no hash is legacy-unbound and a hash for other text refuses", async () => {
    const bytes = await backupBytes([...stored, stale]);
    const result = parseRestoreArchive(bytes);
    if (!result.ok) throw new Error(`expected the backup file to parse: ${result.code} ${result.reason} at ${result.location}`);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.archive.memories).toEqual([...stored, stale]);

    expect(kinds(validateRestoreSelection(result.archive, ["m-bound", "m-legacy", "m-plain"]))).toEqual({
      "m-bound": "bound",
      "m-legacy": "legacy-unbound",
      "m-plain": "unpromoted",
    });
    const whole = validateRestoreSelection(result.archive);
    expect(whole).toMatchObject({ ok: false, code: "entries-refused" });
    expect(whole.ok ? [] : whole.failures.map(({ id, code, field }) => ({ id, code, field }))).toEqual([
      { id: "m-stale", code: "binding-mismatch", field: "promotionContentHash" },
    ]);
  }, 60_000);
});
