import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_VERSION_STAMP } from "../src/engine-version-contract.js";

/** The flair package root (`<pkg>/dist/resources/x.js` → `<pkg>`). */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Write the running engine's version stamp into this instance's data dir. */
export function stampEngineVersionOnBoot(dataDir: string = join(
  (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir(), ".flair", "data",
)): void {
  try {
    if (!existsSync(dataDir)) return;
    for (const name of ["harper", "@harperfast/harper"]) {
      let version: string | undefined;
      try {
        const pkgPath = join(packageRoot(), "node_modules", ...name.split("/"), "package.json");
        version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
      } catch { continue; }
      if (version) {
        writeFileSync(join(dataDir, ENGINE_VERSION_STAMP), `${version}\n`, "utf8");
        return;
      }
    }
  } catch {
    // Best-effort: a stamp write is never allowed to fail a boot.
  }
}

stampEngineVersionOnBoot();
