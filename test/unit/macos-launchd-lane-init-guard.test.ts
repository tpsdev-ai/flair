/**
 * macos-launchd-lane-init-guard.test.ts — flair#3100
 *
 * A failed `flair init` whose output passes the password scan must reach
 * on_error's diagnostics in the launchd adopt-then-upgrade lane. The code under
 * test, the lane's on_error/cleanup_admin_pass_source trap wiring and its init
 * block, is extracted from scripts/ci/macos-launchd-upgrade-lane.sh itself
 * (never copied), because stock macOS /bin/bash 3.2 does NOT fire the ERR trap
 * for `(exit "$init_rc")` inside an `if` body.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LANE = join(REPO_ROOT, "scripts", "ci", "macos-launchd-upgrade-lane.sh");

/** The on_error and cleanup_admin_pass_source trap wiring, verbatim from the lane script. */
function extractTrapWiring(): string {
  const lines = readFileSync(LANE, "utf8").split("\n");
  const start = lines.indexOf("on_error() {");
  if (start < 0) throw new Error(`on_error start marker not found in ${LANE}`);
  const anchor = lines.indexOf("cleanup_admin_pass_source() {", start);
  if (anchor < 0) throw new Error(`cleanup_admin_pass_source anchor not found in ${LANE}`);
  // Ends at the first blank line after the cleanup function, so a deleted trap
  // registration reaches the cases instead of failing this extraction.
  const end = lines.findIndex((line, index) => index > anchor && line.trim() === "");
  if (end < 0) throw new Error(`trap wiring end marker not found in ${LANE}`);
  return lines.slice(start, end).join("\n");
}

/** The init block, verbatim from the lane script. */
function extractInitBlock(): string {
  const lines = readFileSync(LANE, "utf8").split("\n");
  const start = lines.indexOf('ADMIN_PASS="${ADMIN_PASS:-}"');
  if (start < 0) throw new Error(`start marker not found in ${LANE}`);
  const anchor = lines.findIndex(
    (line, index) => index > start && line.includes("still exists after cleanup"),
  );
  if (anchor < 0) throw new Error(`end anchor not found in ${LANE}`);
  const end = lines.findIndex((line, index) => index > anchor && line.trim() === "fi");
  if (end < 0) throw new Error(`end marker not found in ${LANE}`);
  return lines.slice(start, end + 1).join("\n");
}

const STUB = `#!/usr/bin/env bash
set -u
pass_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --admin-pass-file) pass_file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "\${STUB_MODE:-ok}" in
  ok)
    stat -f '%Lp' "$(dirname "$pass_file")" "$pass_file" > "$SOURCE_MODES"
    cp "$pass_file" "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    echo "init ok"
    ;;
  leak)
    cp "$pass_file" "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    cat "$pass_file"
    ;;
  fail)
    echo "init exploded"
    exit 3
    ;;
  nopattern)
    rm -f "$pass_file"
    echo "init wrote no pattern"
    ;;
  bytes)
    printf 'other\\n' > "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    echo "init ok"
    ;;
  mode)
    cp "$pass_file" "$PASS_FILE"
    chmod 644 "$PASS_FILE"
    echo "init ok"
    ;;
  symlink)
    ln -s "$pass_file" "$PASS_FILE"
    chmod -h 600 "$PASS_FILE"
    echo "init ok"
    ;;
  dir)
    mkdir "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    echo "init ok"
    ;;
esac
`;

// The lane's shell options and the globals its wiring reads. dump_diagnostics
// and extract_symptom inspect a real lane run, so they are stubbed.
const HARNESS_HEAD = `set -Eeuo pipefail
REGISTRY_PID=""
ADMIN_PASS_SOURCE_DIR=""
dump_diagnostics() { :; }
extract_symptom() { :; }
`;

// Runs after the lane's wiring: a case without an ERR trap removes the lane's.
const HARNESS_ERR_TRAP = `if [ "\${HARNESS_ERR_TRAP:-0}" != "1" ]; then
  trap - ERR
fi
`;

// Checked after the block and BEFORE the harness exits, so the EXIT trap cannot
// hide a source directory the block left behind.
const HARNESS_TAIL = `set -- "$RUNNER_TEMP"/flair-admin-pass.*
if [ -e "$1" ]; then echo SOURCE-PRESENT-AFTER-BLOCK; fi
echo REACHED-END
`;

type Mode = "ok" | "leak" | "fail" | "nopattern" | "bytes" | "mode" | "symlink" | "dir";

interface Scratch {
  root: string;
  runDir: string;
  passFile: string;
}

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeScratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "flair-init-guard-"));
  scratches.push(root);
  const runDir = join(root, "runner-temp");
  const binDir = join(root, "bin");
  const passFile = join(root, "pass", "admin-pass");
  mkdirSync(runDir);
  mkdirSync(binDir);
  mkdirSync(join(root, "pass"));
  writeFileSync(join(binDir, "flair"), STUB);
  chmodSync(join(binDir, "flair"), 0o755);
  writeFileSync(
    join(root, "harness.sh"),
    `${HARNESS_HEAD}${extractTrapWiring()}\n${HARNESS_ERR_TRAP}${extractInitBlock()}\n${HARNESS_TAIL}`,
  );
  return { root, runDir, passFile };
}

/** A fake `id` whose `id -u` prints a uid other than this process's effective uid. */
function writeForeignId(root: string): string {
  const euid = process.geteuid?.();
  if (euid === undefined) throw new Error("process.geteuid is unavailable on this platform");
  const dir = join(root, "fake-id");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "id"),
    `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "-u" ]; then echo ${euid + 1}; exit 0; fi
echo "fake id: unexpected arguments: $*" >&2
exit 64
`,
  );
  chmodSync(join(dir, "id"), 0o755);
  return dir;
}

