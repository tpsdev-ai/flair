import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SESSION_START_HOOK_MARKER,
  buildSessionStartHookCommand,
  checkSessionStartHook,
  classifyHookProbe,
  fixSessionStartHook,
  hookCommandIsSilenced,
  inspectSessionStartHook,
  upgradeSessionStartHookCommand,
  type HookProbeOutcome,
} from "../../src/doctor-client.ts";

/**
 * flair#1007 — `flair doctor` must detect a registered hook whose command no
 * longer resolves.
 *
 * The entry that broke a real machine was perfectly well-formed; doctor's
 * pre-#1007 check (is the hook PRESENT?) passed on it every time. The check
 * that was missing is whether the command it names can still execute — so
 * these tests cover the pure classification AND a real end-to-end probe under
 * a PATH where the command genuinely cannot resolve.
 *
 * Never touches the real ~/.claude/settings.json: every case gets a fresh temp
 * dir standing in for HOME, mirroring doctor-client.test.ts.
 */

const LEGACY_COMMAND = `FLAIR_AGENT_ID=me npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}`;
const LEGACY_COMMAND_WITH_URL = `FLAIR_AGENT_ID=me FLAIR_URL=http://127.0.0.1:19926 npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}`;

let isoHome: string;

function settingsPath(): string {
  return join(isoHome, ".claude", "settings.json");
}

function writeSettings(config: unknown): void {
  mkdirSync(join(isoHome, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(config, null, 2) + "\n");
}

function writeHook(command: string): void {
  writeSettings({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });
}

function readHookCommands(): string[] {
  const config = JSON.parse(readFileSync(settingsPath(), "utf-8"));
  return (config.hooks?.SessionStart ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
}

function outcome(partial: Partial<HookProbeOutcome>): HookProbeOutcome {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, spawnError: null, ...partial };
}

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-hook-probe-home-"));
});

afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
});

describe("checkSessionStartHook now returns the command", () => {
  it("hands back the registered command so it can be verified, not just counted", () => {
    writeHook(LEGACY_COMMAND);
    const res = checkSessionStartHook(isoHome);
    expect(res.present).toBe(true);
    expect(res.command).toBe(LEGACY_COMMAND);
  });

  it("no command when nothing is wired", () => {
    expect(checkSessionStartHook(isoHome).command).toBeUndefined();
  });
});

describe("classifyHookProbe", () => {
  it("non-zero exit is broken, and carries the first stderr line as evidence", () => {
    const v = classifyHookProbe(outcome({ exitCode: 1, stderr: "mise ERROR No version is set for shim: flair-session-start\n" }));
    expect(v.execution).toBe("broken");
    expect(v.detail).toContain("mise ERROR No version is set for shim");
  });

  it("skips package-manager chatter when picking the evidence line", () => {
    // The harness reports the FIRST stderr line, which on a modern npm is a
    // notice rather than the failure. Measured on a real machine, the stderr
    // of a broken invocation began:
    //   npm notice run @tpsdev-ai/flair@0.33.0 npx
    //   npm notice run 'flair-mcp' flair-session-start
    //   sh: flair-mcp: command not found
    // Repeating line 1 back to the user would reproduce the exact defect this
    // issue is about: a message that names neither the cause nor a remedy.
    const v = classifyHookProbe(
      outcome({
        exitCode: 127,
        stderr: "npm notice run @tpsdev-ai/flair@0.33.0 npx\nnpm notice run 'flair-mcp' flair-session-start\nsh: flair-mcp: command not found\n",
      }),
    );
    expect(v.execution).toBe("broken");
    expect(v.detail).toContain("flair-mcp: command not found");
    expect(v.detail).not.toContain("npm notice");
  });

  it("falls back to the first line when every line is chatter", () => {
    const v = classifyHookProbe(outcome({ exitCode: 1, stderr: "npm warn something\nnpm notice else\n" }));
    expect(v.detail).toContain("npm warn something");
  });

  it("exit 0 with NO output is broken — that is the silenced wrapper swallowing a command that never ran", () => {
    const v = classifyHookProbe(outcome({ exitCode: 0, stdout: "" }));
    expect(v.execution).toBe("broken");
    expect(v.detail).toContain("never ran");
  });

  it("exit 0 with output is a working hook", () => {
    expect(classifyHookProbe(outcome({ exitCode: 0, stdout: "{}" })).execution).toBe("runs");
  });

  it("a timeout is UNKNOWN, never broken — a slow npx must not be reported as a broken hook", () => {
    expect(classifyHookProbe(outcome({ timedOut: true, exitCode: null })).execution).toBe("unknown");
  });

  it("a probe that could not be spawned is unknown", () => {
    expect(classifyHookProbe(outcome({ spawnError: "EACCES", exitCode: null })).execution).toBe("unknown");
  });
});

