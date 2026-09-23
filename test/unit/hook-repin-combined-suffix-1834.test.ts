/**
 * hook-repin-combined-suffix-1834.test.ts — flair#1834 PR-H round 4 (CodeRabbit minor).
 *
 * THE DEFECT. All three installer-form regexes accepted a pre-release OR a build
 * suffix, but not BOTH: the version tail was `\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?`
 * — one `[-+]` then a body with no `+`. A pin carrying both, e.g.
 * `0.54.0-rc.1+build.5`, therefore matched NO form, and a stale installer hook
 * was HELD ("not one of the installer forms") instead of updated.
 *
 * THE FIX. Separate, optional pre-release and build groups in all three
 * patterns: `(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`. Both groups are
 * NON-capturing, so the captured package-spec group keeps index 3 and the
 * `d`-flag offset the re-pin substitutes is unchanged.
 *
 * RED on 7a86d63e: the combined-suffix STALE pin is HELD (not re-pinned), and the
 * AHEAD pin is held at the FORM with no guard line.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repinSessionStartHook, hookSettingsPath, parseInstallerHookForm, type Harness } from "../../src/hook-install.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

const CURRENT_SPEC = mcpServerSpec();

// A stale combined-suffix version (0.0.0 is never the running CLI) and an
// ahead one. Both carry BOTH a pre-release AND a build suffix.
const STALE_COMBINED = "0.0.0-rc.1+build.5";
const AHEAD_COMBINED = "9999.9999.9999-rc.1+build.5";
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_COMBINED}`;
const AHEAD_SPEC = `${FLAIR_MCP_PACKAGE}@${AHEAD_COMBINED}`;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-h-suffix-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

/** The three exact installer forms `buildSessionStartHookCommand` emits, with a
 *  chosen package spec. */
const bareCmd = (id: string, spec: string): string =>
  `FLAIR_AGENT_ID=${id} npx -y -p ${spec} flair-session-start`;
const claudeCmd = (id: string, spec: string): string =>
  `sh -c 'out=$(FLAIR_AGENT_ID=${id} npx -y -p ${spec} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
const codexCmd = (id: string, spec: string): string =>
  `sh -c 'out=$(FLAIR_HOOK_HARNESS=codex FLAIR_AGENT_ID=${id} npx -y -p ${spec} flair-session-start) && printf %s "$out" || true'`;

const FORMS: ReadonlyArray<{ name: string; harness: Harness; build: (id: string, spec: string) => string }> = [
  { name: "bare", harness: "claude-code", build: bareCmd },
  { name: "claude-code", harness: "claude-code", build: claudeCmd },
  { name: "codex", harness: "codex", build: codexCmd },
];

function writeHook(harness: Harness, command: string): string {
  const path = hookSettingsPath(isoHome, harness);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }, null, 2) + "\n");
  return path;
}

describe("flair#1834 PR-H round 4 — a version with BOTH suffixes still matches the installer forms", () => {
  for (const form of FORMS) {
    it(`${form.name}: a combined-suffix STALE pin is re-pinned, and only the package span changes`, () => {
      const cmd = form.build("local", STALE_SPEC);
      // The FORM must accept it, and capture the whole `@pkg@<ver>` span.
      expect(parseInstallerHookForm(cmd)?.pkgSpec).toBe(STALE_SPEC);

      const path = writeHook(form.harness, cmd);
      const before = readFileSync(path, "utf-8");

      const r = repinSessionStartHook(isoHome, form.harness);

      expect(r.action).toBe("update");
      const after = JSON.parse(readFileSync(path, "utf-8")).hooks.SessionStart[0].hooks[0].command as string;
      expect(after).toBe(form.build("local", CURRENT_SPEC));

      // Only the CAPTURED package span moved — every byte outside it is the same.
      const span = parseInstallerHookForm(cmd)!;
      expect(after.slice(0, span.pkgSpecStart)).toBe(cmd.slice(0, span.pkgSpecStart));
      expect(after.slice(span.pkgSpecStart + CURRENT_SPEC.length)).toBe(cmd.slice(span.pkgSpecEnd));

      // The pre-release/build tail is gone, not mangled: nothing of the old pin remains.
      expect(after).not.toContain("rc.1");
      expect(after).not.toContain("build.5");
      expect(before).toContain(STALE_SPEC);
    });

    it(`${form.name}: a combined-suffix AHEAD pin is HELD byte-identical by the guard`, () => {
      const cmd = form.build("local", AHEAD_SPEC);
      expect(parseInstallerHookForm(cmd)?.pkgSpec).toBe(AHEAD_SPEC);

      const path = writeHook(form.harness, cmd);
      const before = readFileSync(path, "utf-8");

      const r = repinSessionStartHook(isoHome, form.harness);

      expect(r.action).toBe("hold");
      // Held by the never-lower GUARD (a form that parsed), not by the FORM.
      expect(r.message).toContain("never lowering a pin");
      expect(readFileSync(path, "utf-8")).toBe(before);
    });
  }
});
