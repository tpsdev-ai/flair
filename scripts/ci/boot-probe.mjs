import { readFileSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
const [mode, file] = process.argv.slice(2);
try {
  if (mode === "realpath") process.stdout.write(realpathSync(file));
  else if (mode === "password") process.stdout.write(randomBytes(18).toString("base64url"));
  else if (mode === "pid" || mode === "version") {
    const data = JSON.parse(readFileSync(file, "utf8"));
    process.stdout.write(mode === "pid" ? String(data.pid || "") : String(data.version) + "\n");
  } else if (mode === "descriptors") {
    const mod = await import(pathToFileURL(file).href);
    if (!Array.isArray(mod.TOOL_DESCRIPTORS) || !mod.TOOL_DESCRIPTORS.length) throw new Error("no TOOL_DESCRIPTORS export");
  } else throw new Error("unknown boot probe: " + mode);
} catch (error) {
  if (mode !== "realpath" && mode !== "pid") { console.error(error.message); process.exitCode = 1; }
}
