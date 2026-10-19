/**
 * backup-approval-store-2664.test.ts — flair#2664 slice 1c: the target host's
 * local approval store (src/lib/backup-approval-store.ts), on real files in a
 * temp root.
 *
 * Covered: modes and ownership (created exactly 0700/0600 under a zero
 * umask; a wider mode or another owner refuses, and an unsafe existing
 * directory, an invalid record or a changed stored copy refuses before any
 * missing directory is created); every entry is validated
 * (unknown names, dot files, symbolic links, temp files readable by others
 * refuse; a private temp file an interrupted approval left is ignored);
 * symbolic links and unsafe import paths; a stored copy changed, removed or
 * swapped for a link after approval, caught on use; invalid records;
 * revocation and re-approval; and approval that fails or is killed (SIGKILL)
 * before each step: a fresh approval killed before record publication leaves
 * no record, and a failed
 * re-approval of a revoked digest leaves it revoked.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  APPROVAL_PUBLISH_STEPS,
  ApprovalStoreError,
  approveArchive,
  listApprovals,
  loadApprovedArchive,
  readImportFile,
  revokeApproval,
  type ApprovalPublishStep,
} from "../../src/lib/backup-approval-store.ts";

const MODULE = join(import.meta.dir, "..", "..", "src", "lib", "backup-approval-store.ts");
const ARCHIVE = Buffer.from(JSON.stringify({
  version: 1, agents: [{ id: "flint" }], souls: [],
  memories: [{ id: "m1", agentId: "flint", content: "approved note", promotionStatus: "approved", promotedAt: "2026-10-01T00:00:00.000Z", promotedBy: "kern" }],
}));
const SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const NOW = "2026-10-19T00:00:00.000Z";

function store(): { root: string; archives: string; approvals: string } {
  const root = join(tempDir("flair-approval-store-2664-"), "approved-archives");
  return { root, archives: join(root, "archives"), approvals: join(root, "approvals") };
}

function approve(root: string, extra: Partial<Parameters<typeof approveArchive>[0]> = {}) {
  return approveArchive({ bytes: ARCHIVE, sha256: SHA, admission: "legacy", operator: "admin", archiveName: "old.json", now: NOW, ...extra }, { root });
}

function refusal(fn: () => unknown): ApprovalStoreError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalStoreError);
    return error as ApprovalStoreError;
  }
  throw new Error("expected a refusal");
}

const mode = (path: string): number => lstatSync(path).mode & 0o777;

describe("the approval store's layout, modes and ownership (#2664)", () => {
  test("approval creates the store 0700 and its files 0600, exactly, even under a zero umask", () => {
    const { root, archives, approvals } = store();
    const previous = process.umask(0);
    try {
      approve(root);
    } finally {
      process.umask(previous);
    }
    for (const dir of [root, archives, approvals]) expect(mode(dir)).toBe(0o700);
    expect(readdirSync(archives)).toEqual([`${SHA}.json`]);
    expect(readdirSync(approvals)).toEqual([`${SHA}.json`]);
    expect(mode(join(archives, `${SHA}.json`))).toBe(0o600);
    expect(mode(join(approvals, `${SHA}.json`))).toBe(0o600);
    expect(readFileSync(join(archives, `${SHA}.json`)).equals(ARCHIVE)).toBe(true);
    expect(JSON.parse(readFileSync(join(approvals, `${SHA}.json`), "utf8"))).toEqual({
      version: 1, sha256: SHA, admission: "legacy", approvedAt: NOW, approvedBy: "admin", archiveName: "old.json",
      size: ARCHIVE.length, revokedAt: null, revokedBy: null,
    });
  });

  test("an approval is loaded with its record and the archive parsed from the stored bytes", () => {
    const { root } = store();
    const record = approve(root);
    const loaded = loadApprovedArchive(SHA, { root });
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.record).toEqual(record);
    expect(loaded.archive.memories[0]).toMatchObject({ id: "m1", promotionStatus: "approved" });
  });

  for (const [label, target, wide] of [
    ["the store root", "root", 0o755],
    ["the approvals directory", "approvals", 0o750],
    ["the archives directory", "archives", 0o701],
  ] as const) {
    test(`${label} with mode ${wide.toString(8)} refuses approval, use and listing`, () => {
      const paths = store();
      approve(paths.root);
      chmodSync(paths[target], wide);
      for (const fn of [() => approve(paths.root), () => listApprovals({ root: paths.root }), () => revokeApproval(SHA, "admin", { root: paths.root })]) {
        const error = refusal(fn);
        expect(error.code).toBe("store-unsafe");
        expect(error.message).toContain(`${paths[target]} has mode ${wide.toString(8)}, not 700`);
      }
      expect(loadApprovedArchive(SHA, { root: paths.root })).toMatchObject({ ok: false, code: "store-unsafe" });
      chmodSync(paths[target], 0o700);
    });
  }

  for (const [label, file] of [["a record", "approvals"], ["a stored archive", "archives"]] as const) {
    test(`${label} with mode 644 refuses use`, () => {
      const paths = store();
      approve(paths.root);
      chmodSync(join(paths[file], `${SHA}.json`), 0o644);
      const loaded = loadApprovedArchive(SHA, { root: paths.root });
      expect(loaded).toMatchObject({ ok: false, code: "store-unsafe" });
      expect(loaded.ok ? "" : loaded.reason).toContain("has mode 644, not 600");
    });
  }

  test("a store owned by another user refuses", () => {
    const { root } = store();
    approve(root);
    const other = statSync(root).uid + 1;
    const foreign = refusal(() => listApprovals({ root, uid: other }));
    expect(foreign.code).toBe("store-unsafe");
    expect(foreign.message).toContain(`is owned by uid ${statSync(root).uid}, not the current user (uid ${other})`);
    expect(loadApprovedArchive(SHA, { root, uid: other })).toMatchObject({ ok: false, code: "store-unsafe" });
  });

  test("an unsafe existing directory refuses before a missing sibling is created", () => {
    const { root, archives, approvals } = store();
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    mkdirSync(approvals, { mode: 0o700 });
    chmodSync(approvals, 0o750);
    const error = refusal(() => approve(root));
    expect(error.message).toContain(`${approvals} has mode 750, not 700`);
    expect(existsSync(archives)).toBe(false);
    expect(readdirSync(root)).toEqual(["approvals"]);
  });

  test("an invalid record refuses approval before the missing archives directory is created", () => {
    const { root, archives, approvals } = store();
    for (const dir of [root, approvals]) { mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700); }
    writeFileSync(join(approvals, `${SHA}.json`), "{ not a record", { mode: 0o600 });
    chmodSync(join(approvals, `${SHA}.json`), 0o600);
    expect(refusal(() => approve(root)).code).toBe("record-invalid");
    expect(existsSync(archives)).toBe(false);
    expect(readdirSync(root)).toEqual(["approvals"]);
  });

  test("a stored copy that no longer hashes to its name refuses approval before the missing approvals directory is created", () => {
    const { root, archives, approvals } = store();
    for (const dir of [root, archives]) { mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700); }
    writeFileSync(join(archives, `${SHA}.json`), "other bytes", { mode: 0o600 });
    chmodSync(join(archives, `${SHA}.json`), 0o600);
    expect(refusal(() => approve(root)).code).toBe("stored-mismatch");
    expect(existsSync(approvals)).toBe(false);
    expect(readdirSync(root)).toEqual(["archives"]);
  });

  for (const [label, place, make] of [
    ["an unknown entry in the root", "root", (dir: string) => writeFileSync(join(dir, "notes.txt"), "x", { mode: 0o600 })],
    ["an unknown entry among the records", "approvals", (dir: string) => writeFileSync(join(dir, "extra.json"), "{}", { mode: 0o600 })],
    ["a dot file among the archives", "archives", (dir: string) => writeFileSync(join(dir, ".DS_Store"), "x", { mode: 0o600 })],
    ["a temp-named symbolic link among the records", "approvals", (dir: string) => symlinkSync("/etc/hosts", join(dir, `.${"a".repeat(64)}.1.deadbeef.tmp`))],
    ["a temp file readable by others", "archives", (dir: string) => { const p = join(dir, `.${"b".repeat(64)}.2.cafebabe.tmp`); writeFileSync(p, "x"); chmodSync(p, 0o644); }],
    ["a record-named directory", "approvals", (dir: string) => mkdirSync(join(dir, `${"c".repeat(64)}.json`))],
  ] as const) {
    test(`${label} refuses every operation`, () => {
      const paths = store();
      approve(paths.root);
      make(paths[place]);
      for (const fn of [() => approve(paths.root), () => listApprovals({ root: paths.root }), () => revokeApproval(SHA, "admin", { root: paths.root })]) {
        expect(refusal(fn).code).toBe("store-unsafe");
      }
      expect(loadApprovedArchive(SHA, { root: paths.root })).toMatchObject({ ok: false, code: "store-unsafe" });
    });
  }

  test("a private temp file an interrupted approval left is ignored", () => {
    const paths = store();
    approve(paths.root);
    const leftover = join(paths.archives, `.${SHA}.12345.0badf00d.tmp`);
    writeFileSync(leftover, "partial", { mode: 0o600 });
    chmodSync(leftover, 0o600);
    expect(listApprovals({ root: paths.root }).map((entry) => entry.record.sha256)).toEqual([SHA]);
    expect(loadApprovedArchive(SHA, { root: paths.root })).toMatchObject({ ok: true });
  });

  test("listing or using a store that does not exist creates nothing", () => {
    const { root } = store();
    expect(listApprovals({ root })).toEqual([]);
    expect(loadApprovedArchive(SHA, { root })).toMatchObject({ ok: false, code: "not-approved" });
    expect(existsSync(root)).toBe(false);
  });
});

describe("symbolic links and unsafe paths (#2664)", () => {
  test("a store root that is a symbolic link refuses", () => {
    const { root } = store();
    const real = join(tempDir("flair-approval-real-2664-"), "real-store");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, root);
    expect(refusal(() => approve(root)).message).toContain(`approval store directory ${root} is a symbolic link`);
    expect(loadApprovedArchive(SHA, { root })).toMatchObject({ ok: false, code: "store-unsafe" });
  });

  test("an approvals directory swapped for a symbolic link refuses", () => {
    const paths = store();
    approve(paths.root);
    const elsewhere = join(tempDir("flair-approval-real-2664-"), "approvals");
    renameSync(paths.approvals, elsewhere);
    symlinkSync(elsewhere, paths.approvals);
    expect(refusal(() => listApprovals({ root: paths.root })).message).toContain("is a symbolic link");
    expect(loadApprovedArchive(SHA, { root: paths.root })).toMatchObject({ ok: false, code: "store-unsafe" });
  });

  test("a stored archive swapped for a symbolic link to identical bytes refuses on use", () => {
    const paths = store();
    approve(paths.root);
    const copy = join(tempDir("flair-approval-real-2664-"), "copy.json");
    writeFileSync(copy, ARCHIVE, { mode: 0o600 });
    const stored = join(paths.archives, `${SHA}.json`);
    renameSync(stored, join(tempDir("flair-approval-real-2664-"), "original.json"));
    symlinkSync(copy, stored);
    const loaded = loadApprovedArchive(SHA, { root: paths.root });
    expect(loaded).toMatchObject({ ok: false, code: "store-unsafe" });
    expect(loaded.ok ? "" : loaded.reason).toContain(`approval store file ${stored} is a symbolic link`);
  });

  test("an import refuses a symbolic link to a valid archive", () => {
    const dir = tempDir("flair-approval-import-2664-");
    writeFileSync(join(dir, "real.json"), ARCHIVE);
    symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
    const error = refusal(() => readImportFile(join(dir, "link.json"), "archive", { root: store().root }));
    expect(error.code).toBe("import-unsafe");
    expect(error.message).toContain(`refusing to import archive ${join(dir, "link.json")} is a symbolic link`);
    expect(readImportFile(join(dir, "real.json"), "archive", { root: store().root }).equals(ARCHIVE)).toBe(true);
  });

  test("an import refuses a directory and a named pipe without blocking", () => {
    const dir = tempDir("flair-approval-import-2664-");
    mkdirSync(join(dir, "folder.json"));
    expect(refusal(() => readImportFile(join(dir, "folder.json"), "archive")).message).toContain("it is not a regular file");
    const fifo = join(dir, "pipe.json");
    const made = spawnSync("mkfifo", [fifo]);
    expect(made.status, "mkfifo must create the pipe").toBe(0);
    expect(refusal(() => readImportFile(fifo, "archive")).message).toContain("it is not a regular file");
  });

  test("an import refuses a file inside the store", () => {
    const paths = store();
    approve(paths.root);
    const inside = join(paths.archives, `${SHA}.json`);
    const error = refusal(() => readImportFile(inside, "archive", { root: paths.root }));
    expect(error.code).toBe("import-unsafe");
    expect(error.message).toContain("it is inside the approval store");
  });
});

describe("tampering, records and revocation (#2664)", () => {
  test("a stored copy changed after approval is caught on use", () => {
    const paths = store();
    approve(paths.root);
    const stored = join(paths.archives, `${SHA}.json`);
    const changed = Buffer.from(ARCHIVE.toString().replace("approved note", "altered note"));
    writeFileSync(stored, changed, { mode: 0o600 });
    chmodSync(stored, 0o600);
    const loaded = loadApprovedArchive(SHA, { root: paths.root });
    expect(loaded).toMatchObject({ ok: false, code: "stored-mismatch" });
    expect(loaded.ok ? "" : loaded.reason).toContain(`no longer hashes to ${SHA}`);
    expect(listApprovals({ root: paths.root }).map((entry) => entry.stored)).toEqual(["does-not-match"]);
    // A changed copy is never reused: approving the archive again refuses.
    expect(refusal(() => approve(paths.root)).code).toBe("stored-mismatch");
  });

  test("a stored copy removed after approval is caught on use", () => {
    const paths = store();
    approve(paths.root);
    renameSync(join(paths.archives, `${SHA}.json`), join(tempDir("flair-approval-real-2664-"), "gone.json"));
    expect(loadApprovedArchive(SHA, { root: paths.root })).toMatchObject({ ok: false, code: "stored-missing" });
    expect(listApprovals({ root: paths.root }).map((entry) => entry.stored)).toEqual(["missing"]);
  });

  for (const [label, edit] of [
    ["an extra field", (r: Record<string, unknown>) => ({ ...r, trusted: true })],
    ["a sha256 that does not match its file name", (r: Record<string, unknown>) => ({ ...r, sha256: "0".repeat(64) })],
    ["an unknown admission", (r: Record<string, unknown>) => ({ ...r, admission: "auto" })],
    ["no operator", (r: Record<string, unknown>) => ({ ...r, approvedBy: "" })],
    ["a half-set revocation", (r: Record<string, unknown>) => ({ ...r, revokedAt: NOW })],
  ] as const) {
    test(`a record with ${label} refuses on use`, () => {
      const paths = store();
      approve(paths.root);
      const path = join(paths.approvals, `${SHA}.json`);
      writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, "utf8")))));
      expect(loadApprovedArchive(SHA, { root: paths.root })).toMatchObject({ ok: false, code: "record-invalid" });
    });
  }

  test("a record with a repeated key refuses on use", () => {
    const paths = store();
    approve(paths.root);
    const path = join(paths.approvals, `${SHA}.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace('"revokedBy": null', '"revokedBy": null, "revokedBy": null'));
    expect(loadApprovedArchive(SHA, { root: paths.root })).toMatchObject({ ok: false, code: "record-invalid" });
  });

  test("revocation refuses use, is listed, cannot repeat, and a new approval replaces it", () => {
    const paths = store();
    approve(paths.root);
    const revoked = revokeApproval(SHA, "operator-b", { root: paths.root }, "2026-10-20T00:00:00.000Z");
    expect(revoked).toMatchObject({ revokedAt: "2026-10-20T00:00:00.000Z", revokedBy: "operator-b" });
    const loaded = loadApprovedArchive(SHA, { root: paths.root });
    expect(loaded).toMatchObject({ ok: false, code: "revoked" });
    expect(loaded.ok ? "" : loaded.reason).toContain("was revoked at 2026-10-20T00:00:00.000Z by operator-b");
    expect(listApprovals({ root: paths.root })).toMatchObject([{ record: { revokedBy: "operator-b" }, stored: "intact" }]);
    expect(refusal(() => revokeApproval(SHA, "admin", { root: paths.root })).code).toBe("already-revoked");
    approve(paths.root, { now: "2026-10-21T00:00:00.000Z" });
    expect(loadApprovedArchive(SHA, { root: paths.root })).toMatchObject({ ok: true, record: { approvedAt: "2026-10-21T00:00:00.000Z", revokedAt: null } });
  });

  test("revoking a digest with no approval refuses", () => {
    const { root } = store();
    approve(root);
    expect(refusal(() => revokeApproval("f".repeat(64), "admin", { root })).code).toBe("not-approved");
    expect(refusal(() => revokeApproval("not-a-digest", "admin", { root })).code).toBe("invalid-digest");
  });

  test("approval refuses bytes that do not hash to the digest, and stores nothing", () => {
    const { root } = store();
    expect(refusal(() => approve(root, { sha256: "0".repeat(64) })).code).toBe("stored-mismatch");
    expect(existsSync(root)).toBe(false);
  });
});

describe("approval that fails or is killed part-way leaves no approved record (#2664)", () => {
  const recordPath = (root: string) => join(root, "approvals", `${SHA}.json`);
  const temps = (root: string) => ["archives", "approvals"].flatMap((dir) =>
    existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((name) => name.endsWith(".tmp")) : []);

  for (const step of APPROVAL_PUBLISH_STEPS) {
    test(`a failure at ${step} leaves no approved record and no temp file`, () => {
      const { root } = store();
      expect(() => approveArchive(
        { bytes: ARCHIVE, sha256: SHA, admission: "legacy", operator: "admin", archiveName: "old.json" },
        { root },
        { beforeStep: (current: ApprovalPublishStep) => { if (current === step) throw new Error(`injected ${step} failure`); } },
      )).toThrow(`injected ${step} failure`);
      expect(existsSync(recordPath(root))).toBe(false);
      expect(loadApprovedArchive(SHA, { root })).toMatchObject({ ok: false, code: "not-approved" });
      expect(temps(root)).toEqual([]);
    });

  }

  test("re-approving a digest whose stored copy is intact reuses the copy: the archive is not staged again", () => {
    const { root } = store();
    approve(root);
    const steps: string[] = [];
    approveArchive({ bytes: ARCHIVE, sha256: SHA, admission: "legacy", operator: "admin", archiveName: "old.json" }, { root }, {
      beforeStep: (step) => { steps.push(step); },
    });
    expect(steps).toEqual(["open-store", "verify-archive", "stage-record", "publish-record"]);
  });

  for (const step of ["open-store", "verify-archive", "stage-record", "publish-record"] as const) {
    test(`a failure at ${step} while re-approving a revoked digest leaves it revoked`, () => {
      const { root } = store();
      approve(root);
      revokeApproval(SHA, "admin", { root }, "2026-10-20T00:00:00.000Z");
      expect(() => approveArchive(
        { bytes: ARCHIVE, sha256: SHA, admission: "legacy", operator: "admin", archiveName: "old.json" },
        { root },
        { beforeStep: (current: ApprovalPublishStep) => { if (current === step) throw new Error(`injected ${step} failure`); } },
      )).toThrow(`injected ${step} failure`);
      expect(loadApprovedArchive(SHA, { root })).toMatchObject({ ok: false, code: "revoked" });
    });
  }

  for (const step of APPROVAL_PUBLISH_STEPS) {
    test(`a crash (SIGKILL) at ${step} leaves no approved record`, async () => {
      const { root } = store();
      const dir = tempDir("flair-approval-crash-2664-");
      const script = join(dir, "crash.ts");
      writeFileSync(join(dir, "archive.json"), ARCHIVE);
      writeFileSync(script, `
import { readFileSync } from "node:fs";
import { approveArchive } from ${JSON.stringify(MODULE)};
const [root, archive, sha256, crashStep] = process.argv.slice(2);
approveArchive({ bytes: readFileSync(archive), sha256, admission: "legacy", operator: "admin", archiveName: "old.json" }, { root }, {
  beforeStep(step) { if (step === crashStep) process.kill(process.pid, "SIGKILL"); },
});
console.log("approved");
`);
      const child = Bun.spawn([process.execPath, script, root, join(dir, "archive.json"), SHA, step], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(child.signalCode).toBe("SIGKILL");
      expect(stdout).not.toContain("approved");
      expect(existsSync(recordPath(root))).toBe(false);
      expect(loadApprovedArchive(SHA, { root })).toMatchObject({ ok: false, code: "not-approved" });
      // A later approval completes and is usable.
      approve(root);
      expect(loadApprovedArchive(SHA, { root })).toMatchObject({ ok: true });
    }, 60_000);
  }
});
