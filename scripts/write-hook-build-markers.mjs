import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
