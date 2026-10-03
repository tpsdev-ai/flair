import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Stamp the version-matched build marker into every hook entry point flair-mcp
// ships as a Flair-owned artifact (flair#2067, flair#2068). The marker is what
// install/status certification reads back to prove a provisioned copy is the
// version it claims; a missing or stale marker fails certification.
const packageDir = new URL("../packages/flair-mcp/", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", packageDir), "utf8"));

const HOOKS = [
  { file: "dist/action-recall-hook.js", marker: "flair-action-recall-built", shebang: "#!/usr/bin/env bun\n" },
  { file: "dist/capture-hook.js", marker: "flair-capture-built", shebang: "#!/usr/bin/env bun\n" },
];

for (const { file, marker, shebang } of HOOKS) {
  const path = fileURLToPath(new URL(file, packageDir));
  const text = readFileSync(path, "utf8");
  if (!text.startsWith(shebang)) throw new Error(`missing build entry point: ${file}`);
  writeFileSync(path, text.replace(shebang, `${shebang}// ${marker}@${version}\n`));
}
