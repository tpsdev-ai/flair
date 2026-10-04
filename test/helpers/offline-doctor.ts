import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Exercise the source CLI with no ambient credentials, executables or fetch. */
export function offlineDoctor(home: string, agent: string | null = "fixture"): (args?: string[], observe?: (result: { status: number | null }) => void) => string {
  const bin = join(home, "bin");
  mkdirSync(bin);
  // Neither harness is detectable on PATH; config presence alone opts it in.
  for (const name of ["lsof", "npm", "npx"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  symlinkSync("/bin/sh", join(bin, "sh"));
  const offline = join(home, "offline.cjs");
  writeFileSync(offline, "globalThis.fetch = async () => { throw new Error('offline fixture'); };\n");
  return (args = [], observe) => {
    const result = spawnSync(process.execPath, ["--preload", offline, join(import.meta.dir, "../../src/cli.ts"),
      "doctor", "--port", "9", ...(agent === null ? [] : ["--agent", agent]), ...args], {
      cwd: home,
      encoding: "utf8",
      timeout: 20_000,
      env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, TMPDIR: home, PATH: bin, NO_COLOR: "1" },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect([0, 1]).toContain(result.status ?? -1);
    observe?.(result);
    return result.stdout;
  };
}
