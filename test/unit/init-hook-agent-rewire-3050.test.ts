import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyOrRepinSessionStartHook } from "../../src/lib/owned-pins.ts";
import { hookSettingsPath, repinSessionStartHook, installHook, guardedPinSpan } from "../../src/hook-install.ts";
import { buildSessionStartHookCommand, SESSION_START_HOOK_MARKER, upgradeSessionStartHookCommand, inspectSessionStartHook } from "../../src/doctor-client.ts";
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

/** List the settings directory for the refusal assertions below. */
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

  it("refuses a legacy URL the builder cannot interpolate, writes nothing (no .bak)", () => {
    const command = `FLAIR_AGENT_ID=agent-a FLAIR_URL=http://127.0.0.1:1234?x=1 npx -y ${FLAIR_MCP_PACKAGE} flair-session-start`;
    const settingsPath = writeSettings(hookSettings(command));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-a", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Flair URL");
    expect(result.message).toContain("cannot be safely written");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("refuses a legacy agent id the builder cannot interpolate, writes nothing (no .bak)", () => {
    const command = `FLAIR_AGENT_ID=agent?x npx -y ${FLAIR_MCP_PACKAGE} flair-session-start`;
    const settingsPath = writeSettings(hookSettings(command));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent?x", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("agent id");
    expect(result.message).toContain("cannot be safely written");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("refuses a chained legacy command by name, writes nothing (no .bak)", () => {
    // The chain is attached to the value, so a loose `[^\s'"]+` would read it
    // as the agent id. It is not Flair's bare shape either way.
    const command = `FLAIR_AGENT_ID=agent-a&& npx -y ${FLAIR_MCP_PACKAGE} flair-session-start`;
    const settingsPath = writeSettings(hookSettings(command));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-a", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("could not read the agent id");
    expect(result.message).toContain("left untouched");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("refuses an installer URL the builder cannot interpolate, writes nothing (no .bak)", () => {
    const command = `FLAIR_AGENT_ID=agent-a FLAIR_URL=http://127.0.0.1:1234?x=1 npx -y -p ${mcpServerSpec()} ${SESSION_START_HOOK_MARKER}`;
    const settingsPath = writeSettings(hookSettings(command));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-a", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Flair URL");
    expect(result.message).toContain("cannot be safely written");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("refuses an installer agent id the builder cannot interpolate, writes nothing (no .bak)", () => {
    const command = `FLAIR_AGENT_ID=agent?x npx -y -p ${mcpServerSpec()} ${SESSION_START_HOOK_MARKER}`;
    const settingsPath = writeSettings(hookSettings(command));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent?x", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("agent id");
    expect(result.message).toContain("cannot be safely written");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("refuses an installer command extended with another command, writes nothing (no .bak)", () => {
    const command = `FLAIR_AGENT_ID=agent-a npx -y -p ${mcpServerSpec()} ${SESSION_START_HOOK_MARKER}; echo extra`;
    const settingsPath = writeSettings(hookSettings(command));
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-a", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("could not read the agent id");
    expect(result.message).toContain("left untouched");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });
});

describe("applyOrRepinSessionStartHook — the group shape and a non-installer pin", () => {
  it("refuses a group holding a second hook even when the id matches (no .bak)", () => {
    const settingsPath = writeSettings({
      theme: "dark",
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: flairCommand("agent-a") }, { type: "command", command: "unrelated-session-hook" }] },
        ],
      },
    });
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOrRepinSessionStartHook(home, "agent-a", false);

    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("holds more than the one entry");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  for (const tag of ["@latest", "@^0.62.0"]) {
    it(`refuses a non-installer hook pinned with ${tag} by name (no .bak)`, () => {
      const command = `FLAIR_AGENT_ID=agent-a npx -y -p ${FLAIR_MCP_PACKAGE}${tag} ${SESSION_START_HOOK_MARKER}`;
      const settingsPath = writeSettings(hookSettings(command));
      const before = readFileSync(settingsPath, "utf-8");

      const result = applyOrRepinSessionStartHook(home, "agent-a", false);

      expect(result.applied).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not one of the installer forms");
      expect(readFileSync(settingsPath, "utf-8")).toBe(before);
      expect(settingsDirFiles()).toBe("settings.json");
    });
  }
});

describe("repinSessionStartHook — a refusal after the precheck takes no backup", () => {
  it("a file changed between the precheck and the lock is refused, no .bak, file unchanged", () => {
    const settingsPath = writeSettings(hookSettings(flairCommand("agent-a")));
    const malformed = "{ not valid json, changed after the precheck";
    let mutated = false;

    const result = repinSessionStartHook(
      home,
      "claude-code",
      { afterPreObserve: () => { if (!mutated) { mutated = true; writeFileSync(settingsPath, malformed); } } },
      { agentId: "agent-b" },
    );

    expect(mutated).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("hold");
    expect(result.message).toContain("refusing to re-pin");
    expect(result.backupPath).toBeNull();
    expect(readFileSync(settingsPath, "utf-8")).toBe(malformed);
    expect(settingsDirFiles()).toBe("settings.json");
  });
});


describe("SessionStart source commands", () => {
  for (const form of ["legacy", "installer"]) {
    const commandFor = (agent: string, url?: string) =>
      `FLAIR_AGENT_ID=${agent}${url ? ` FLAIR_URL=${url}` : ""} npx -y ${form === "legacy" ? FLAIR_MCP_PACKAGE : `-p ${mcpServerSpec()}`} ${SESSION_START_HOOK_MARKER}`;
    for (const extension of [" && echo extra", "; echo extra", " | echo extra", " echo extra"]) {
      it(`refuses an extended ${form} command: ${extension}`, () => {
        const settingsPath = writeSettings(hookSettings(commandFor("agent-a") + extension));
        const before = readFileSync(settingsPath, "utf8");
        for (const result of [
          applyOrRepinSessionStartHook(home, "agent-b", false),
          repinSessionStartHook(home, "claude-code", undefined, { agentId: "agent-b" }),
        ]) {
          expect(result.ok).toBe(false);
          expect(result.message).toContain(settingsPath);
        }
        expect(readFileSync(settingsPath, "utf8")).toBe(before);
        expect(settingsDirFiles()).toBe("settings.json");
      });
    }
    for (const [agent, url] of [["agent?x", undefined], ["agent-a", "http://127.0.0.1:1234?x=1"]]) {
      it(`refuses unsafe existing ${form} values before a different requested id`, () => {
        const settingsPath = writeSettings(hookSettings(commandFor(agent!, url)));
        const before = readFileSync(settingsPath, "utf8");
        for (const result of [
          applyOrRepinSessionStartHook(home, "agent-b", false),
          repinSessionStartHook(home, "claude-code", undefined, { agentId: "agent-b" }),
        ]) {
          expect(result.ok).toBe(false);
          expect(result.message).toContain("cannot be safely written");
        }
        expect(readFileSync(settingsPath, "utf8")).toBe(before);
        expect(settingsDirFiles()).toBe("settings.json");
      });
    }
  }
  it("refuses a legacy chain attached to its source assignment", () => {
    const settingsPath = writeSettings(hookSettings(legacyCommand("agent-a&&")));
    const before = readFileSync(settingsPath, "utf8");
    expect(applyOrRepinSessionStartHook(home, "agent-b", false).ok).toBe(false);
    expect(repinSessionStartHook(home, "claude-code", undefined, { agentId: "agent-b" }).ok).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    expect(settingsDirFiles()).toBe("settings.json");
  });
});

describe("hook install source guards", () => {
  const commands = [
    `echo decoy && FLAIR_AGENT_ID=agent-a npx -y -p ${mcpServerSpec()} flair-session-start`,
    `FLAIR_AGENT_ID=agent-a&& npx -y -p ${mcpServerSpec()} flair-session-start`,
    `FLAIR_AGENT_ID=bad@id npx -y -p ${mcpServerSpec()} flair-session-start`,
    `FLAIR_AGENT_ID=agent-a FLAIR_URL=http://bad?query npx -y -p ${mcpServerSpec()} flair-session-start`,
    legacyCommand("bad@id"),
    `FLAIR_AGENT_ID=agent-a FLAIR_URL=http://bad?query npx -y ${FLAIR_MCP_PACKAGE} flair-session-start`,
  ];
  for (const command of commands) {
    for (const dryRun of [false, true]) {
      it(`refuses install source ${JSON.stringify(command)} dryRun=${dryRun}`, () => {
        const settingsPath = writeSettings(hookSettings(command));
        const before = readFileSync(settingsPath, "utf8");
        const files = settingsDirFiles();
        const result = installHook({ homeDir: home, harness: "claude-code", agentId: "agent-b", flairUrl: "http://localhost:19926", dryRun });
        expect(result.ok).toBe(false);
        expect(readFileSync(settingsPath, "utf8")).toBe(before);
        expect(settingsDirFiles()).toBe(files);
        expect(result.backupPath).toBeNull();
      });
    }
  }
  for (const command of [flairCommand("agent-a"), legacyCommand("agent-a")]) {
    it(`installs over a safe source ${JSON.stringify(command)}`, () => {
      const settingsPath = writeSettings(hookSettings(command));
      expect(installHook({ homeDir: home, harness: "claude-code", agentId: "agent-b", flairUrl: "http://localhost:19926" }).ok).toBe(true);
      expect(flairHookCommand(settingsPath)).toContain("FLAIR_AGENT_ID=agent-b");
    });
  }
});

describe("doctor hook repair source guards", () => {
  for (const command of [
    legacyCommand("bad@id"),
    `FLAIR_AGENT_ID=agent-a FLAIR_URL=http://bad?query npx -y ${FLAIR_MCP_PACKAGE} flair-session-start`,
    `FLAIR_AGENT_ID=agent-a&& npx -y ${FLAIR_MCP_PACKAGE} flair-session-start`,
    flairCommand("agent-a").replace("agent-a", "bad@id"),
    buildSessionStartHookCommand("agent-a", "http://localhost:19926").replace("http://localhost:19926", "http://bad?query"),
    flairCommand("agent-a") + " && echo extra",
    "echo flair-session-start || true",
  ]) {
    it(`refuses repair and does not offer upgrade for ${JSON.stringify(command)}`, () => {
      const settingsPath = writeSettings(hookSettings(command));
      const before = readFileSync(settingsPath, "utf8");
      const files = settingsDirFiles();
      expect(inspectSessionStartHook(home, { probe: false }).upgradable).toBe(false);
      const result = upgradeSessionStartHookCommand(home);
      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(readFileSync(settingsPath, "utf8")).toBe(before);
      expect(settingsDirFiles()).toBe(files);
    });
  }
  it("offers and repairs a safe legacy source", () => {
    const settingsPath = writeSettings(hookSettings(legacyCommand("agent-a")));
    expect(inspectSessionStartHook(home, { probe: false }).upgradable).toBe(true);
    expect(upgradeSessionStartHookCommand(home).changed).toBe(true);
    expect(flairHookCommand(settingsPath)).toBe(flairCommand("agent-a"));
    expect(upgradeSessionStartHookCommand(home).ok).toBe(true);
  });
});

it("the install pin reader does not take a pin from a chain", () => {
  expect(guardedPinSpan(`echo first && FLAIR_AGENT_ID=agent-a npx -y -p ${mcpServerSpec()} flair-session-start`)).toBe(`${FLAIR_MCP_PACKAGE}@unknown`);
});
