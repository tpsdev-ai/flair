import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeBin } from "../helpers/node-runtime";

const CLI = join(import.meta.dirname, "../../dist/cli.js");
const AMBIENT = "ambient-admin-pass-809";

async function runCli(args: string[], paused = false) {
  const home = mkdtempSync(join(tmpdir(), "flair-rem-empty-809-"));
  try {
    mkdirSync(join(home, ".flair"));
    mkdirSync(join(home, "empty-bin"));
    writeFileSync(join(home, ".flair", "admin-pass"), "local-admin-pass-809", { mode: 0o600 });
    if (paused) writeFileSync(join(home, ".flair", "rem.paused"), "paused\n");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
    const proc = Bun.spawn([nodeBin(), CLI, "rem", "nightly", ...args], {
      env: { ...env, HOME: home, USERPROFILE: home, PATH: join(home, "empty-bin"), FLAIR_ADMIN_PASS: AMBIENT },
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { text: stdout + stderr, exitCode, shimExists: existsSync(join(home, ".flair", "bin", "flair-rem-nightly")) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const mode of ["normal", "paused", "dry-run"]) {
  test(`packaged run-once refuses an empty file option on the ${mode} path with ambient admin credentials`, async () => {
    const args = ["run-once", "--agent", "empty-file-809", "--admin-pass-file", ""];
    if (mode === "dry-run") args.push("--dry-run");
    const { text, exitCode } = await runCli(args, mode === "paused");
    expect(exitCode, text).not.toBe(0);
    expect(text).toContain("Error: --admin-pass-file must not be empty");
    expect(text).toContain("Dedup:      NOT RUN —");
    expect(text).toContain("Provide an owner-only (chmod 600), non-empty admin password file");
    expect(text).toContain("via --admin-pass-file <path>");
    expect(text).not.toContain("Status:");
    expect(text).not.toContain(AMBIENT);
    expect(text).not.toContain("local-admin-pass-809");
  }, 20_000);
}

test("packaged run-once refuses an empty file option combined with --admin-pass as a conflict", async () => {
  const { text, exitCode } = await runCli(["run-once", "--agent", "empty-file-809", "--admin-pass-file", "", "--admin-pass", "x"]);
  expect(exitCode, text).not.toBe(0);
  expect(text).toContain("--admin-pass and --admin-pass-file cannot be combined");
  expect(text).toContain("Dedup:      NOT RUN —");
  expect(text).not.toContain("must not be empty");
  expect(text).not.toContain(AMBIENT);
}, 20_000);

test("packaged enable refuses an empty file override before installing a shim", async () => {
  const { text, exitCode, shimExists } = await runCli(["enable", "--agent", "empty-file-809", "--admin-pass-file", ""]);
  expect(exitCode, text).not.toBe(0);
  expect(text).toContain("Error: --admin-pass-file must not be empty");
  expect(shimExists).toBe(false);
  expect(text).not.toContain(AMBIENT);
}, 20_000);
