import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";

export function createActionRecallRuntime(home: string) {
  const packageDir = join(home, "flair-mcp");
  const artifactPath = join(packageDir, "dist/action-recall-hook.js");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair-mcp", version: flairCliVersion(), bin: { "flair-action-recall": "dist/action-recall-hook.js" } }));
  writeFileSync(artifactPath, `#!/usr/bin/env bun\n// flair-action-recall-built@${flairCliVersion()}\nprocess.exit(0);\n`, { mode: 0o600 });
  return { bunPath: process.execPath, artifactPath };
}
