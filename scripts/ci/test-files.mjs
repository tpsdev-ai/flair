import { readdirSync } from "node:fs";
import { join } from "node:path";

export function testFiles(dir, recursive = true) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return recursive ? testFiles(path) : [];
    return /\.test\.[jt]sx?$/.test(entry.name) ? [path] : [];
  }).sort();
}

