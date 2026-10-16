import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

export function shellScript(source: string): string {
  const path = join(tempDir("flair-shell-script-"), "script.sh");
  writeFileSync(path, source);
  return path;
}
