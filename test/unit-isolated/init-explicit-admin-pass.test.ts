import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";
import { offlineDoctor } from "../helpers/offline-doctor.ts";
import { detectPersistedAdminUser, resolveInitAdminPasswordSource } from "../../src/lib/init-admin-pass.ts";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;
const sources = ["inline", "file", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD"] as const;
const password = "fixture-explicit-admin-password";

function runInit(home: string, dataDir: string, source: typeof sources[number], platform: string, foreignOwner = false) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|TPS_TEST_ROOT$|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const args = ["init", "--data-dir", dataDir, "--port", "9", "--ops-port", "8",
    "--skip-start", "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md"];
  if (source === "inline") args.push("--admin-pass", password);
  else if (source === "file") {
    const input = join(home, "input-pass");
    writeFileSync(input, password + "\n", { mode: 0o600 });
    args.push("--admin-pass-file", input);
  } else env[source] = password;
  const script = `
    Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
    globalThis.fetch = async () => { throw new Error("offline fixture"); };
    const { program } = await import(${JSON.stringify(CLI)});
    ${foreignOwner ? "const uid = process.getuid(); process.getuid = () => uid + 1;" : ""}
    await program.parseAsync(${JSON.stringify(args)}, { from: "user" });
  `;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: home, env, encoding: "utf8", timeout: 20_000,
  });
}

describe("fresh init persists explicit admin credentials", () => {
  test("fresh explicit credentials use the existing re-persist decision", () => {
    expect(resolveInitAdminPasswordSource(false, { explicitCredential: true })).toBe("re-persist");
    expect(resolveInitAdminPasswordSource(false)).toBe("generate-new");
    expect(resolveInitAdminPasswordSource(true, { explicitCredential: true })).toBe("reuse-existing");
    expect(resolveInitAdminPasswordSource(false, { explicitCredential: true, resetRequested: true })).toBe("rotate");
  });

  for (const platform of ["linux", "darwin"]) {
    for (const source of sources) {
      test(`${platform}: ${source} writes 0600 and doctor reports no desync`, () => {
        const home = tempDir("i-");
        const dataDir = tempDir("d-");
        const passPath = join(home, ".flair", "admin-pass");
        mkdirSync(join(home, ".flair"));
        symlinkSync(dataDir, join(home, ".flair", "data"));
        expect(detectPersistedAdminUser(dataDir)).toBe(false);
        const result = runInit(home, dataDir, source, platform);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(existsSync(passPath)).toBe(true);
        expect(readFileSync(passPath, "utf8")).toBe(password + "\n");
        expect(statSync(passPath).mode & 0o777).toBe(0o600);
        mkdirSync(join(dataDir, "system"));
        writeFileSync(join(dataDir, "system", "hdb_user.mdb"), "fixture-user");
        expect(realpathSync(join(home, ".flair", "data"))).toBe(realpathSync(dataDir));
        expect(detectPersistedAdminUser(dataDir)).toBe(true);
        const doctor = offlineDoctor(home, null);
        const output = doctor();
        expect(output).not.toContain("admin-pass file missing");
        expect(output).not.toContain("not assessing the admin-pass desync");
        rmSync(passPath);
        expect(doctor()).toContain("admin-pass file missing; Harper still has a persisted admin user");
      }, 60_000);
    }
  }

  for (const dangling of [false, true]) {
    test(`refuses a ${dangling ? "dangling " : ""}symlink destination`, () => {
      const home = tempDir("i-");
      const dataDir = tempDir("d-");
      const path = join(home, ".flair", "admin-pass");
      const target = join(home, "target");
      mkdirSync(join(home, ".flair"));
      if (!dangling) writeFileSync(target, "unchanged", { mode: 0o600 });
      symlinkSync(target, path);
      const result = runInit(home, dataDir, "inline", "linux");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("symbolic link");
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      if (!dangling) expect(readFileSync(target, "utf8")).toBe("unchanged");
      else expect(existsSync(target)).toBe(false);
    });
  }

  test("refuses a foreign-owned destination", () => {
    const home = tempDir("i-");
    const dataDir = tempDir("d-");
    const path = join(home, ".flair", "admin-pass");
    mkdirSync(join(home, ".flair"));
    writeFileSync(path, "unchanged", { mode: 0o600 });
    const result = runInit(home, dataDir, "inline", "linux", true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("owned by another user");
    expect(readFileSync(path, "utf8")).toBe("unchanged");
  });
});
