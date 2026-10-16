import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function nodeBin({ env = process.env, cwd = process.cwd() }: { env?: NodeJS.ProcessEnv; cwd?: string | URL } = {}): string {
  const executable = env.NODE_BIN?.trim() || (process.versions.bun ? "node" : process.execPath);
  const probe = (command: string, expression: string) => execFileSync(command, ["-p", expression], {
    env, cwd,
    encoding: "utf8",
    timeout: 2_000,
    killSignal: "SIGKILL",
    maxBuffer: 1_024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const nodeVersion = "process.versions.bun ? 'bun' : process.versions.node";
  const isNodeVersion = (value: string) => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value);
  let identity: string;
  try {
    identity = probe(executable, nodeVersion);
  } catch (cause) {
    throw new Error(`nodeBin: cannot verify Node executable ${JSON.stringify(executable)}`, { cause });
  }
  if (!isNodeVersion(identity)) {
    throw new Error(`nodeBin: refused non-Node executable ${JSON.stringify(executable)} (${identity})`);
  }
  try {
    const runtime = realpathSync(probe(executable, "process.execPath"));
    const directory = cwd instanceof URL ? fileURLToPath(cwd) : cwd;
    const candidates = executable.includes("/") || executable.includes("\\") ? [executable]
      : (env.PATH ?? "/usr/bin:/bin").split(delimiter).map(path => resolve(directory, path, executable));
    const selected = candidates.map(path => resolve(directory, path)).find(path => {
      try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
    });
    if (!selected || realpathSync(selected) !== runtime || !isNodeVersion(probe(runtime, nodeVersion))) {
      throw new Error("selected executable is not the direct Node runtime");
    }
    return runtime;
  } catch (cause) {
    throw new Error(`nodeBin: cannot verify direct Node executable ${JSON.stringify(executable)}`, { cause });
  }
}
