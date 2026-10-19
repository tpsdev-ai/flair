/**
 * backup-approval-cli-2664.test.ts — flair#2664 slice 1c: `flair
 * backup-approval approve | legacy-admit | list | revoke`
 * (src/commands/backup-approval.ts).
 *
 * Each case runs the command module in a child process with HOME pointed at
 * a temp directory, so the approval store is `<HOME>/.flair/approved-archives`.
 * `fetch` is replaced by a recorder that answers the operations API's
 * `user_info` as the case says (a super_user by default), so operator
 * credential verification is exercised without a server. Every refusal is
 * checked for leaving no approval record.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { loadApprovedArchive } from "../../src/lib/backup-approval-store.ts";

const commandPath = join(import.meta.dirname, "../../src/commands/backup-approval.ts");
const commanderPath = join(import.meta.dirname, "../../node_modules/commander/index.js");

const ARCHIVE = Buffer.from(JSON.stringify({
  version: 1, agents: [{ id: "flint" }], souls: [],
  memories: [{ id: "m1", agentId: "flint", content: "legacy note", promotionStatus: "approved", promotedAt: "2026-01-01T00:00:00.000Z", promotedBy: "kern" }],
}));
const SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const SUPER_USER = { status: 200, body: { username: "operator-x", role: { role: "super_user", permission: { super_user: true } } } };

type OpsReply = { status: number; body: unknown };
type Call = { url: string; method: string; body?: string; auth?: string };

/** A work directory holding `archive.json`, and a sidecar unless `sidecar` is null. */
function workDir(sidecar: string | null = `${SHA}  archive.json\n`): { dir: string; archive: string } {
  const dir = tempDir("flair-approval-cli-work-2664-");
  writeFileSync(join(dir, "archive.json"), ARCHIVE);
  if (sidecar !== null) writeFileSync(join(dir, "archive.json.sha256"), sidecar);
  return { dir, archive: join(dir, "archive.json") };
}

