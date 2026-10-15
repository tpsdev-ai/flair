import { execFileSync } from "node:child_process";

export function nodeBin(): string {
  const executable = process.env.NODE_BIN?.trim() || (process.versions.bun ? "node" : process.execPath);
  let identity: string;
  try {
    identity = execFileSync(executable, ["-p", "process.versions.bun ? 'bun' : process.versions.node"], {
      encoding: "utf8",
      timeout: 2_000,
      killSignal: "SIGKILL",
      maxBuffer: 1_024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    throw new Error(`nodeBin: cannot verify Node executable ${JSON.stringify(executable)}`, { cause });
  }
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(identity)) {
    throw new Error(`nodeBin: refused non-Node executable ${JSON.stringify(executable)} (${identity})`);
  }
  return executable;
}
