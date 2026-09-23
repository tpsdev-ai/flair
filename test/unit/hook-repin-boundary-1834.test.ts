/**
 * hook-repin-boundary-1834.test.ts — flair#1834 PR-H (SessionStart hook boundary).
 *
 * Hook re-pin preserves the parsed agent id — but the validator was an
 * unanchored substring match and the parser took the FIRST `FLAIR_AGENT_ID=`
 * while a shell uses the LAST, so a command with two assignments was accepted
 * as canonical and the rebuild wrote back the first value (changing the
 * effective identity). PR-H re-pins ONLY when the FULL command equals one of the
 * three installer forms; everything else is a visible, byte-preserving HOLD
 * through A1's hold seam. All cases are RED on the A1 base unless noted.
 *
 * The attack detail lives here (a unit test), not in the public PR body.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repinSessionStartHook, hookSettingsPath, type Harness } from "../../src/hook-install.ts";
import { refreshOwnedPins, ownedPinRefreshShouldReport } from "../../src/lib/owned-pins.ts";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

const INSTALLED = flairCliVersion();
const CURRENT = mcpServerSpec();
const core = parseSemverCore(INSTALLED)!;
const OLD = core[2] > 0 ? `${core[0]}.${core[1]}.${core[2] - 1}` : `${core[0]}.${core[1] - 1}.0`;

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-1834-h-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(home, { recursive: true, force: true });
});

function env(id: string, url?: string): string {
  return `FLAIR_AGENT_ID=${id}` + (url ? ` FLAIR_URL=${url}` : "");
}
function claudeForm(id: string, ver: string, url?: string): string {
  return `sh -c 'out=$(${env(id, url)} npx -y -p ${FLAIR_MCP_PACKAGE}@${ver} flair-session-start 2>/dev/null) && printf %s "$out" || true'`;
}
function codexForm(id: string, ver: string, url?: string): string {
  return `sh -c 'out=$(FLAIR_HOOK_HARNESS=codex ${env(id, url)} npx -y -p ${FLAIR_MCP_PACKAGE}@${ver} flair-session-start) && printf %s "$out" || true'`;
}
function bareForm(id: string, ver: string, url?: string): string {
  return `${env(id, url)} npx -y -p ${FLAIR_MCP_PACKAGE}@${ver} flair-session-start`;
}

function writeHook(harness: Harness, commands: string[], meta?: (c: string) => any): string {
  const p = hookSettingsPath(home, harness);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({
    hooks: { SessionStart: [{ hooks: commands.map((c) => (meta ? meta(c) : { type: "command", command: c })) }] },
  }, null, 2) + "\n");
  return p;
}
const path = (h: Harness) => hookSettingsPath(home, h);
const raw = (h: Harness) => readFileSync(path(h), "utf-8");

// ── T11a — duplicate assignments ───────────────────────────────────────────

describe("T11a — duplicate FLAIR_AGENT_ID assignments -> HOLD", () => {
  it("bare form with two assignments is held, byte-identical (base re-pins with the first)", () => {
    const cmd = `FLAIR_AGENT_ID=a FLAIR_AGENT_ID=b npx -y -p ${FLAIR_MCP_PACKAGE}@${OLD} flair-session-start`;
    writeHook("claude-code", [cmd]);
    const before = raw("claude-code");
    const r = repinSessionStartHook(home, "claude-code");
    expect(r.action).toBe("hold");
    expect(raw("claude-code")).toBe(before);
  });

  it("the hold is PRINTED on the upgrade path", () => {
    writeHook("claude-code", [`FLAIR_AGENT_ID=a FLAIR_AGENT_ID=b npx -y -p ${FLAIR_MCP_PACKAGE}@${OLD} flair-session-start`]);
    const r = refreshOwnedPins({ homeDir: home }).find((x) => x.target.kind === "session-start-hook")!;
    expect(r.action).toBe("hold");
    expect(ownedPinRefreshShouldReport(r)).toBe(true);
  });
});

// ── T11b — duplicate matching hook entries ─────────────────────────────────

describe("T11b — duplicate matching hook entries -> HOLD", () => {
  it("two matching entries: neither is silently re-pinned", () => {
    writeHook("claude-code", [claudeForm("a", OLD), claudeForm("a", OLD)]);
    const before = raw("claude-code");
    const r = repinSessionStartHook(home, "claude-code");
    expect(r.action).toBe("hold");
    expect(raw("claude-code")).toBe(before);
  });
});

// ── T11c — extra syntax / unsupported env / unsupported metadata ────────────

describe("T11c — non-installer shapes -> HOLD", () => {
  it("extra shell syntax appended", () => {
    writeHook("claude-code", [claudeForm("a", OLD) + "; curl http://example.invalid"]);
    const before = raw("claude-code");
    const r = repinSessionStartHook(home, "claude-code");
    expect(r.action).toBe("hold");
    expect(raw("claude-code")).toBe(before);
  });

  it("an unsupported env var", () => {
    writeHook("claude-code", [`FLAIR_AGENT_ID=a FLAIR_X=1 npx -y -p ${FLAIR_MCP_PACKAGE}@${OLD} flair-session-start`]);
    const before = raw("claude-code");
    const r = repinSessionStartHook(home, "claude-code");
    expect(r.action).toBe("hold");
    expect(raw("claude-code")).toBe(before);
  });

  it("unsupported hook metadata", () => {
    writeHook("claude-code", [claudeForm("a", OLD)], (c) => ({ type: "command", command: c, timeout: 5 }));
    const before = raw("claude-code");
    const r = repinSessionStartHook(home, "claude-code");
    expect(r.action).toBe("hold");
    expect(raw("claude-code")).toBe(before);
  });
});

// ── T11d — the three valid forms are re-pinned, identity+URL intact ────────

describe("T11d — each valid installer form re-pins, identity and URL intact", () => {
  const cases: Array<[Harness, (id: string, ver: string, url?: string) => string]> = [
    ["claude-code", claudeForm],
    ["codex", codexForm],
    ["claude-code", bareForm],
  ];
  for (const [harness, build] of cases) {
    for (const url of [undefined, "http://127.0.0.1:9926"]) {
      it(`${build === bareForm ? "bare" : harness} form${url ? " with URL" : ""}`, () => {
        const before = build("agent-1", OLD, url);
        writeHook(harness, [before]);
        const r = repinSessionStartHook(home, harness);
        expect(r.action).toBe("update");
        // The command is EXACTLY the same form with only the version changed —
        // the bare form is not re-wrapped, identity and URL are preserved.
        const cmd = JSON.parse(raw(harness)).hooks.SessionStart[0].hooks[0].command as string;
        expect(cmd).toBe(before.replace(`${FLAIR_MCP_PACKAGE}@${OLD}`, CURRENT));
        expect(cmd).toContain(`FLAIR_AGENT_ID=agent-1`);
        if (url) expect(cmd).toContain(`FLAIR_URL=${url}`);
      });
    }
  }
});

// ── T11e — legacy unpinned form is a HOLD in repin ─────────────────────────

describe("T11e — the legacy unpinned (no -p) form -> HOLD", () => {
  it("held, byte-identical (base returns a quiet skip)", () => {
    writeHook("claude-code", [`FLAIR_AGENT_ID=a npx -y ${FLAIR_MCP_PACKAGE} flair-session-start`]);
    const before = raw("claude-code");
    const r = repinSessionStartHook(home, "claude-code");
    expect(r.action).toBe("hold");
    expect(raw("claude-code")).toBe(before);
  });
});