function runCase(mode: Mode, errTrap: boolean, shell = "bash", foreignEuid = false) {
  const scratch = makeScratch();
  const pathDirs = [join(scratch.root, "bin"), process.env.PATH ?? ""];
  if (foreignEuid) pathDirs.unshift(writeForeignId(scratch.root));
  const result = spawnSync(shell, [join(scratch.root, "harness.sh")], {
    encoding: "utf8",
    env: {
      PATH: pathDirs.join(":"),
      HOME: join(scratch.root, "home"),
      PORT: "19926",
      OPS_PORT: "19925",
      RUNNER_TEMP: scratch.runDir,
      PASS_FILE: scratch.passFile,
      SOURCE_MODES: join(scratch.root, "source-modes"),
      STUB_MODE: mode,
      HARNESS_ERR_TRAP: errTrap ? "1" : "0",
    },
    timeout: 30_000,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const value = existsSync(scratch.passFile) && lstatSync(scratch.passFile).isFile() ? readFileSync(scratch.passFile, "utf8").trim() : "";
  return { result, out, value, scratch };
}

describe("launchd lane init guard (flair#3100)", () => {
  test(
    "failed init with no ERR trap still reaches on_error once and cleans up",
    () => {
      const { result, out, scratch } = runCase("fail", false);
      expect(result.status).toBe(3);
      expect((out.match(/lane failed \(exit 3\)/g) ?? []).length).toBe(1);
      expect(out).not.toContain("REACHED-END");
      expect(readdirSync(scratch.runDir)).toHaveLength(0);
    },
    60_000,
  );

  test(
    "with the ERR trap installed, a failed init on stock /bin/bash reaches on_error once with the init's exit code",
    () => {
      if (!existsSync("/bin/bash")) {
        console.warn("[case] skipped: /bin/bash does not exist on this host");
        return;
      }
      const { result, out } = runCase("fail", true, "/bin/bash");
      expect(result.status).toBe(3);
      expect((out.match(/lane failed \(exit 3\)/g) ?? []).length).toBe(1);
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );

  test(
    "a leaked password withholds init output and prints no value",
    () => {
      const { result, out, value, scratch } = runCase("leak", false);
      expect(result.status).toBe(1);
      expect(out).toContain("withheld");
      expect(value.length).toBeGreaterThan(0);
      expect(out).not.toContain(value);
      expect(out).not.toContain("REACHED-END");
      expect(readdirSync(scratch.runDir)).toHaveLength(0);
    },
    60_000,
  );

  test(
    "a password scan that cannot run (grep exit 2) withholds init output",
    () => {
      const { result, out } = runCase("nopattern", false);
      expect(result.status).toBe(1);
      expect(out).toContain("withheld");
      expect(out).toContain("grep exit 2");
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );

  // Darwin only: the block reads the pass-file mode with BSD `stat -f '%Lp'`.
  test.skipIf(process.platform !== "darwin")(
    "successful init reaches the end and removes the source dir",
    () => {
      const { result, out, scratch } = runCase("ok", false);
      expect(result.status).toBe(0);
      expect(out).toContain("REACHED-END");
      expect(out).not.toContain("SOURCE-PRESENT-AFTER-BLOCK");
      expect(readdirSync(scratch.runDir)).toHaveLength(0);
      // Modes of the source directory and file, as the stub init received them.
      expect(readFileSync(join(scratch.root, "source-modes"), "utf8")).toBe("700\n600\n");
    },
    60_000,
  );

  // Darwin only, as above. The first three fixtures each isolate one destination
  // check: bytes -> cmp, mode -> the 0600 mode check, symlink (its own mode set
  // to 0600 with chmod -h) -> -L. The directory has two refusal paths: -f and cmp.
  test.skipIf(process.platform !== "darwin")(
    "a persisted file whose bytes differ from the source is refused before adoption",
    () => {
      const { result, out } = runCase("bytes", false);
      expect(result.status).toBe(1);
      expect(out).toContain("must be a runner-owned regular 0600 file identical to the source");
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );

  test.skipIf(process.platform !== "darwin")(
    "a persisted file that is not mode 0600 is refused before adoption",
    () => {
      const { result, out } = runCase("mode", false);
      expect(result.status).toBe(1);
      expect(out).toContain("must be a runner-owned regular 0600 file identical to the source");
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );

  test.skipIf(process.platform !== "darwin")(
    "a persisted symlink is refused before adoption",
    () => {
      const { result, out } = runCase("symlink", false);
      expect(result.status).toBe(1);
      expect(out).toContain("must be a runner-owned regular 0600 file identical to the source");
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );

  test.skipIf(process.platform !== "darwin")(
    "a persisted directory is refused before adoption",
    () => {
      const { result, out } = runCase("dir", false);
      expect(result.status).toBe(1);
      expect(out).toContain("must be a runner-owned regular 0600 file identical to the source");
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );

  // Darwin only, as above. A fake `id` on PATH reports another effective uid, so
  // this fixture (a regular 0600 file identical to the source) fails only the owner check.
  test.skipIf(process.platform !== "darwin")(
    "a persisted file whose owner is not the effective uid is refused before adoption",
    () => {
      const { result, out } = runCase("ok", false, "bash", true);
      expect(result.status).toBe(1);
      expect(out).toContain("must be a runner-owned regular 0600 file identical to the source");
      expect(out).not.toContain("REACHED-END");
    },
    60_000,
  );
});
