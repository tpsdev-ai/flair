import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SESSION_START_HOOK_MARKER,
  buildSessionStartHookCommand,
  hookCommandIsSilenced,
  isFlairHookCommand,
  isHookCommandValueSafe,
  parseLegacySessionStartHookCommand,
} from "../../src/doctor-client.ts";

/**
 * flair#1007 — the SessionStart hook must be SILENT when its `npx` invocation
 * cannot resolve or execute.
 *
 * The defect this file exists for is not reachable by exercising a working
 * hook: the failure is that the adapter binary NEVER RUNS, so every guarantee
 * that lives inside it is unreachable. The only thing standing between the
 * user and an error on every session is the command string itself. So these
 * tests do not assert on the string's spelling — they EXECUTE it, through a
 * real shell, under conditions where the command genuinely cannot resolve.
 *
 * Every "the wrapper is silent" assertion is paired with a POSITIVE CONTROL
 * running the pre-#1007 command in the identical conditions. Without that
 * control a broken fixture (e.g. a PATH that still happens to find npx) would
 * make the whole file pass while the defect remained.
 */

// The exact string Flair wrote before #1007 — the control, and the shape
// `flair doctor --fix` upgrades.
const LEGACY_COMMAND = `FLAIR_AGENT_ID=me npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}`;

const AGENT = "me";

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a hook command the way Claude Code does: `<shell> -c "<command>"`.
 *  Claude Code itself always uses /bin/sh (it spawns with `shell: true` and
 *  never consults $SHELL), which is why /bin/sh is the mandatory leg below. */
function runCommand(command: string, shell: string, path: string): Run {
  const res = spawnSync(shell, ["-c", command], {
    input: "",
    encoding: "utf-8",
    timeout: 20_000,
    env: { PATH: path, HOME: process.env.HOME ?? "/tmp" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ── fixtures ────────────────────────────────────────────────────────────────
//
// Three PATHs, each simulating one state of the world. Nothing is installed
// globally and no real `npx` is ever consulted (the constraint that makes this
// runnable in CI and on a developer machine alike).

let fixtureDir: string;
/** No `npx` at all — simulates the orphaned-shim failure: the command cannot resolve. */
let PATH_UNRESOLVABLE: string;
/** An `npx` that resolves, writes to BOTH streams and exits non-zero. */
let PATH_CRASHING: string;
/** An `npx` that resolves and behaves like the real adapter. */
let PATH_WORKING: string;

const ADAPTER_OUTPUT = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"ctx"}}';

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "flair-hook-cmd-"));

  const emptyBin = join(fixtureDir, "empty");
  const crashBin = join(fixtureDir, "crash");
  const workBin = join(fixtureDir, "work");
  for (const d of [emptyBin, crashBin, workBin]) {
    mkdirSync(d, { recursive: true });
    // The wrapper invokes `sh`, so `sh` must be findable — but NOTHING else
    // is, which is what makes "npx cannot resolve" true by construction
    // rather than by hoping the ambient PATH has no npx on it.
    symlinkSync("/bin/sh", join(d, "sh"));
  }

  // A crashing resolver that pollutes stdout as well as stderr. stdout matters
  // independently of the exit code: Claude Code injects a SessionStart hook's
  // non-JSON stdout into the model's context verbatim, and treats stdout that
  // starts with `{` but fails validation as a hook error EVEN AT EXIT 0.
  writeFileSync(
    join(crashBin, "npx"),
    "#!/bin/sh\necho 'npm error could not determine executable to run'\necho 'mise ERROR No version is set for shim: flair-session-start' >&2\nexit 1\n",
  );
  writeFileSync(join(workBin, "npx"), `#!/bin/sh\nprintf '%s' '${ADAPTER_OUTPUT}'\n`);
  chmodSync(join(crashBin, "npx"), 0o755);
  chmodSync(join(workBin, "npx"), 0o755);

  // Deliberately NOT inheriting process.env.PATH: a leaked real `npx` would
  // silently turn the unresolvable case into a working one.
  PATH_UNRESOLVABLE = emptyBin;
  PATH_CRASHING = crashBin;
  PATH_WORKING = workBin;
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

// ── which shells to exercise ────────────────────────────────────────────────
//
// /bin/sh is what Claude Code actually uses, so it is REQUIRED — if it is
// missing the suite fails rather than silently skipping (an unrun check must
// never look like a pass). /bin/bash is required too so at least two
// independent implementations are always covered. Everything else is
// opportunistic breadth for the "we also publish this string for hand-wiring"
// case: fish and csh/tcsh in particular reject the bare POSIX fragment this
// wrapper deliberately avoids.
//
// /bin/ksh is deliberately ABSENT rather than opportunistically included:
// macOS ships ksh93u+ (2012), which SIGSEGVs on any command spawned from Bun
// — `spawnSync("/bin/ksh", ["-c", "echo hi"])` crashes identically, so it
// measures the runtime, not this command. It was verified by hand at a shell
// prompt instead. Listing it here would produce a red leg that says nothing.
const REQUIRED_SHELLS = ["/bin/sh", "/bin/bash"];
const OPTIONAL_SHELLS = ["/bin/zsh", "/bin/dash", "/bin/tcsh", "/bin/csh", "/opt/homebrew/bin/fish", "/usr/bin/fish", "/usr/local/bin/fish"];

