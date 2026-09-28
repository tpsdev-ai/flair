import { expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  buildContinuityCaptureHookCommand,
  buildSessionStartHookCommand,
  checkContinuityCaptureHooks,
  CONTINUITY_CAPTURE_HOOK_MARKER,
  CONTINUITY_POST_TOOL_USE_MATCHER,
} from "../../src/doctor-client.ts";
import { mcpServerSpec } from "../../src/lib/mcp-spec.ts";

const root = join(import.meta.dir, "../..");
const cli = join(root, "src/cli.ts");
const agent = "fixture";
const url = "http://127.0.0.1:9";
const manual = "Resolve the listed non-version pin(s) manually; doctor cannot rewrite them.";
const events = ["PostToolUse", "Stop"] as const;
const cases = [
  [null, null],
  ["1.2.3", null],
  ["1.2.3-rc.1+build", null],
  ["latest", "range-or-tag"],
  ["^1.2.3", "range-or-tag"],
  ["file:adapter", "unsupported"],
  ["v1.2.3", "malformed"],
] as const;

type Completion = Pick<SpawnSyncReturns<string>, "error" | "signal" | "status">;

function assertCompleted(result: Completion): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect([0, 1]).toContain(result.status ?? -1);
}

interface HookGroup {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

function fixture(postToolUse: string | null, stop: string | null) {
  const home = realpathSync(tempDir("flair-doctor-1819-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  // No ambient executables: npm/npx cannot fetch, and lsof cannot see host ports.
  for (const name of ["claude", "lsof"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  for (const name of ["npm", "npx"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  symlinkSync("/bin/sh", join(bin, "sh"));
  mkdirSync(join(home, ".claude"));
  const hooks: Record<string, HookGroup[]> = {
    SessionStart: [{
      hooks: [{ type: "command", command: buildSessionStartHookCommand(agent, url) }],
    }],
  };
  if (postToolUse !== null) {
    hooks.PostToolUse = [{
      matcher: CONTINUITY_POST_TOOL_USE_MATCHER,
      hooks: [{ type: "command", command: postToolUse }],
    }];
  }
  if (stop !== null) {
    hooks.Stop = [{ hooks: [{ type: "command", command: stop }] }];
  }
  const settings = join(home, ".claude/settings.json");
  const bytes = JSON.stringify({ hooks });
  writeFileSync(settings, bytes);
  // Keep unrelated --fix work from adding a SessionStart hook to settings.json.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: {
      flair: {
        command: "npx",
        args: ["-y", mcpServerSpec()],
        env: { FLAIR_AGENT_ID: agent, FLAIR_URL: url },
      },
    },
  }));
  writeFileSync(join(home, "CLAUDE.md"), "Run mcp__flair__bootstrap at session start.\n");
  const offline = join(home, "offline.cjs");
  writeFileSync(offline, "globalThis.fetch = async () => { throw new Error('offline fixture'); };\n");
  function run(args: string[]): string {
    const result = spawnSync(process.execPath, ["--preload", offline, cli, ...args], {
      cwd: home,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: home,
        TMPDIR: home,
        PATH: bin,
        NO_COLOR: "1",
      },
    });
    assertCompleted(result);
    return result.stdout;
  }
  return {
    home,
    settings,
    bytes,
    run,
    doctor: (args: string[] = []) => run(["doctor", "--port", "9", "--agent", agent, ...args]),
  };
}

function outputLine(stdout: string, marker: string): string {
  const line = stdout.split("\n").find((value) => value.includes(marker)) ?? "";
  expect(line).toContain(marker);
  return line;
}

function doctorBlock(stdout: string): string {
  const lines = stdout.split("\n");
  const index = lines.findIndex((line) => line.includes("Continuity capture hooks:"));
  expect(index).toBeGreaterThanOrEqual(0);
  return lines.slice(index, index + 2).join("\n");
}

function command(pin: string | null = null): string {
  return buildContinuityCaptureHookCommand(agent, url, pin);
}

test("R2 exit guard rejects null and accepts only normal doctor exits", () => {
  for (const status of [0, 1]) {
    expect(() => assertCompleted({ status, signal: null })).not.toThrow();
  }
  expect(() => assertCompleted({ status: null, signal: null })).toThrow();
  expect(() => assertCompleted({ status: 2, signal: null })).toThrow();
  expect(() => assertCompleted({ status: 0, signal: "SIGTERM" })).toThrow();
  expect(() => assertCompleted({ status: 0, signal: null, error: new Error("spawn failed") })).toThrow();
});

for (const event of events) {
  for (const [pin, kind] of cases) {
    test("doctor continuity " + event + " " + pin, () => {
      const f = fixture(
        command(event === "PostToolUse" ? pin : "1.2.3"),
        command(event === "Stop" ? pin : "1.2.3"),
      );
      const stdout = f.doctor();
      const line = outputLine(stdout, "Continuity capture hooks:");
      expect(line).toContain(kind ? "Continuity capture hooks: stale" : "Continuity capture hooks: PostToolUse + Stop wired");
      if (kind) {
        expect(line).toContain(event + " pin " + kind + ": " + pin);
        expect(doctorBlock(stdout)).toContain(manual);
        expect(doctorBlock(stdout)).not.toContain("flair doctor --fix");
      }
      expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
    }, 25_000);
  }

  test("R2 missing package stays a shape diagnosis " + event, () => {
    const missing = "sh -c 'FLAIR_AGENT_ID=fixture " + CONTINUITY_CAPTURE_HOOK_MARKER + " >/dev/null 2>/dev/null || true'";
    const f = fixture(event === "PostToolUse" ? missing : command(), event === "Stop" ? missing : command());
    const report = checkContinuityCaptureHooks(f.home);
    const entry = event === "PostToolUse" ? report.postToolUse : report.stop;
    expect(report.state).toBe("stale");
    expect(entry.present).toBe(true);
    expect(entry.currentForm).toBe(false);
    expect(entry.reason).toBeUndefined();
    const stdout = f.doctor();
    const block = doctorBlock(stdout);
    expect(block).toContain("Continuity capture hooks: stale");
    expect(block).toContain("an entry is not the current form");
    expect(block).not.toContain("pin malformed");
    expect(block).not.toContain("manually");
    expect(block).toContain("flair doctor --fix");
    expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
  }, 25_000);

  for (const mode of ["report", "fix", "dry-run"] as const) {
    test("R2 partial bad pin keeps both findings and manual advice " + event + " " + mode, () => {
      const f = fixture(event === "PostToolUse" ? command("latest") : null, event === "Stop" ? command("latest") : null);
      const args = mode === "report" ? [] : mode === "fix" ? ["--fix"] : ["--fix", "--dry-run"];
      const report = checkContinuityCaptureHooks(f.home);
      expect(report.state).toBe("partial");
      expect(event === "PostToolUse" ? report.stop.present : report.postToolUse.present).toBe(false);
      const stdout = f.doctor(args);
      const line = outputLine(stdout, "Continuity capture hooks:");
      const missing = event === "PostToolUse" ? "Stop" : "PostToolUse";
      expect(line).toContain("Continuity capture hooks: partial");
      expect(line).toContain("the " + missing + " entry is missing");
      expect(line).toContain(event + " pin range-or-tag: latest");
      expect(doctorBlock(stdout)).toContain(manual);
      expect(doctorBlock(stdout)).not.toContain("flair doctor --fix");
      expect(stdout).not.toContain("Would rewrite the continuity capture hooks");
      expect(stdout).not.toContain("holding —");
      expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
      expect(checkContinuityCaptureHooks(f.home).state).toBe("partial");
    }, 25_000);
  }

  for (const pair of ["partial", "stale"] as const) {
    test("R2 hook status gives manual advice " + event + " " + pair, () => {
      const other = pair === "partial" ? null : command();
      const f = fixture(event === "PostToolUse" ? command("latest") : other, event === "Stop" ? command("latest") : other);
      const line = outputLine(f.run(["hook", "status"]), "continuity capture:");
      expect(line).toContain("continuity capture: " + pair);
      if (pair === "partial") expect(line).toContain((event === "PostToolUse" ? "Stop" : "PostToolUse") + " missing");
      expect(line).toContain("resolve the non-version pin manually");
      expect(line).not.toContain("re-run:");
      expect(line).not.toContain("flair hook install");
      expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
    }, 25_000);
  }
}

for (const mode of ["report", "fix", "dry-run"] as const) {
  test("R2 full bad pair preserves both pin reasons " + mode, () => {
    const f = fixture(command("latest"), command("file:adapter"));
    const args = mode === "report" ? [] : mode === "fix" ? ["--fix"] : ["--fix", "--dry-run"];
    const stdout = f.doctor(args);
    const block = doctorBlock(stdout);
    expect(block).toContain("Continuity capture hooks: stale");
    expect(block).toContain("PostToolUse pin range-or-tag: latest");
    expect(block).toContain("Stop pin unsupported: file:adapter");
    expect(block).toContain(manual);
    expect(block).not.toContain("flair doctor --fix");
    expect(stdout).not.toContain("Would rewrite the continuity capture hooks");
    expect(stdout).not.toContain("holding —");
    expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
  }, 25_000);
}

test("R2 control repairable partial still offers and applies repair", () => {
  const f = fixture(null, command());
  expect(doctorBlock(f.doctor())).toContain("flair doctor --fix");
  const status = outputLine(f.run(["hook", "status"]), "continuity capture:");
  expect(status).toContain("PostToolUse missing");
  expect(status).toContain("re-run: flair hook install --continuity");
  expect(status).not.toContain("manually");
  expect(f.doctor(["--fix", "--dry-run"])).toContain("Would rewrite the continuity capture hooks");
  expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
  const stdout = f.doctor(["--fix"]);
  expect(stdout).not.toContain(manual);
  const after = checkContinuityCaptureHooks(f.home);
  expect(after.state).toBe("installed");
  expect(after.postToolUse.present).toBe(true);
  expect(after.stop.present).toBe(true);
  expect(after.postToolUse.command ?? "").toContain("FLAIR_AGENT_ID=" + agent);
  expect(after.postToolUse.command ?? "").toContain("FLAIR_URL=" + url);
  expect(after.stop.command).toBe(command());
}, 90_000);

// Supplementary wording checks: the behavior is exercised above.
test("R2 changelog scopes stale pins to a complete pair", () => {
  const text = readFileSync(join(root, ".changelog/unreleased/fixed-doctor-continuity-pin-report.md"), "utf8");
  expect(text).toContain("When both hooks are present, range, tag, unsupported, and malformed specs make the pair stale and appear with their pin classification.");
});

test("R2 state comment includes non-version pins", () => {
  const text = readFileSync(join(root, "src/doctor-client.ts"), "utf8");
  expect(text).toContain("hand-altered invocation, a drifted PostToolUse matcher, or a non-version pin).");
});
