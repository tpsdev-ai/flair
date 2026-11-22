import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyOrRepinSessionStartHook } from "../../src/lib/owned-pins.ts";
import { hookSettingsPath } from "../../src/hook-install.ts";
import { buildSessionStartHookCommand, SESSION_START_HOOK_MARKER } from "../../src/doctor-client.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import { tempDir } from "../helpers/temp-dir.ts";

/**
 * flair#3050 round 2 — `flair init --agent agent-b` after an earlier init wired
 * agent-a must also move the SessionStart hook, not only the MCP configs.
 *
 * `flair init` applies this leg through `applyOrRepinSessionStartHook`
 * (src/lib/owned-pins.ts); a present hook used to report "already wired"
 * without reading the FLAIR_AGENT_ID it embeds. The unit cases pin the writer's
 * boundaries: the requested id is written, a same-id apply on the current
 * installer form is a byte-level no-op, a legacy unpinned hook is migrated, and
 * an entry Flair cannot identify or a shape it did not write is a named
 * refusal that writes nothing (no backup either).
 */

let home: string;

beforeEach(() => {
  home = tempDir("flair-hook-rewire-");
});

function path(): string {
  return hookSettingsPath(home, "claude-code");
}

function writeSettings(settings: unknown): string {
  const settingsPath = path();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return settingsPath;
}

function flairCommand(agentId: string): string {
  return buildSessionStartHookCommand(agentId, undefined, { harness: "claude-code" });
}

/** The pre-#1007 unpinned shape Flair wrote. */
function legacyCommand(agentId: string): string {
  return `FLAIR_AGENT_ID=${agentId} npx -y ${FLAIR_MCP_PACKAGE} flair-session-start`;
}

/** Every file in the settings directory — a refusal must add NOTHING (no .bak). */
function settingsDirFiles(): string {
  return readdirSync(join(home, ".claude")).sort().join(",");
}

function hookSettings(command: string, groupExtras: Record<string, unknown> = {}): unknown {
  return {
    theme: "dark",
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "unrelated-session-hook" }] },
        { ...groupExtras, hooks: [{ type: "command", command }] },
      ],
    },
  };
}

function flairHookCommand(settingsPath: string): string {
  const config = JSON.parse(readFileSync(settingsPath, "utf-8"));
  const commands = config.hooks.SessionStart.flatMap((g: any) =>
    (g.hooks ?? []).map((h: any) => h.command)
  );
  const command = commands.find((c: string) => c.includes(SESSION_START_HOOK_MARKER));
  expect(command).toBeDefined();
  return command;
}

describe("applyOrRepinSessionStartHook — agent rewire", () => {
  it("rewrites a present hook from agent-a to agent-b and leaves other hooks alone", () => {
    const settingsPath = writeSettings(hookSettings(flairCommand("agent-a")));
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));

    const result = applyOrRepinSessionStartHook(home, "agent-b", false);

    expect(result.applied).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("agent 'agent-b'");
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(flairHookCommand(settingsPath)).toContain("FLAIR_AGENT_ID=agent-b");
    expect(flairHookCommand(settingsPath)).not.toContain("FLAIR_AGENT_ID=agent-a");
    // The unrelated SessionStart hook and every other key are unchanged.
    expect(JSON.stringify(after.hooks.SessionStart[0])).toBe(
      JSON.stringify(before.hooks.SessionStart[0]),
    );
    expect(after.theme).toBe("dark");
  });

  it("reports already wired with unchanged bytes when the agent id matches", () => {
    const settingsPath = writeSettings(hookSettings(flairCommand("agent-a")));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-a", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("already wired");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("refuses by name and writes nothing when the Flair entry is not parseable", () => {
    const command = `FLAIR_AGENT_ID=agent-a npx -y -p ${mcpServerSpec()} ${SESSION_START_HOOK_MARKER} && echo extra`;
    const settingsPath = writeSettings(hookSettings(command));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-b", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("could not read the agent id");
    expect(result.message).toContain("left untouched");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("refuses by name and writes nothing when the Flair entry carries a foreign shape", () => {
    const settingsPath = writeSettings(
      hookSettings(flairCommand("agent-a"), { matcher: "*" }),
    );
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-b", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("carries fields Flair did not write");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("refuses a foreign shape before the no-op when the id already matches and the pin is current", () => {
    const settingsPath = writeSettings(
      hookSettings(flairCommand("agent-a"), { matcher: "*" }),
    );
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-a", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("carries fields Flair did not write");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("refuses an unsafe agent id by name and writes nothing (no .bak)", () => {
    const settingsPath = writeSettings(hookSettings(flairCommand("agent-a")));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "bad'id;echo", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("cannot be safely written");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("refuses --skip-hook on a different embedded id, names it, and writes nothing (no .bak)", () => {
    const settingsPath = writeSettings(hookSettings(flairCommand("agent-a")));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-b", true);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("names agent 'agent-a'");
    expect(result.message).toContain("--skip-hook");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });
});

describe("applyOrRepinSessionStartHook — the pre-#1007 legacy form is migrated", () => {
  it("same id: migrates the unpinned legacy command to the pinned installer form", () => {
    const settingsPath = writeSettings(hookSettings(legacyCommand("agent-a")));

    const result = applyOrRepinSessionStartHook(home, "agent-a", false);

    expect(result.applied).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain(`pinned the SessionStart hook in ${settingsPath} to ${mcpServerSpec()}`);
    expect(flairHookCommand(settingsPath)).toBe(flairCommand("agent-a"));
  });

  it("different id: migrates and re-points to the requested id", () => {
    const settingsPath = writeSettings(hookSettings(legacyCommand("agent-a")));

    const result = applyOrRepinSessionStartHook(home, "agent-b", false);

    expect(result.applied).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("agent 'agent-b'");
    expect(result.message).toContain(`pinned it to ${mcpServerSpec()}`);
    expect(flairHookCommand(settingsPath)).toBe(flairCommand("agent-b"));
  });
});
