/**
 * cli-runtime-node-guard-2570.test.ts — no test starts the shipped CLI or
 * Harper under Bun.
 *
 * flair#2570. Every SHIPPED path runs the flair CLI under node: the package
 * `bin` is `dist/cli-shim.cjs` (`#!/usr/bin/env node`), and `flair init` spawns
 * Harper with the CLI's own `process.execPath`, so an installed `flair` always
 * starts Harper under node. Harper's default `vm-current-context` module loader
 * diverges under Bun (Bun defines `vm.SourceTextModule`; node without
 * `--experimental-vm-modules` does not), which on macOS raises
 * `ResourceLoadError` while a component loads — a silently missing resource, and
 * on the Bun segfault path no HTTP port at all.
 *
 * A test that spawns the SHIPPED CLI under the runner's Bun —
 * `spawn(process.execPath, [cliPath, "init", ...])` or
 * `spawn("bun", [cliPath, "init", ...])` where `cliPath` is `dist/cli.js` —
 * starts Harper under the wrong runtime and exercises a loader path no user
 * hits. Such a test must spawn the CLI through `nodeBin()`
 * (test/helpers/node-runtime.ts) instead. A run that cannot start Harper (a
 * non-starting subcommand, `--skip-start`, or a `--target` instance) does not
 * reach the loader and is not flagged.
 *
 * This is the line. A per-test fix does not hold by itself: the next new test
 * spawns the shipped CLI the same way. The guard scans `test/` as text and fails
 * on a spawn of the shipped CLI entry with an instance-starting subcommand, or of
 * a Harper binary, under a Bun runtime, unless the call carries an
 * `allow-bun-harper` comment naming why the Bun runtime is required.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

/** Identifier assigned by a `join(…, "dist", "cli.js" | "cli-shim.cjs")`. */
function shippedCliIdentifiers(source: string): Set<string> {
  const ids = new Set<string>();
  for (const m of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*join\(([^\n]*?)\)/g)) {
    const args = m[2];
    const isDist = /["']dist["']/.test(args);
    if (isDist && (/["']cli\.js["']/.test(args) || /["']cli-shim\.cjs["']/.test(args))) ids.add(m[1]);
  }
  return ids;
}

const BUN_COMMAND = /^(process\.execPath|"bun"|'bun'|bunPath|BUN|bunBin)$/;
const HARPER_REF = /HARPER_BIN|harperBinPath|harper\.path|harper\.js/;
// A subcommand that starts a local instance, and the flags that make an `init`
// NOT start one (a run that cannot start Harper cannot exercise the loader).
const STARTS_HARPER = /["'](init|start|restart|upgrade|serve|downgrade)["']/;
const NEUTRALISED = /--skip-start|--target\b|--external\b|--check\b|--help\b|--dry-run\b/;

export interface BunHarperSpawn {
  line: number;
  command: string;
  reason: "shipped-cli" | "harper";
}

/**
 * Spawns in `source` that run the shipped CLI or a Harper binary under Bun. The
 * command token and the entry are read from the source text; a spawn whose line
 * (or the line above) carries an `allow-bun-harper` comment is skipped.
 */
export function findBunHarperSpawns(source: string): BunHarperSpawn[] {
  const ids = shippedCliIdentifiers(source);
  const lines = source.split("\n");
  const found: BunHarperSpawn[] = [];
  const callRe = /(?:Bun\.)?(spawn|spawnSync|execFileSync|execSync|execFile)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source))) {
    const start = m.index;
    const isBunFn = m[0].startsWith("Bun.");
    const rest = source.slice(start + m[0].length);
    let depth = 0;
    let arg = "";
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
      arg += c;
    }
    let command: string;
    if (isBunFn) {
      const first = arg.match(/\[\s*([^,\]]+)/);
      if (!first) continue;
      command = first[1].trim();
    } else {
      command = arg.trim();
    }
    if (!BUN_COMMAND.test(command)) continue;

    const call = source.slice(start, start + 500);
    const lineNo = source.slice(0, start).split("\n").length;
    const context = `${lines[lineNo - 2] ?? ""}\n${lines[lineNo - 1] ?? ""}`;
    if (/allow-bun-harper/.test(context)) continue;

    let shipped = false;
    if (/["']dist\/cli\.js["']|["']cli-shim\.cjs["']/.test(call)) shipped = true;
    else {
      for (const id of ids) {
        if (new RegExp(`[\\[,(\\s]${id.replace(/\$/g, "\\$")}[\\],)\\s]`).test(call)) {
          shipped = true;
          break;
        }
      }
    }
    let reason: BunHarperSpawn["reason"] | null = null;
    if (HARPER_REF.test(call)) reason = "harper";
    else if (shipped && STARTS_HARPER.test(call) && !NEUTRALISED.test(call)) reason = "shipped-cli";
    if (reason) found.push({ line: lineNo, command, reason });
  }
  return found;
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("flair#2570 — tests start the shipped CLI and Harper under node", () => {
  test("the scanner flags a shipped-CLI spawn under the runner's Bun", () => {
    const src = [
      `import { spawn } from "node:child_process";`,
      `const cliPath = join(ROOT, "dist", "cli.js");`,
      `function run() {`,
      `  return spawn(process.execPath, [cliPath, "init"]);`,
      `}`,
    ].join("\n");
    expect(findBunHarperSpawns(src).map((s) => s.reason)).toEqual(["shipped-cli"]);
  });

  test("the scanner flags a Harper-binary spawn under a literal bun command", () => {
    const src = [
      `import { spawnSync } from "node:child_process";`,
      `const HARPER_BIN = join(dir, "harper.js");`,
      `spawnSync("bun", [HARPER_BIN, "run", "."]);`,
    ].join("\n");
    expect(findBunHarperSpawns(src).map((s) => s.reason)).toEqual(["harper"]);
  });

  test("the scanner ignores a non-shipped entry and an allow-commented call", () => {
    const src = [
      `const srcCli = join(ROOT, "src", "cli.ts");`,
      `spawn("bun", [srcCli, "status"]);`,
      `// allow-bun-harper: the fixture spawns a bun-only harness, not the CLI`,
      `spawn("bun", ["--eval", "1"]);`,
    ].join("\n");
    expect(findBunHarperSpawns(src)).toEqual([]);
  });

  test("no test spawns the shipped CLI or a Harper binary under Bun", () => {
    const self = "cli-runtime-node-guard-2570.test.ts";
    const offenders: string[] = [];
    for (const file of testFiles(join(ROOT, "test"))) {
      if (file.endsWith(self)) continue;
      for (const s of findBunHarperSpawns(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(ROOT, file)}:${s.line} (${s.reason}, command ${s.command})`);
      }
    }
    expect(offenders, `spawn the shipped CLI/Harper through nodeBin() instead:\n${offenders.join("\n")}`).toEqual([]);
  });
});
