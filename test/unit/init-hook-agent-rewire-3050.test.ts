import { beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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
 * installer form is a byte-level no-op, the pre-#1007 bare legacy hook is migrated,
 * and an entry Flair cannot identify or a shape outside the installer's is a named
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

function flairCommandWithUrl(agentId: string, url: string): string {
  return buildSessionStartHookCommand(agentId, url, { harness: "claude-code" });
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

  it("re-points the id and re-pins a behind pin in one write, both spans exact", () => {
    // The new id is longer than the old one, so substituting the id span first
    // would shift the pin span the command captured.
    const url = "http://127.0.0.1:19926";
    const behind = flairCommandWithUrl("agent-a", url).replace(mcpServerSpec(), `${FLAIR_MCP_PACKAGE}@0.0.1`);
    expect(behind).not.toBe(flairCommandWithUrl("agent-a", url));
    const settingsPath = writeSettings(hookSettings(behind));
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));

    const result = applyOrRepinSessionStartHook(home, "agent-b-renamed", false);

    expect(result.applied).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("re-pointed");
    expect(result.message).toContain("and re-pinned it");
    before.hooks.SessionStart[1].hooks[0].command = flairCommandWithUrl("agent-b-renamed", url);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(before);
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
    expect(result.message).toContain("carries fields outside the shape Flair's installer writes");
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
    expect(result.message).toContain("carries fields outside the shape Flair's installer writes");
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

describe("repinSessionStartHook — a non-regular settings path", () => {
  it("a directory gets the primitive's refusal, not the precheck's read error", () => {
    mkdirSync(path(), { recursive: true });
    const result = repinSessionStartHook(home, "claude-code", undefined, { agentId: "agent-b" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("is not a regular file");
    expect(result.backupPath).toBeNull();
    expect(readdirSync(path())).toEqual([]);
    expect(settingsDirFiles()).toBe("settings.json");
  });

  it("a FIFO gets the primitive's refusal without blocking on a read", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const made = spawnSync("mkfifo", [path()], { encoding: "utf8", timeout: 5_000 });
    expect(made.status).toBe(0); // a missing mkfifo must fail the case, not skip it
    // A child with its own deadline: a read of the FIFO would block it until killed.
    const script = `const { repinSessionStartHook } = await import(${JSON.stringify(join(import.meta.dir, "../../src/hook-install.ts"))});\n` +
      `console.log(JSON.stringify(repinSessionStartHook(process.env.FIXTURE_HOME, "claude-code", undefined, { agentId: "agent-b" })));`;
    const child = spawnSync(process.execPath, ["-e", script], {
      env: { PATH: process.env.PATH ?? "", HOME: home, FIXTURE_HOME: home },
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("is not a regular file");
    expect(result.backupPath).toBeNull();
    expect(settingsDirFiles()).toBe("settings.json");
  }, 30_000);
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
  // Install replaces the first marker match; a later custom hook naming the marker is not its source.
  const custom = `echo ${SESSION_START_HOOK_MARKER} && echo custom`;
  for (const dryRun of [false, true]) {
    it(`validates the hook it replaces, not a later custom marker hook, dryRun=${dryRun}`, () => {
      const settingsPath = writeSettings({ hooks: { SessionStart: [
        { hooks: [{ type: "command", command: flairCommand("agent-a") }] },
        { hooks: [{ type: "command", command: custom }] },
      ] } });
      const before = readFileSync(settingsPath, "utf8");
      const result = installHook({ homeDir: home, harness: "claude-code", agentId: "agent-b", flairUrl: "http://localhost:19926", dryRun });
      expect(result.ok).toBe(true);
      expect(result.delta?.action).toBe("update");
      const groups = JSON.parse(readFileSync(settingsPath, "utf8")).hooks.SessionStart;
      if (dryRun) expect(readFileSync(settingsPath, "utf8")).toBe(before);
      else expect(groups[0].hooks[0].command).toContain("FLAIR_AGENT_ID=agent-b");
      expect(groups[1]).toEqual({ hooks: [{ type: "command", command: custom }] });
    });
    it(`still refuses when the hook it would replace is the custom one, dryRun=${dryRun}`, () => {
      const settingsPath = writeSettings({ hooks: { SessionStart: [
        { hooks: [{ type: "command", command: custom }] },
        { hooks: [{ type: "command", command: flairCommand("agent-a") }] },
      ] } });
      const before = readFileSync(settingsPath, "utf8");
      const result = installHook({ homeDir: home, harness: "claude-code", agentId: "agent-b", flairUrl: "http://localhost:19926", dryRun });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not a command form Flair's installer recognizes");
      expect(readFileSync(settingsPath, "utf8")).toBe(before);
      expect(settingsDirFiles()).toBe("settings.json");
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