describe("inspectSessionStartHook (injected probe)", () => {
  const brokenRunner = () => outcome({ exitCode: 127, stderr: "sh: npx: command not found" });
  const workingRunner = () => outcome({ exitCode: 0, stdout: "{}" });

  it("reports a wired-but-unresolvable hook as broken", () => {
    writeHook(buildSessionStartHookCommand("me"));
    const res = inspectSessionStartHook(isoHome, { probe: brokenRunner });
    expect(res.present).toBe(true);
    expect(res.ours).toBe(true);
    expect(res.execution).toBe("broken");
  });

  it("reports the legacy command as ours, upgradable and NOT silenced", () => {
    writeHook(LEGACY_COMMAND);
    const res = inspectSessionStartHook(isoHome, { probe: workingRunner });
    expect(res.execution).toBe("runs");
    expect(res.silenced).toBe(false);
    expect(res.upgradable).toBe(true);
  });

  it("reports the current command as silenced and not upgradable (nothing to do)", () => {
    writeHook(buildSessionStartHookCommand("me", "http://127.0.0.1:19926"));
    const res = inspectSessionStartHook(isoHome, { probe: workingRunner });
    expect(res.execution).toBe("runs");
    expect(res.silenced).toBe(true);
    expect(res.upgradable).toBe(false);
  });

  it("never runs a command that is not ours", () => {
    // A hook carrying the marker but not our invocation belongs to the user.
    writeHook(`my-own-${SESSION_START_HOOK_MARKER}-script.sh`);
    let called = false;
    const res = inspectSessionStartHook(isoHome, {
      probe: () => {
        called = true;
        return workingRunner();
      },
    });
    expect(called).toBe(false);
    expect(res.present).toBe(true);
    expect(res.ours).toBe(false);
    expect(res.execution).toBeNull();
  });

  it("absent hook is reported absent and never probed", () => {
    const res = inspectSessionStartHook(isoHome, { probe: () => { throw new Error("must not probe"); } });
    expect(res.present).toBe(false);
    expect(res.execution).toBeNull();
  });
});

describe("inspectSessionStartHook — REAL probe against a command that cannot resolve", () => {
  // This is the defect end to end: a well-formed settings entry whose command
  // stopped resolving. Simulated by a PATH carrying `sh` and nothing else, so
  // "npx is not resolvable" is true by construction rather than by hoping the
  // ambient PATH lacks it. No global install is performed or required.
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "flair-hook-probe-bin-"));
    symlinkSync("/bin/sh", join(binDir, "sh"));
    originalPath = process.env.PATH;
    process.env.PATH = binDir;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  function installFakeNpx(body: string): void {
    const p = join(binDir, "npx");
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }

  it("POSITIVE CONTROL: with a resolvable adapter the very same check says 'runs'", () => {
    // Without this the 'broken' assertions below would also pass if the probe
    // were simply always reporting failure.
    installFakeNpx("#!/bin/sh\nprintf '%s' '{}'\n");
    writeHook(buildSessionStartHookCommand("me"));
    expect(inspectSessionStartHook(isoHome, { timeoutMs: 20_000 }).execution).toBe("runs");
  });

  it("the CURRENT (silenced) command that cannot resolve is reported broken", () => {
    writeHook(buildSessionStartHookCommand("me"));
    const res = inspectSessionStartHook(isoHome, { timeoutMs: 20_000 });
    expect(res.execution).toBe("broken");
    expect(res.detail).toContain("never ran");
  });

  it("the LEGACY command that cannot resolve is reported broken, with the shell's own error as evidence", () => {
    writeHook(LEGACY_COMMAND);
    const res = inspectSessionStartHook(isoHome, { timeoutMs: 20_000 });
    expect(res.execution).toBe("broken");
    expect(res.detail).toContain("npx");
  });

  it("a resolver that exits non-zero is broken, not 'runs'", () => {
    installFakeNpx("#!/bin/sh\necho 'boom' >&2\nexit 1\n");
    writeHook(LEGACY_COMMAND);
    expect(inspectSessionStartHook(isoHome, { timeoutMs: 20_000 }).execution).toBe("broken");
  });

  it("the probe sets FLAIR_HOOK_PROBE, so a real adapter answers without side effects", () => {
    // Proven by having the stub refuse to produce output unless the variable
    // is set — the same contract session-start-hook.ts honours.
    installFakeNpx('#!/bin/sh\nif [ -n "$FLAIR_HOOK_PROBE" ]; then printf \'%s\' \'{}\'; else printf \'%s\' \'SIDE_EFFECTS_RAN\'; fi\n');
    writeHook(buildSessionStartHookCommand("me"));
    expect(inspectSessionStartHook(isoHome, { timeoutMs: 20_000 }).execution).toBe("runs");

    // And the control: without probe mode the stub would have produced the
    // other branch, so the assertion above is not vacuous.
    const direct = Bun.spawnSync(["/bin/sh", "-c", buildSessionStartHookCommand("me")], {
      env: { PATH: binDir, HOME: isoHome },
    });
    expect(new TextDecoder().decode(direct.stdout)).toBe("SIDE_EFFECTS_RAN");
  });
});