async function cli(args: string[], options: { home?: string; ops?: OpsReply } = {}) {
  const home = options.home ?? tempDir("flair-approval-cli-home-2664-");
  const scratch = tempDir("flair-approval-cli-driver-2664-");
  const callsPath = join(scratch, "calls.json");
  const driver = join(scratch, "driver.ts");
  writeFileSync(driver, `
    import { Command } from ${JSON.stringify(commanderPath)};
    import { bindCli, register } from ${JSON.stringify(commandPath)};
    import { writeFileSync } from "node:fs";
    const ops = ${JSON.stringify(options.ops ?? SUPER_USER)};
    const calls = [];
    writeFileSync(${JSON.stringify(callsPath)}, "[]");
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET", body: init.body, auth: init.headers?.Authorization });
      writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
      return new Response(JSON.stringify(ops.body), { status: ops.status, headers: { "Content-Type": "application/json" } });
    };
    bindCli({
      addSharedCredentialOptions(command) { return command.option("--admin-pass <pass>").option("--admin-pass-file <path>").option("--admin-user <user>"); },
      applyAdminPassFile() {},
      resolveHttpPort() { return 19926; },
      resolveOpsPort() { return 19925; },
    });
    const program = new Command();
    register(program);
    await program.parseAsync(${JSON.stringify(args)}, { from: "user" });
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const child = Bun.spawn([process.execPath, driver], { env: { ...env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const calls: Call[] = JSON.parse(readFileSync(callsPath, "utf8"));
  const root = join(home, ".flair", "approved-archives");
  return { home, root, stdout, stderr, exitCode, calls };
}

type Result = Awaited<ReturnType<typeof cli>>;

function approvalRecords(root: string): string[] {
  return existsSync(join(root, "approvals")) ? readdirSync(join(root, "approvals")).filter((name) => !name.startsWith(".")) : [];
}

function refusedWithoutRecord(result: Result, ...fragments: string[]): void {
  expect(result.exitCode).not.toBe(0);
  expect(approvalRecords(result.root)).toEqual([]);
  for (const fragment of fragments) expect(result.stderr).toContain(fragment);
}

const CREDS = ["--admin-pass", "operator-pass"];

describe("flair backup-approval approve (#2664)", () => {
  test("approves a sidecar-backed archive after verifying the operator credentials, and records the verified operator", async () => {
    const { archive } = workDir();
    const result = await cli(["backup-approval", "approve", archive, ...CREDS]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Approved ${archive} on this host`);
    expect(result.calls).toEqual([{
      url: "http://127.0.0.1:19925/", method: "POST", body: JSON.stringify({ operation: "user_info" }),
      auth: `Basic ${Buffer.from("admin:operator-pass").toString("base64")}`,
    }]);
    expect(loadApprovedArchive(SHA, { root: result.root })).toMatchObject({
      ok: true, record: { admission: "sidecar", approvedBy: "operator-x", archiveName: "archive.json", revokedAt: null },
    });
  });

  test("an archive with no sidecar is refused, naming legacy-admit, before any credential check", async () => {
    const { archive } = workDir(null);
    const result = await cli(["backup-approval", "approve", archive, ...CREDS]);
    refusedWithoutRecord(result, `archive digest sidecar ${archive}.sha256 not found; nothing was approved`,
      `flair backup-approval legacy-admit ${archive}`);
    expect(result.calls).toEqual([]);
  });

  test("a sidecar for other bytes is refused", async () => {
    const { archive } = workDir(`${"0".repeat(64)}  archive.json\n`);
    const result = await cli(["backup-approval", "approve", archive, ...CREDS]);
    refusedWithoutRecord(result, "does not match its digest sidecar", "nothing was approved");
    expect(result.calls).toEqual([]);
  });

  test("an archive path that is a symbolic link is refused", async () => {
    const { dir, archive } = workDir();
    symlinkSync(archive, join(dir, "link.json"));
    writeFileSync(join(dir, "link.json.sha256"), `${SHA}  link.json\n`);
    const result = await cli(["backup-approval", "approve", join(dir, "link.json"), ...CREDS]);
    refusedWithoutRecord(result, `refusing to import archive ${join(dir, "link.json")} is a symbolic link`);
  });

  for (const [label, args, ops, fragment] of [
    ["no credentials", [], SUPER_USER, "approval needs operator credentials"],
    ["refused credentials", CREDS, { status: 401, body: { error: "unauthorized" } }, "the operator credentials were refused by this host's operations API (HTTP 401)"],
    ["credentials that are not a super_user", CREDS, { status: 200, body: { username: "reader", role: { permission: { super_user: false } } } }, "are not a super_user on this host"],
  ] as const) {
    test(`${label} are refused and nothing is approved`, async () => {
      const { archive } = workDir();
      const result = await cli(["backup-approval", "approve", archive, ...args], { ops });
      refusedWithoutRecord(result, fragment, "nothing was approved");
      expect(result.stderr).not.toContain("operator-pass");
      expect(existsSync(result.root)).toBe(false);
    });
  }
});

