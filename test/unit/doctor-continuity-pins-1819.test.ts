import { expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  buildContinuityCaptureHookCommand,
  buildSessionStartHookCommand,
  checkContinuityCaptureHooks,
  computeContinuityHookInstall,
  isHookCommandValueSafe,
  CONTINUITY_CAPTURE_HOOK_MARKER,
  CONTINUITY_POST_TOOL_USE_MATCHER,
} from "../../src/doctor-client.ts";
import { flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

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

function fixture(
  postToolUse: string | null,
  stop: string | null,
  matcher: string = CONTINUITY_POST_TOOL_USE_MATCHER,
) {
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
      matcher,
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

// A current sibling keeps the ahead pin as the only reason to hold the pair.
function r3Fixture(postPin: string = "99.0.0", stopPin: string = flairCliVersion()) {
  return fixture(command(postPin), command(stopPin), "Read");
}

function writerHoldAdvice(f: ReturnType<typeof fixture>): string {
  const planned = computeContinuityHookInstall(JSON.parse(f.bytes), agent, url);
  expect(planned.changed).toBe(false);
  expect(planned.decision?.action).toBe("hold");
  const line = planned.decision?.line;
  if (typeof line !== "string") throw new Error("Expected the writer's hold reason");
  return line.replace(": holding — ", ": held — ");
}

test("R3 doctor report holds an ahead PostToolUse pin with matcher drift", () => {
  const f = r3Fixture();
  const report = checkContinuityCaptureHooks(f.home);
  expect(report.state).toBe("stale");
  expect(report.postToolUse.currentForm).toBe(false);
  expect(report.stop.currentForm).toBe(true);
  const block = doctorBlock(f.doctor());
  expect(block).not.toContain("flair doctor --fix");
  expect(block).toContain("held");
  expect(block).toContain("manually");
  expect(block).toContain(writerHoldAdvice(f));
  expect(block).toContain("AHEAD of this CLI " + flairCliVersion());
  expect(readFileSync(f.settings)).toEqual(Buffer.from(f.bytes, "utf8"));
}, 25_000);

test("R3 doctor dry-run holds an ahead PostToolUse pin without writing", () => {
  const f = r3Fixture();
  const stdout = f.doctor(["--fix", "--dry-run"]);
  expect(stdout).not.toContain("Would rewrite the continuity capture hooks");
  const block = doctorBlock(stdout);
  expect(block).not.toContain("flair doctor --fix");
  expect(block).toContain("held");
  expect(block).toContain("manually");
  expect(block).toContain(writerHoldAdvice(f));
  expect(readFileSync(f.settings)).toEqual(Buffer.from(f.bytes, "utf8"));
}, 25_000);

test("R3 hook status holds an ahead PostToolUse pin without reinstall advice", () => {
  const f = r3Fixture();
  const line = outputLine(f.run(["hook", "status"]), "continuity capture:");
  expect(line).toContain("continuity capture: stale");
  expect(line).not.toContain("install --continuity");
  expect(line).not.toContain("re-run:");
  expect(line).toContain("held");
  expect(line).toContain("manually");
  expect(line).toContain(writerHoldAdvice(f));
  expect(readFileSync(f.settings)).toEqual(Buffer.from(f.bytes, "utf8"));
}, 25_000);

test("R3 doctor repair advice distinguishes behind and equal pins from ahead", () => {
  for (const pin of ["0.0.1", flairCliVersion()]) {
    const f = r3Fixture(pin);
    const planned = computeContinuityHookInstall(JSON.parse(f.bytes), agent, url);
    expect(planned.decision).toBeNull();
    expect(planned.changed).toBe(true);
    expect(checkContinuityCaptureHooks(f.home).state).toBe("stale");
    const block = doctorBlock(f.doctor());
    expect(block).toContain("flair doctor --fix");
    expect(block).not.toContain("manually");
    expect(f.doctor(["--fix", "--dry-run"])).toContain("Would rewrite the continuity capture hooks");
    const status = outputLine(f.run(["hook", "status"]), "continuity capture:");
    expect(status).toContain("re-run: flair hook install --continuity");
    expect(readFileSync(f.settings)).toEqual(Buffer.from(f.bytes, "utf8"));
  }

  // Paired negative control: this test must also fail on the old advice gate.
  const ahead = r3Fixture();
  const block = doctorBlock(ahead.doctor());
  expect(block).not.toContain("flair doctor --fix");
  expect(block).toContain(writerHoldAdvice(ahead));
  expect(ahead.doctor(["--fix", "--dry-run"])).not.toContain("Would rewrite the continuity capture hooks");
  expect(readFileSync(ahead.settings)).toEqual(Buffer.from(ahead.bytes, "utf8"));
}, 180_000);

test("R3 doctor and hook status hold when only Stop is ahead", () => {
  const f = r3Fixture(flairCliVersion(), "99.0.0");
  const reason = writerHoldAdvice(f);
  expect(reason).toContain("Stop continuity capture hook:");
  const block = doctorBlock(f.doctor());
  expect(block).not.toContain("flair doctor --fix");
  expect(block).toContain(reason);
  const stdout = f.doctor(["--fix", "--dry-run"]);
  expect(stdout).not.toContain("Would rewrite the continuity capture hooks");
  expect(doctorBlock(stdout)).toContain(reason);
  const status = outputLine(f.run(["hook", "status"]), "continuity capture:");
  expect(status).not.toContain("install --continuity");
  expect(status).toContain(reason);
  expect(readFileSync(f.settings)).toEqual(Buffer.from(f.bytes, "utf8"));
}, 75_000);


// PR #2027 must preserve #1819's distinction between no package and an
// unreadable package pin. Exercise advice and the actual repair together.
for (const event of events) {
  const missing = "sh -c 'FLAIR_AGENT_ID=fixture FLAIR_URL=" + url
    + " " + CONTINUITY_CAPTURE_HOOK_MARKER + " >/dev/null 2>/dev/null || true'";

  test("R4 missing package repairs shape and preserves the sibling " + event, () => {
    const sibling = command("0.0.1");
    const f = fixture(event === "PostToolUse" ? missing : sibling, event === "Stop" ? missing : sibling);
    const original = JSON.parse(f.bytes);
    const expected = JSON.parse(f.bytes);
    expected.hooks[event][0].hooks[0].command = command();

    const planned = computeContinuityHookInstall(original, agent, url);
    expect(planned.decision).toBeNull();
    expect(planned.changed).toBe(true);
    expect(planned.actions[event]).toBe("update");
    expect(planned.actions[event === "PostToolUse" ? "Stop" : "PostToolUse"]).toBe("noop");
    expect(planned.newConfig).toEqual(expected);
    expect(original).toEqual(JSON.parse(f.bytes));

    const block = doctorBlock(f.doctor());
    expect(block).toContain("an entry is not the current form");
    expect(block).toContain("flair doctor --fix");
    expect(block).not.toContain("manually");
    const dry = f.doctor(["--fix", "--dry-run"]);
    expect(dry).toContain("Would rewrite the continuity capture hooks");
    expect(doctorBlock(dry)).not.toContain("manually");
    const status = outputLine(f.run(["hook", "status"]), "continuity capture:");
    expect(status).toContain("re-run: flair hook install --continuity");
    expect(status).not.toContain("manually");
    expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);

    const fixed = f.doctor(["--fix"]);
    expect(fixed).toContain("wired the continuity capture hooks");
    expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual(expected);
    expect(checkContinuityCaptureHooks(f.home).state).toBe("installed");
  }, 120_000);

  test("R4 unrecognized command with a package still holds " + event, () => {
    // Even a behind pin cannot authorize a write through a rejected shape.
    const rejected = command("0.0.1").replace("npx -y -p", "FLAIR_AGENT_ID=other npx -y -p");
    const f = fixture(event === "PostToolUse" ? rejected : command(), event === "Stop" ? rejected : command());
    const planned = computeContinuityHookInstall(JSON.parse(f.bytes), agent, url);
    expect(planned.changed).toBe(false);
    expect(planned.decision?.action).toBe("hold");
    expect(planned.decision?.line).toContain(event + " continuity capture hook:");
    expect(planned.newConfig).toEqual(JSON.parse(f.bytes));
    const report = checkContinuityCaptureHooks(f.home);
    expect(report.state).toBe("stale");
    expect((event === "PostToolUse" ? report.postToolUse : report.stop).currentForm).toBe(false);
    const reason = writerHoldAdvice(f);

    for (const args of [[], ["--fix", "--dry-run"], ["--fix"]]) {
      const stdout = f.doctor(args);
      const block = doctorBlock(stdout);
      expect(block).toContain("manually");
      expect(block).toContain(event + " continuity capture hook: held");
      expect(block).toContain(reason);
      expect(block).not.toContain("flair doctor --fix");
      expect(stdout).not.toContain("Would rewrite the continuity capture hooks");
      expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
    }
    const status = outputLine(f.run(["hook", "status"]), "continuity capture:");
    expect(status).toContain("manually");
    expect(status).toContain(reason);
    expect(status).not.toContain("re-run:");
    expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
  }, 120_000);

  for (const pin of ["99.0.0", "latest"]) {
    test("R4 missing package cannot bypass the sibling hold " + event + " " + pin, () => {
      const protectedEvent = event === "PostToolUse" ? "Stop" : "PostToolUse";
      const f = fixture(event === "PostToolUse" ? missing : command(pin), event === "Stop" ? missing : command(pin));
      const planned = computeContinuityHookInstall(JSON.parse(f.bytes), agent, url);
      expect(planned.changed).toBe(false);
      expect(planned.decision?.action).toBe("hold");
      expect(planned.decision?.line).toContain(protectedEvent + " continuity capture hook:");
      expect(planned.decision?.line).toContain(pin);
      expect(planned.newConfig).toEqual(JSON.parse(f.bytes));
      const stdout = f.doctor(["--fix"]);
      const block = doctorBlock(stdout);
      expect(block).toContain("manually");
      expect(block).toContain(protectedEvent + " continuity capture hook: held");
      expect(block).not.toContain("flair doctor --fix");
      expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
    }, 30_000);
  }
}

// B2: report, dry-run and actual writer classify the same captured argument.
// Matcher drift makes even a valid version command require a shape repair.
const parityCases: Array<{ label: string; command: string; pin: string | null; held?: boolean; reason?: string }> = [
  { label: "behind", command: command("0.0.1"), pin: "0.0.1" },
  { label: "current", command: command(flairCliVersion()), pin: flairCliVersion() },
  { label: "bare", command: command(), pin: null },
  { label: "unsilenced", command: command("0.0.1").slice(7, -" >/dev/null 2>/dev/null || true'".length), pin: "0.0.1" },
  { label: "legacy without -p", command: command("0.0.1").replace(" -p ", " "), pin: "0.0.1" },
  { label: "safe builder values", command: buildContinuityCaptureHookCommand("a.Z_0:/-", url, "0.0.1"), pin: "0.0.1" },
  { label: "ahead", command: command("99.0.0"), pin: "99.0.0", held: true },
  { label: "tag", command: command("latest"), pin: "latest", held: true, reason: "pin range-or-tag: latest" },
  { label: "source", command: command("file:adapter"), pin: "file:adapter", held: true, reason: "pin unsupported: file:adapter" },
  { label: "missing package", command: `sh -c 'FLAIR_AGENT_ID=fixture FLAIR_URL=${url} ${CONTINUITY_CAPTURE_HOOK_MARKER} >/dev/null 2>/dev/null || true'`, pin: null },
  { label: "unmatched wrapper", command: command("0.0.1").slice(7), pin: "unknown", held: true, reason: "pin malformed: unknown" },
  { label: "duplicate assignment", command: command("0.0.1").replace("npx", "FLAIR_AGENT_ID=other npx"), pin: "unknown", held: true, reason: "pin malformed: unknown" },
];
for (const value of ["@tpsdev-ai/flair-mcp@latest", "fixture;true", "$(true)", "fixture=other"]) {
  for (const field of ["FLAIR_AGENT_ID", "FLAIR_URL"]) {
    parityCases.push({
      label: `builder-rejected ${field} ${value}`,
      command: command("0.0.1").replace(`${field}=${field === "FLAIR_AGENT_ID" ? agent : url}`, `${field}=${value}`),
      pin: "unknown", held: true, reason: "pin malformed: unknown",
    });
  }
}

for (const event of events) {
  for (const c of parityCases) {
    test(`B2 report/dry-run/writer parity ${event}: ${c.label}`, () => {
      const sibling = command("0.0.1");
      const f = fixture(event === "PostToolUse" ? c.command : sibling, event === "Stop" ? c.command : sibling, "Read");
      const report = checkContinuityCaptureHooks(f.home);
      const entry = event === "PostToolUse" ? report.postToolUse : report.stop;
      expect(report.state).toBe("stale");
      expect(entry.reason).toBe(c.reason);
      const planned = computeContinuityHookInstall(JSON.parse(f.bytes), agent, url);
      expect(planned.changed).toBe(!c.held);
      expect(planned.decision?.action ?? null).toBe(c.held ? "hold" : null);
      const reported = doctorBlock(f.doctor());
      const dry = f.doctor(["--fix", "--dry-run"]);
      expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
      if (c.held) {
        const advice = writerHoldAdvice(f);
        expect(reported).toContain(advice);
        expect(doctorBlock(dry)).toContain(advice);
        expect(dry).not.toContain("Would rewrite the continuity capture hooks");
        expect(reported).not.toContain("flair doctor --fix");
        expect(planned.decision?.line).toContain(c.pin!);
        if (c.reason) expect(reported).toContain(c.reason);
      } else {
        expect(entry.reason).toBeUndefined();
        expect(reported).toContain("flair doctor --fix");
        expect(dry).toContain("Would rewrite the continuity capture hooks");
        expect(planned.newConfig.hooks[event][0].hooks[0].command).toBe(command(c.pin));
      }
      const fixed = f.doctor(["--fix"]);
      if (c.held) {
        expect(doctorBlock(fixed)).toContain(writerHoldAdvice(f));
        expect(readFileSync(f.settings, "utf8")).toBe(f.bytes);
      } else {
        expect(fixed).toContain("wired the continuity capture hooks");
        expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual(planned.newConfig);
        expect(checkContinuityCaptureHooks(f.home).state).toBe("installed");
      }
    }, 90_000);
  }
}

test("B2 command recognition uses the builder's env value contract", () => {
  for (const value of ["@tpsdev-ai/flair-mcp@latest", "fixture;true", "$(true)", "fixture=other"]) {
    expect(isHookCommandValueSafe(value)).toBe(false);
    expect(() => buildContinuityCaptureHookCommand(value, url)).toThrow();
    expect(() => buildContinuityCaptureHookCommand(agent, value)).toThrow();
  }
  expect(() => buildContinuityCaptureHookCommand("a.Z_0:/-", url)).not.toThrow();
});