function shellsUnderTest(): string[] {
  return [...REQUIRED_SHELLS, ...OPTIONAL_SHELLS.filter((s) => existsSync(s))];
}

describe("buildSessionStartHookCommand — shape", () => {
  it("carries the marker, the package and the agent id verbatim", () => {
    const cmd = buildSessionStartHookCommand(AGENT);
    expect(cmd).toContain(SESSION_START_HOOK_MARKER);
    expect(cmd).toContain("npx -y @tpsdev-ai/flair-mcp");
    expect(cmd).toContain(`FLAIR_AGENT_ID=${AGENT}`);
  });

  it("includes FLAIR_URL only when one is given", () => {
    expect(buildSessionStartHookCommand(AGENT)).not.toContain("FLAIR_URL=");
    expect(buildSessionStartHookCommand(AGENT, "http://127.0.0.1:19926")).toContain("FLAIR_URL=http://127.0.0.1:19926");
  });

  it("refuses values that cannot be represented safely in a shell command", () => {
    expect(isHookCommandValueSafe("me")).toBe(true);
    expect(isHookCommandValueSafe("http://127.0.0.1:19926")).toBe(true);
    for (const bad of ["me'; rm -rf /", "me with space", "me$(id)", "me`id`", 'me"x', "me\\x"]) {
      expect(isHookCommandValueSafe(bad)).toBe(false);
      expect(() => buildSessionStartHookCommand(bad)).toThrow();
    }
    expect(() => buildSessionStartHookCommand(AGENT, "http://x/'`id`")).toThrow();
  });

  it("is recognised as ours and as silenced; the legacy command is neither", () => {
    const cmd = buildSessionStartHookCommand(AGENT);
    expect(isFlairHookCommand(cmd)).toBe(true);
    expect(hookCommandIsSilenced(cmd)).toBe(true);

    expect(isFlairHookCommand(LEGACY_COMMAND)).toBe(true);
    expect(hookCommandIsSilenced(LEGACY_COMMAND)).toBe(false);
  });
});

describe("parseLegacySessionStartHookCommand", () => {
  it("matches the exact pre-#1007 shapes, with and without FLAIR_URL", () => {
    expect(parseLegacySessionStartHookCommand(LEGACY_COMMAND)).toEqual({ agentId: "me", flairUrl: undefined });
    expect(
      parseLegacySessionStartHookCommand(
        `FLAIR_AGENT_ID=me FLAIR_URL=http://127.0.0.1:19926 npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}`,
      ),
    ).toEqual({ agentId: "me", flairUrl: "http://127.0.0.1:19926" });
  });

  it("does NOT match a hand-edited or already-upgraded command", () => {
    // The whole point of an exact match: --fix must never rewrite a command a
    // user authored, only one Flair itself wrote.
    expect(parseLegacySessionStartHookCommand(buildSessionStartHookCommand(AGENT))).toBeNull();
    expect(parseLegacySessionStartHookCommand(`${LEGACY_COMMAND} --extra-flag`)).toBeNull();
    expect(parseLegacySessionStartHookCommand(`FLAIR_AGENT_ID=me npx -y @tpsdev-ai/flair-mcp@0.33.0 ${SESSION_START_HOOK_MARKER}`)).toBeNull();
    expect(parseLegacySessionStartHookCommand("my-own-hook.sh")).toBeNull();
  });
});

describe("the command is silent when it cannot resolve (flair#1007 — the defect)", () => {
  const wrapped = () => buildSessionStartHookCommand(AGENT);

  it("POSITIVE CONTROL: the pre-#1007 command IS loud in these same conditions", () => {
    // Without this, a fixture that accidentally still resolved `npx` would let
    // every assertion below pass while the bug was untouched.
    const legacy = runCommand(LEGACY_COMMAND, "/bin/sh", PATH_UNRESOLVABLE);
    expect(legacy.status).not.toBe(0);
    expect(legacy.stderr.trim()).not.toBe("");
  });

  for (const shell of shellsUnderTest()) {
    it(`${shell}: unresolvable command → exit 0, no stdout, no stderr`, () => {
      const run = runCommand(wrapped(), shell, PATH_UNRESOLVABLE);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe("");
    });

    it(`${shell}: resolver that crashes and pollutes both streams → exit 0, no stdout, no stderr`, () => {
      const run = runCommand(wrapped(), shell, PATH_CRASHING);
      expect(run.status).toBe(0);
      // stdout suppression is load-bearing, not tidiness: unsuppressed, the
      // resolver's stdout would be injected into the model's context.
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe("");
    });

    it(`${shell}: working adapter → output passed through byte-for-byte, exit 0`, () => {
      const run = runCommand(wrapped(), shell, PATH_WORKING);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(ADAPTER_OUTPUT);
      expect(run.stderr).toBe("");
    });
  }

  it("exercises /bin/sh and /bin/bash at minimum", () => {
    // Guards the loop above against silently degenerating to zero legs if the
    // shell-detection logic ever changes.
    const shells = shellsUnderTest();
    expect(shells).toContain("/bin/sh");
    expect(shells).toContain("/bin/bash");
    expect(shells.length).toBeGreaterThanOrEqual(2);
  });
});
