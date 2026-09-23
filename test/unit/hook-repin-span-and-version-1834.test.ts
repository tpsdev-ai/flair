/**
 * hook-repin-span-and-version-1834.test.ts — flair#1834 PR-H round 2 (Kern BLOCKING).
 *
 * THE DEFECT. `repinSessionStartHook` rebuilt the hook with
 * `current.replace(form.pkgSpec, mcpServerSpec())` — which replaces the FIRST
 * occurrence of the spec substring ANYWHERE in the command, not the span the
 * form regex captured. The form's id/URL charsets admit characters that let a
 * hand-edited id or URL CONTAIN the package-spec string; such a command passes
 * full-form validation, the substitution lands inside the identity (or URL)
 * span, the real `-p` pin stays stale, and the run still reports "re-pinned".
 *
 * THE FIX. Substitute at the CAPTURED GROUP'S OFFSET (the `d`-flag indices), so
 * only the `<ver>` span changes and the id/URL are byte-identical.
 *
 * SECONDARY. The `<ver>` group admitted `;` and `$`, so `@0.0.0;cmd` and
 * `@0.0.0$X` passed the FORM and were held only by the never-lower guard. The
 * group is now a semver, so the FORM rejects those shapes.
 *
 * RED on 10f8058a: the embedding shapes "re-pin" with the id/URL rewritten and
 * the real pin stale; the `;`/`$` shapes parse as forms.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repinSessionStartHook, hookSettingsPath, parseInstallerHookForm } from "../../src/hook-install.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec, flairCliVersion } from "../../src/lib/mcp-spec.ts";

const CURRENT_VER = flairCliVersion();
const STALE_VER = "0.0.0"; // never matches the running CLI
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VER}`;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-h-span-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

/** The exact Claude Code installer form (`buildSessionStartHookCommand`). */
function claudeCmd(envParts: string, ver: string): string {
  return `sh -c 'out=$(${envParts} npx -y -p ${FLAIR_MCP_PACKAGE}@${ver} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
}

function writeHook(command: string): string {
  const path = hookSettingsPath(isoHome, "claude-code");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }, null, 2) + "\n");
  return path;
}

function readHookCommand(): string {
  const cfg = JSON.parse(readFileSync(hookSettingsPath(isoHome, "claude-code"), "utf-8"));
  return cfg?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? "";
}

describe("flair#1834 PR-H round 2 — the re-pin substitutes the CAPTURED span, not the first match", () => {
  it("an id that EMBEDS the package spec: id byte-identical, the -p pin advanced", () => {
    const id = `ghost@${FLAIR_MCP_PACKAGE}@${STALE_VER}`;
    const before = claudeCmd(`FLAIR_AGENT_ID=${id}`, STALE_VER);
    writeHook(before);

    const res = repinSessionStartHook(isoHome, "claude-code");
    expect(res.action).toBe("update");

    const after = readHookCommand();
    // ONLY the -p pin moved; the identity is byte-identical.
    expect(after).toBe(claudeCmd(`FLAIR_AGENT_ID=${id}`, CURRENT_VER));
    expect(after).toContain(`FLAIR_AGENT_ID=${id} `);
    expect(after).toContain(`-p ${FLAIR_MCP_PACKAGE}@${CURRENT_VER} `);
  });

  it("a URL that EMBEDS the package spec: URL byte-identical, the -p pin advanced", () => {
    const url = `http://127.0.0.1:19926/${FLAIR_MCP_PACKAGE}@${STALE_VER}`;
    const before = claudeCmd(`FLAIR_AGENT_ID=ghost FLAIR_URL=${url}`, STALE_VER);
    writeHook(before);

    const res = repinSessionStartHook(isoHome, "claude-code");
    expect(res.action).toBe("update");

    const after = readHookCommand();
    expect(after).toBe(claudeCmd(`FLAIR_AGENT_ID=ghost FLAIR_URL=${url}`, CURRENT_VER));
    expect(after).toContain(`FLAIR_URL=${url} `);
    expect(after).toContain(`-p ${FLAIR_MCP_PACKAGE}@${CURRENT_VER} `);
  });

  it("CONTROL: a normal form re-pins with identity and URL intact", () => {
    const before = claudeCmd("FLAIR_AGENT_ID=plain FLAIR_URL=http://127.0.0.1:19926", STALE_VER);
    writeHook(before);
    const res = repinSessionStartHook(isoHome, "claude-code");
    expect(res.action).toBe("update");
    expect(readHookCommand()).toBe(claudeCmd("FLAIR_AGENT_ID=plain FLAIR_URL=http://127.0.0.1:19926", CURRENT_VER));
  });
});

describe("flair#1834 PR-H round 2 — the version group is a semver, so `;`/`$` are rejected at the FORM", () => {
  for (const [name, tail] of [["semicolon", `@${STALE_VER};touch`], ["dollar", `@${STALE_VER}$X`]] as const) {
    it(`a ${name} version tail does NOT match the form (held at the form, before the guard)`, () => {
      const cmd = `FLAIR_AGENT_ID=x npx -y -p ${FLAIR_MCP_PACKAGE}${tail} flair-session-start`;
      expect(parseInstallerHookForm(cmd)).toBeNull();

      // ... and the re-pin HOLDs it, byte-identical, on the real path.
      const path = writeHook(cmd);
      const original = readFileSync(path, "utf-8");
      const res = repinSessionStartHook(isoHome, "claude-code");
      expect(res.action).toBe("hold");
      expect(readFileSync(path, "utf-8")).toBe(original);
    });
  }

  it("a semver with a pre-release suffix still matches (the tightening is not too tight)", () => {
    const cmd = claudeCmd("FLAIR_AGENT_ID=x", "0.0.0-rc.1");
    expect(parseInstallerHookForm(cmd)?.pkgSpec).toBe(`${FLAIR_MCP_PACKAGE}@0.0.0-rc.1`);
  });

  it("a semver with a build suffix still matches", () => {
    const cmd = claudeCmd("FLAIR_AGENT_ID=x", "0.0.0+build5");
    expect(parseInstallerHookForm(cmd)?.pkgSpec).toBe(`${FLAIR_MCP_PACKAGE}@0.0.0+build5`);
  });
});