describe("fixSessionStartHook writes a command that fails silently", () => {
  it("the freshly written hook is silenced and still recognised by doctor's own check", () => {
    const res = fixSessionStartHook(isoHome, "me");
    expect(res.ok).toBe(true);
    const [command] = readHookCommands();
    expect(hookCommandIsSilenced(command!)).toBe(true);
    expect(checkSessionStartHook(isoHome).present).toBe(true);
  });

  it("refuses an agent id that cannot be written safely into a shell command", () => {
    const res = fixSessionStartHook(isoHome, "me'; touch /tmp/pwned; #");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("cannot be safely written");
  });
});

describe("upgradeSessionStartHookCommand — repair, never removal", () => {
  it("rewrites the legacy command in place, keeping the agent it already names", () => {
    writeHook(`FLAIR_AGENT_ID=flint npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}`);
    const res = upgradeSessionStartHookCommand(isoHome);
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    const [command] = readHookCommands();
    expect(command).toContain("FLAIR_AGENT_ID=flint");
    expect(hookCommandIsSilenced(command!)).toBe(true);
  });

  it("preserves FLAIR_URL, so an upgrade never re-points a hook at a different instance", () => {
    writeHook(LEGACY_COMMAND_WITH_URL);
    upgradeSessionStartHookCommand(isoHome);
    const [command] = readHookCommands();
    expect(command).toContain("FLAIR_URL=http://127.0.0.1:19926");
  });

  it("is idempotent — a second run reports no change", () => {
    writeHook(LEGACY_COMMAND);
    expect(upgradeSessionStartHookCommand(isoHome).changed).toBe(true);
    const after = readHookCommands();
    const second = upgradeSessionStartHookCommand(isoHome);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(readHookCommands()).toEqual(after);
  });

  it("REFUSES a hand-edited hook — a command the user wrote is theirs", () => {
    const handEdited = `FLAIR_AGENT_ID=me npx -y @tpsdev-ai/flair-mcp@0.33.0 ${SESSION_START_HOOK_MARKER}`;
    writeHook(handEdited);
    const res = upgradeSessionStartHookCommand(isoHome);
    expect(res.ok).toBe(false);
    expect(res.changed).toBe(false);
    expect(readHookCommands()).toEqual([handEdited]);
  });

  it("never removes the hook, and never disturbs siblings or unrelated keys", () => {
    writeSettings({
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "unrelated-session-hook" }] },
          { hooks: [{ type: "command", command: LEGACY_COMMAND }] },
        ],
        PreToolUse: [{ hooks: [{ type: "command", command: "other" }] }],
      },
    });
    expect(upgradeSessionStartHookCommand(isoHome).changed).toBe(true);

    const config = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    expect(config.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(config.hooks.PreToolUse).toEqual([{ hooks: [{ type: "command", command: "other" }] }]);
    expect(config.hooks.SessionStart).toHaveLength(2);
    expect(config.hooks.SessionStart[0].hooks[0].command).toBe("unrelated-session-hook");
    expect(hookCommandIsSilenced(config.hooks.SessionStart[1].hooks[0].command)).toBe(true);
    expect(checkSessionStartHook(isoHome).present).toBe(true);
  });

  it("reports rather than throws when there is nothing to upgrade", () => {
    const res = upgradeSessionStartHookCommand(isoHome);
    expect(res.ok).toBe(false);
    expect(res.changed).toBe(false);
  });
});
