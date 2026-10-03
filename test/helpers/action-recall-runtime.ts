import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";

let built = false;
export function createActionRecallRuntime(home: string) {
  const source = resolve(import.meta.dir, "../../packages/flair-mcp");
  if (!built) {
    execFileSync(process.execPath, ["run", "build"], { cwd: source, timeout: 15_000, stdio: "pipe" });
    built = true;
  }
  const packageDir = join(home, "flair-mcp");
  const artifactPath = join(packageDir, "dist/action-recall-hook.js");
  mkdirSync(packageDir, { recursive: true });
  cpSync(join(source, "dist"), join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair-mcp", version: flairCliVersion(), bin: { "flair-action-recall": "dist/action-recall-hook.js" } }));
  return { bunPath: process.execPath, artifactPath };
}
