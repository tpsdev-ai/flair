import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_VERSION_STAMP } from "../src/engine-version-contract.js";

/** The flair package root (`<pkg>/dist/resources/x.js` → `<pkg>`). */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Attempt to stamp the data directory. */
export function stampEngineVersionOnBoot(dataDir: string = process.env.ROOTPATH || join(
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
        const stampPath = join(dataDir, ENGINE_VERSION_STAMP);
        const temporary = `${stampPath}.${process.pid}.${randomUUID()}.tmp`;
        let fd: number | undefined;
        try {
          fd = openSync(temporary, "wx", 0o600);
          writeFileSync(fd, `${version}\n`, "utf8");
          fsyncSync(fd);
          closeSync(fd);
          fd = undefined;
          renameSync(temporary, stampPath);
        } finally {
          if (fd !== undefined) closeSync(fd);
          try { unlinkSync(temporary); } catch {}
        }
        return;
      }
    }
  } catch {
    // Best-effort: a stamp write is never allowed to fail a boot.
  }
}

stampEngineVersionOnBoot();
