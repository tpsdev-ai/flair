import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageDir = new URL("../packages/flair-mcp/", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", packageDir), "utf8"));
const path = fileURLToPath(new URL("dist/action-recall-hook.js", packageDir));
const text = readFileSync(path, "utf8");
if (!text.startsWith("#!/usr/bin/env bun\n")) throw new Error("missing action-recall build entry point");
writeFileSync(path, text.replace("#!/usr/bin/env bun\n", `#!/usr/bin/env bun\n// flair-action-recall-built@${version}\n`));
