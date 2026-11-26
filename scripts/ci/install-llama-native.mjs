#!/usr/bin/env node
// Keep version lookup, validation and installation in one process (flair#3133).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCKFILE, SEMVER, readLlamaNativeVersion } from "./llama-native-version.mjs";
import { readLlamaInstalledPackage } from "./llama-installed-version.mjs";

export function installLlamaNative(args, {
  runner = spawnSync,
  cwd = process.cwd(),
  lockfile = LOCKFILE,
  log = message => process.stdout.write(`${message}\n`),
} = {}) {
  try {
    let installed;
    let platform = "linux-x64";
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag !== "--installed" && flag !== "--platform") throw new Error(`unknown flag ${flag}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
      if (flag === "--installed") installed = resolve(cwd, value);
      else platform = value;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(platform)) throw new Error(`invalid platform "${platform}"`);
    const { version, source } = installed
      ? readLlamaInstalledPackage(installed, `@node-llama-cpp/${platform}`)
      : { version: readLlamaNativeVersion(readFileSync(lockfile, "utf8")), source: lockfile };
    if (!SEMVER.test(version)) throw new Error(`version "${version}" is not x.y.z`);
    const command = installed ? "npm" : "bun";
    const argv = [installed ? "install" : "add", "--no-save", `@node-llama-cpp/${platform}@${version}`];
    const options = { cwd: installed ?? cwd, shell: false, stdio: "inherit" };
    log(`llama-native-install: version ${version}; source ${source}`);
    log(`llama-native-install: command ${[command, ...argv].map(word => JSON.stringify(word)).join(" ")}; cwd ${options.cwd}`);
    const result = runner(command, argv, options);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} install failed: ${result.signal ?? `exit ${result.status}`}`);
    return { version, source, command, argv, cwd: options.cwd };
  } catch (error) {
    throw new Error(`install-llama-native: ${error?.message ?? error}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    installLlamaNative(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
