/**
 * plain-tree-upgrade-lane.ts — flair#1109 (a) CI spoke-ritual fixture
 *
 * Non-launchd, non-global-npm. Builds a packed extract (npm pack shape) plus
 * an operator launcher and a systemd user unit, then runs
 * `flair upgrade --check --tree` against that tree. Fails unless the command
 * takes the in-place tarball-swap lane.
 *
 * Fetch is stubbed so this never hits the registry. Does not start Harper.
 *
 * Exit 0 prints `PASS: plain-tree upgrade lane`. Any missing assertion exits 1.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spyOn } from "bun:test";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function writePackedTree(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@tpsdev-ai/flair", version }),
  );
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(dir, "flair"), "#!/bin/sh\nexec node dist/cli.js \"$@\"\n");
}

function writeUserUnit(home: string, tree: string): void {
  const unitDir = join(home, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(
    join(unitDir, "flair.service"),
    [
      "[Service]",
      `WorkingDirectory=${tree}`,
      `ExecStart=${tree}/flair start`,
      "",
    ].join("\n"),
  );
}

function fail(message: string, extra = ""): never {
  console.error(`FAIL: ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

// Canonicalize BOTH paths the fixture writes and later asserts on.
// The product canonicalizes a tree before matching units against it
// (readFlairPackageAt -> canonicalPath, src/lib/upgrade-exec-path.ts),
// so a fixture that writes a unit naming a NON-canonical path can never
// be matched: the unit says /var/folders/... while the lookup asks for
// /private/var/folders/... . That is platform-independent -- it bites
// wherever TMPDIR or HOME sits behind a symlink, which on macOS is the
// default (/var -> /private/var, /tmp -> /private/tmp) and on Linux is
// usually not. The lane passed on Linux by accident of /tmp being a real
// directory there, NOT because the lane is Linux-only. Refs #1753.
const home = realpathSync(homedir());
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "flair-plain-tree-lane-")));
const tree = join(scratch, "spoke");
const cleanup = (): void => {
  rmSync(scratch, { recursive: true, force: true });
};
process.on("exit", cleanup);

writePackedTree(tree, "0.36.0");
writeUserUnit(home, tree);

const { program } = await import(join(repoRoot, "src", "cli.ts"));

const logs: string[] = [];
const errs: string[] = [];
const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
  const line = args.map((a) => String(a)).join(" ");
  logs.push(line);
  process.stdout.write(`${line}\n`);
});
const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
  const line = args.map((a) => String(a)).join(" ");
  errs.push(line);
  process.stderr.write(`${line}\n`);
});
const origFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ version: "0.99.0" }), { status: 200 })
) as unknown as typeof fetch;
let exitCode: number | null = null;
const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
  exitCode = code ?? 0;
  throw new Error(`process.exit(${exitCode})`);
}) as typeof process.exit);

try {
  await program.parseAsync([
    "node",
    "flair",
    "upgrade",
    "--check",
    "--tree",
    tree,
  ]);
} catch (err) {
  if (!(err instanceof Error) || !err.message.startsWith("process.exit(")) {
    fail("upgrade --check --tree threw", err instanceof Error ? err.stack ?? err.message : String(err));
  }
} finally {
  globalThis.fetch = origFetch;
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
}

const text = logs.join("\n");
const errText = errs.join("\n");

if (exitCode !== null) {
  fail(`upgrade --check --tree exited ${exitCode}`, errText || text);
}
if (!text.includes(`Plain-tree install: ${tree}  (0.36.0)`)) {
  fail("missing plain-tree banner for the packed extract", text);
}
if (!text.includes("@tpsdev-ai/flair: 0.36.0 → 0.99.0")) {
  fail("listing did not use the packed tree version → registry latest", text);
}
if (!text.includes("in-place tarball swap")) {
  fail("plan did not name the in-place tarball-swap lane", text);
}
if (!text.includes("preserve launcher/overlay: flair")) {
  fail("plan did not preserve the operator launcher", text);
}
if (!text.includes("restart unit: flair.service (user:")) {
  fail("plan did not name the systemd user unit for this tree", text);
}
if (!text.includes(`Scope: plain-tree at ${tree}`)) {
  fail("missing plain-tree scope footer", text);
}
if (text.includes("`flair upgrade` only upgrades the npm-global packages")) {
  fail("#1560 npm-global-only warning printed on the tree lane (should stay suppressed)", text);
}

console.log("PASS: plain-tree upgrade lane");