describe("flair backup-approval legacy-admit (#2664)", () => {
  test("without --confirm-digest it prints the digest, approves nothing, and checks no credentials", async () => {
    const { archive } = workDir(null);
    const result = await cli(["backup-approval", "legacy-admit", archive, ...CREDS]);
    refusedWithoutRecord(result, "legacy admission needs you to confirm the digest above; nothing was approved",
      `flair backup-approval legacy-admit ${archive} --confirm-digest ${SHA}`);
    expect(result.stdout).toContain(SHA);
    expect(result.stdout).toContain("does not show where they came from or that they are unchanged since the backup");
    expect(result.calls).toEqual([]);
    expect(existsSync(result.root)).toBe(false);
  });

  test("a --confirm-digest that is not the archive's digest is refused", async () => {
    const { archive } = workDir(null);
    for (const wrong of ["f".repeat(64), SHA.toUpperCase(), SHA.slice(0, 63)]) {
      const result = await cli(["backup-approval", "legacy-admit", archive, "--confirm-digest", wrong, ...CREDS]);
      refusedWithoutRecord(result, `--confirm-digest does not match the archive's SHA-256 ${SHA}; nothing was approved`);
      expect(result.calls).toEqual([]);
    }
  });

  test("with the confirmed digest and operator credentials it stores the bytes and records a legacy approval", async () => {
    const { archive } = workDir(null);
    const result = await cli(["backup-approval", "legacy-admit", archive, "--confirm-digest", SHA, ...CREDS]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.calls).toHaveLength(1);
    const loaded = loadApprovedArchive(SHA, { root: result.root });
    expect(loaded).toMatchObject({ ok: true, record: { admission: "legacy", approvedBy: "operator-x", size: ARCHIVE.length } });
    expect(readFileSync(join(result.root, "archives", `${SHA}.json`)).equals(ARCHIVE)).toBe(true);
  });

  test("the confirmed digest still needs operator credentials", async () => {
    const { archive } = workDir(null);
    const result = await cli(["backup-approval", "legacy-admit", archive, "--confirm-digest", SHA, ...CREDS], { ops: { status: 403, body: {} } });
    refusedWithoutRecord(result, "the operator credentials were refused", "nothing was approved");
  });

  test("an archive that has a sidecar is refused, naming approve", async () => {
    const { archive } = workDir();
    const result = await cli(["backup-approval", "legacy-admit", archive, "--confirm-digest", SHA, ...CREDS]);
    refusedWithoutRecord(result, "so it is not a legacy archive; nothing was approved", `flair backup-approval approve ${archive}`);
  });

  test("an archive path that is a symbolic link is refused", async () => {
    const { dir, archive } = workDir(null);
    symlinkSync(archive, join(dir, "link.json"));
    const result = await cli(["backup-approval", "legacy-admit", join(dir, "link.json"), "--confirm-digest", SHA, ...CREDS]);
    refusedWithoutRecord(result, "is a symbolic link");
  });

  test("an archive restore could not parse is refused", async () => {
    const dir = tempDir("flair-approval-cli-work-2664-");
    writeFileSync(join(dir, "broken.json"), '{"version":1,"version":1}');
    const result = await cli(["backup-approval", "legacy-admit", join(dir, "broken.json"), ...CREDS]);
    refusedWithoutRecord(result, "is not a restorable archive", "duplicate-key");
  });
});

describe("flair backup-approval list and revoke (#2664)", () => {
  test("list shows approvals; revoke needs operator credentials and marks the approval revoked", async () => {
    const { archive } = workDir(null);
    const approved = await cli(["backup-approval", "legacy-admit", archive, "--confirm-digest", SHA, ...CREDS]);
    expect(approved.exitCode).toBe(0);
    const home = approved.home;

    const listed = await cli(["backup-approval", "list"], { home });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toMatch(new RegExp(`${SHA}  approved  legacy  approved \\S+ by operator-x  archive\\.json  stored copy intact`));
    expect(listed.calls).toEqual([]);

    const uncredentialed = await cli(["backup-approval", "revoke", SHA], { home });
    expect(uncredentialed.exitCode).not.toBe(0);
    expect(uncredentialed.stderr).toContain("revocation needs operator credentials");
    expect(uncredentialed.stderr).toContain("nothing was revoked");
    expect(loadApprovedArchive(SHA, { root: approved.root })).toMatchObject({ ok: true });

    const revoked = await cli(["backup-approval", "revoke", SHA, ...CREDS], { home });
    expect(revoked.exitCode).toBe(0);
    expect(revoked.stdout).toContain(`Revoked the approval of ${SHA} on this host`);
    expect(loadApprovedArchive(SHA, { root: approved.root })).toMatchObject({ ok: false, code: "revoked", record: { revokedBy: "operator-x" } });

    const again = await cli(["backup-approval", "revoke", SHA, ...CREDS], { home });
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr).toContain("was already revoked");
    expect(again.stderr).toContain("nothing was revoked");

    const relisted = await cli(["backup-approval", "list"], { home });
    expect(relisted.stdout).toContain(`${SHA}  revoked `);
  });

  test("list on a host with no store says so and creates nothing", async () => {
    const result = await cli(["backup-approval", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No archive approvals on this host");
    expect(existsSync(join(result.home, ".flair"))).toBe(false);
  });
});
