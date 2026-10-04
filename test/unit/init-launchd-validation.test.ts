import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LEGACY_LAUNCHD_LABEL,
  launchdLabel,
  launchdPlistPath,
  type InitLaunchdOutcome,
  writeInitLaunchdPlist,
  type WriteInitLaunchdPlistOptions,
} from "../../src/cli.ts";
import { installFakeLaunchctl } from "../helpers/fake-launchctl.ts";
import { tempDir } from "../helpers/temp-dir.ts";

for (const failure of ["reported", "thrown", "unreadable"] as const) {
  test(`both init paths share the ${failure} validation refusal and framing`, async () => {
    const root = tempDir("flair-init-validation-");
    const dataDir = join(root, "data");
    const plistDir = join(root, "LaunchAgents");
    mkdirSync(dataDir);
    mkdirSync(plistDir);
    const harper = join(root, "harper.js");
    writeFileSync(harper, "");
    const write: WriteInitLaunchdPlistOptions = {
      dataDir,
      plistPath: launchdPlistPath(launchdLabel(dataDir), plistDir),
      label: launchdLabel(dataDir),
      adminPass: "PLACEHOLDER-test-pass",
      adminUser: "admin",
      modelsDir: join(dataDir, "models"),
      execPath: process.execPath,
      harperBinPath: harper,
      workingDirectory: resolve(import.meta.dirname, "../.."),
      httpPort: 9926,
      opsNetworkPort: "9925",
      setConfig: JSON.stringify({ rootPath: dataDir, http: { port: 9926 } }),
      port: 9926,
      adminPassPath: join(root, "admin-pass"),
      liveInstance: false,
    };
    expect((await writeInitLaunchdPlist(write)).kind).toBe("written");
    const prior = readFileSync(write.plistPath, "utf-8").replace("start-flair-with-admin-pass.sh", "prior-launcher.sh");
    writeFileSync(write.plistPath, prior);
    const mode = statSync(write.plistPath).mode & 0o7777;
    const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, plistDir);
    const fake = installFakeLaunchctl();
    writeFileSync(join(fake.fakeDir, "launchctl"), `#!/bin/sh
printf '%s\n' "$*" >> '${fake.logPath}' || exit 1
case "$1:$2" in
  __flair_fake_launchctl_probe_*:*) exit 0 ;;
  print:gui/*/*) echo 'Could not find service' >&2; exit 113 ;;
  print-disabled:*) echo 'disabled services = {'; echo '}'; exit 0 ;;
  print:gui/*) exit 0 ;;
esac
exit 1
`);
    writeFileSync(join(fake.fakeDir, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const path = `${fake.pathEntry}:${process.env.PATH ?? ""}`;
    fake.assertShadowed(path);
    writeFileSync(fake.logPath, "");
    const injected = "injected validation refusal";
    const driver = `
      import { readFileSync, rmSync, writeFileSync } from "node:fs";
      import { registerInitLaunchdService, setLaunchdMigrationLintForTests, validateInitPlistAfterWrite } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../src/cli.ts")).href)};
      const { write, dataDir, plistDir, legacyPath, prior, legacyLabel, failure, injected } = JSON.parse(process.argv[1]);
      let lintCalls = 0;
      setLaunchdMigrationLintForTests(() => {
        lintCalls++;
        if (failure === "thrown") throw new Error(injected);
        return injected;
      });
      const refusals = [];
      const validate = (opts) => {
        if (failure === "unreadable") rmSync(opts.plistPath);
        const refusal = validateInitPlistAfterWrite(opts);
        refusals.push(refusal);
        return refusal;
      };
      const runs = [];
      for (const legacy of [false, true]) {
        if (legacy) writeFileSync(legacyPath, prior.replaceAll(write.label, legacyLabel));
        const result = await registerInitLaunchdService({ dataDir, port: write.port, plistDir, write }, validate);
        runs.push({ result, calls: refusals.length, refusal: refusals.at(-1), content: readFileSync(write.plistPath, "utf-8") });
      }
      process.stdout.write(JSON.stringify({ runs, lintCalls }));
    `;
    try {
      const child = spawnSync(process.execPath, ["-e", driver, JSON.stringify({ write, dataDir, plistDir, legacyPath, prior, legacyLabel: LEGACY_LAUNCHD_LABEL, failure, injected })], {
        encoding: "utf-8", timeout: 30_000, env: { ...process.env, PATH: path },
      });
      expect(child.status, child.stderr).toBe(0);
      const { runs, lintCalls } = JSON.parse(child.stdout) as {
        runs: { result: InitLaunchdOutcome; calls: number; refusal: { why: string; fix: string }; content: string }[];
        lintCalls: number;
      };
      expect(runs).toHaveLength(2);
      for (const [index, { result, calls, refusal, content }] of runs.entries()) {
        const legacy = index === 1;
        expect(calls, JSON.stringify(result)).toBe(index + 1);
        expect(refusal).not.toBeNull();
        const installing = `the plist init would install for ${write.label}`;
        if (failure === "reported") {
          expect(refusal).toEqual({ why: `${installing} cannot be loaded (${injected})`, fix: "npm install -g @tpsdev-ai/flair && flair init" });
        } else if (failure === "thrown") {
          expect(refusal).toEqual({ why: `${installing} could not be validated (the lint failed: ${injected})`, fix: `make sure the temporary directory (${tmpdir()}) exists and is writable, and re-run 'flair init'.` });
        } else {
          expect(refusal!.why).toContain(`${installing} could not be validated (ENOENT:`);
          expect(refusal!.fix).toBe("resolve the error above, and re-run 'flair init'.");
        }
        const restored = `the prior plist bytes and mode at ${write.plistPath} were restored`;
        expect(result).toEqual({
          kind: "skipped",
          lines: [
            { stream: "err", text: legacy
              ? `⚠️  Launchd: not re-registered — ${refusal!.why}. Nothing was unloaded: the legacy job ${LEGACY_LAUNCHD_LABEL} and its plist at ${legacyPath} were left as they were, and ${restored}.`
              : `⚠️  Launchd: not registered — ${refusal!.why}. ${restored}.` },
            { stream: "err", text: `   Fix: ${refusal!.fix}` },
          ],
        });
        expect(content).toBe(prior);
        expect(statSync(write.plistPath).mode & 0o7777).toBe(mode);
      }
      expect(runs[0].refusal).toEqual(runs[1].refusal);
      expect(lintCalls).toBe(failure === "unreadable" ? 0 : 2);
      expect(fake.invocations()).toContain(`print gui/${process.getuid?.() ?? 0}/${LEGACY_LAUNCHD_LABEL}`);
      expect(fake.invocations().every((call) => /^(print|print-disabled) /.test(call))).toBe(true);
      fake.assertClear();
    } finally {
      fake.cleanup();
    }
  });
}
