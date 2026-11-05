import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = join(import.meta.dir, "../../scripts/audit-gate.mjs");
const pin = /const ALLOWLIST_LINEAGE_START = "[0-9a-f]+";/;
const fixtureStarts = new Map<string, string>();

/** Pins a fixture copy to its own first commit, leaving the production script unchanged. */
export function pinFixtureHistory(root: string, start?: string) {
  const script = join(root, "scripts/audit-gate.mjs");
  if (!start && fixtureStarts.has(root)) return;
  if (!start) {
    const result = spawnSync("git", ["-C", root, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8", timeout: 20_000 });
    if (result.status !== 0) throw new Error(`fixture start: ${result.stderr}`);
    start = result.stdout.trim().split("\n")[0]!;
  }
  fixtureStarts.set(root, start);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(script, readFileSync(source, "utf8").replace(pin, `const ALLOWLIST_LINEAGE_START = "${start}";`));
}

export function readFixtureHistory(root: string) {
  return require(join(root, "scripts/audit-gate.mjs")).readAllowlistHistory(root);
}
