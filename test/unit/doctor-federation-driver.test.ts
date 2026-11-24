/**
 * doctor-federation-driver.test.ts — flair#1514.
 *
 * Two sub-bugs on main:
 *   1. describeScheduledDriverFinding ✗-es INSTALLED BUT NOT LOADED with no
 *      peer gate — a standalone install with leftover unit files is a red
 *      false alarm.
 *   2. doctor configPath() only looks at ~/.flair/config.yaml, so a
 *      component-dir config (the file Harper actually loads) is invisible.
 *
 * Acceptance (all three, plus the hazard):
 *   - Fresh install, no peers: federation-driver is N/A, never ✗.
 *   - Peers configured (in the component dir config) + driver present: pass.
 *   - Peers configured + driver genuinely missing: still ✗.
 *
 * SAFETY: pure functions + temp dirs. No launchctl/systemctl, no Harper.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  describeScheduledDriverFinding,
  type ScheduledDriverFacts,
  type LastExitStatus,
} from "../../src/lib/scheduler-platform.ts";
import {
  flairConfigYamlCandidates,
  resolveFlairConfigYaml,
} from "../../src/lib/doctor-config-path.ts";
import {
  collectFederationEnv,
  configDeclaresFederationPeers,
  describeFederationDriverFinding,
  envDeclaresFederationPeers,
  federationPeersConfigured,
  loadYamlDoc,
  parseEnvAssignments,
} from "../../src/lib/doctor-federation-driver.ts";
import { enableScheduler, inspectFederationShimNode } from "../../src/federation/scheduler.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import * as render from "../../src/render.ts";

function driverFacts(overrides: Partial<ScheduledDriverFacts> = {}): ScheduledDriverFacts {
  return {
    label: "Federation sync driver",
    enableCommand: "flair federation sync enable",
    statusCommand: "flair federation sync status",
    installed: true,
    active: true,
    lastExit: { state: "recorded", exitCode: 0, detail: "exit 0" },
    stderrLogPath: "/tmp/federation-sync.stderr.log",
    ...overrides,
  };
}

const recorded = (exitCode: number): LastExitStatus => ({
  state: "recorded",
  exitCode,
  detail: `exit ${exitCode}`,
});

// ─── RED-ON-MAIN: the two bugs this issue names ─────────────────────────────

describe("flair#1514 — bugs on ungated scheduled-driver + ~/.flair-only config", () => {
  it("BUG 1: installed-but-not-loaded with no peer gate is a failing issue (the false alarm)", () => {
    const ungated = describeScheduledDriverFinding(driverFacts({ active: false, lastExit: null }));
    expect(ungated.isIssue).toBe(true);
    expect(ungated.icon).toBe("error");
    expect(ungated.message).toContain("NOT LOADED");
  });

  it("BUG 2: resolveFlairConfigYaml finds the component dir when ~/.flair/config.yaml is absent", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "flair-1514-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "flair-1514-cwd-"));
    const componentDir = mkdtempSync(join(tmpdir(), "flair-1514-component-"));
    try {
      mkdirSync(join(homeDir, ".flair"), { recursive: true });
      writeFileSync(join(componentDir, "config.yaml"), "name: flair\nport: 19926\n");
      // The old configPath() would only return ~/.flair/config.yaml.
      const userOnly = join(homeDir, ".flair", "config.yaml");
      expect(existsSync(userOnly)).toBe(false);
      const resolved = resolveFlairConfigYaml({ cwd, homeDir, componentDir });
      expect(resolved).toBe(join(componentDir, "config.yaml"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(componentDir, { recursive: true, force: true });
    }
  });
});

// ─── Acceptance 1: fresh install, no peers — never ✗ ────────────────────────

describe("acceptance: fresh install, no peers configured", () => {
  it("installed-but-not-loaded is N/A / informational, never an issue", () => {
    const f = describeFederationDriverFinding({
      peersConfigured: false,
      driver: driverFacts({ active: false, lastExit: null }),
    });
    expect(f.isIssue).toBe(false);
    expect(f.icon).not.toBe("error");
    expect(f.icon).toBe("info");
    expect(f.message).toContain("not configured (driver installed, idle)");
    expect(f.message).not.toContain("NOT LOADED");
    expect(render.icons[f.icon]).not.toBe(render.icons.error);
  });

  it("not-installed is also N/A, never ✗", () => {
    const f = describeFederationDriverFinding({
      peersConfigured: false,
      driver: driverFacts({ installed: false, active: false, lastExit: null }),
    });
    expect(f.isIssue).toBe(false);
    expect(f.icon).toBe("info");
    expect(f.message).toContain("not configured");
  });

  it("last-run-failed is still N/A when no peers — idle leftover units are not a defect", () => {
    const f = describeFederationDriverFinding({
      peersConfigured: false,
      driver: driverFacts({ lastExit: recorded(209) }),
    });
    expect(f.isIssue).toBe(false);
    expect(f.icon).toBe("info");
  });

  it("federationPeersConfigured is false when every signal is empty", () => {
    expect(federationPeersConfigured({
      livePeerCount: 0,
      configDoc: { name: "flair" },
      env: { FLAIR_FEDERATION_REQUIRE_RECORD_SIGNATURES: "true" },
      nodeKeyIds: [],
    })).toBe(false);
  });
});

// ─── Acceptance 2: peers in component config + driver present → pass ────────

describe("acceptance: peers configured + driver present (component-dir config)", () => {
  let homeDir: string;
  let cwd: string;
  let componentDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "flair-1514-home-"));
    cwd = mkdtempSync(join(tmpdir(), "flair-1514-cwd-"));
    componentDir = mkdtempSync(join(tmpdir(), "flair-1514-component-"));
    mkdirSync(join(homeDir, ".flair"), { recursive: true });
    writeFileSync(
      join(componentDir, "config.yaml"),
      "name: flair\nfederation:\n  peers:\n    - id: hub\n      endpoint: https://hub.example:9926\n",
    );
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(componentDir, { recursive: true, force: true });
  });

  it("resolves config.yaml from the component dir, not ~/.flair", () => {
    const path = resolveFlairConfigYaml({ cwd, homeDir, componentDir });
    expect(path).toBe(join(componentDir, "config.yaml"));
    expect(path).not.toBe(join(homeDir, ".flair", "config.yaml"));
  });

  it("reads peers from that component config so the gate sees them", () => {
    const path = resolveFlairConfigYaml({ cwd, homeDir, componentDir });
    expect(path).not.toBeNull();
    const doc = loadYamlDoc(path!);
    expect(configDeclaresFederationPeers(doc)).toBe(true);
    expect(federationPeersConfigured({ configDoc: doc, livePeerCount: 0, nodeKeyIds: [], env: {} })).toBe(true);
  });

  it("driver present → pass, not an issue", () => {
    const path = resolveFlairConfigYaml({ cwd, homeDir, componentDir });
    const configured = federationPeersConfigured({ configDoc: loadYamlDoc(path!) });
    expect(configured).toBe(true);
    const f = describeFederationDriverFinding({
      peersConfigured: configured,
      driver: driverFacts(),
    });
    expect(f.state).toBe("healthy");
    expect(f.icon).toBe("ok");
    expect(f.isIssue).toBe(false);
    expect(f.message).toContain("exit 0");
  });
});

// ─── Acceptance 3: peers configured + driver missing → still ✗ ──────────────

describe("acceptance: peers configured + driver genuinely missing still ✗", () => {
  it("not installed → ✗, issue counted", () => {
    const f = describeFederationDriverFinding({
      peersConfigured: true,
      driver: driverFacts({ installed: false, active: false, lastExit: null }),
    });
    expect(f.isIssue).toBe(true);
    expect(f.icon).toBe("error");
    expect(f.message).toMatch(/not installed/i);
    expect(f.detail.join("\n")).toContain("flair federation sync enable");
  });

  it("installed but not loaded → ✗ (the original real failure, not silenced)", () => {
    const f = describeFederationDriverFinding({
      peersConfigured: true,
      driver: driverFacts({ active: false, lastExit: null }),
    });
    expect(f.isIssue).toBe(true);
    expect(f.icon).toBe("error");
    expect(f.message).toContain("NOT LOADED");
  });

  it("last-run-failed stays ✗ when peers are configured", () => {
    const f = describeFederationDriverFinding({
      peersConfigured: true,
      driver: driverFacts({ lastExit: recorded(209) }),
    });
    expect(f.isIssue).toBe(true);
    expect(f.icon).toBe("error");
    expect(f.message).toContain("DEGRADED");
  });
});

// ─── Signals: what counts as "peers configured" ─────────────────────────────

describe("federationPeersConfigured — signals", () => {
  it("live peer count > 0 is configured", () => {
    expect(federationPeersConfigured({ livePeerCount: 2 })).toBe(true);
  });

  it("live peer count 0 is not configured by itself", () => {
    expect(federationPeersConfigured({ livePeerCount: 0 })).toBe(false);
  });

  it("node-scoped federation keys count (the issue's third place they looked)", () => {
    expect(federationPeersConfigured({ nodeKeyIds: ["flair_deadbeef"] })).toBe(true);
  });

  it("FLAIR_FEDERATION_HUB in env counts; require-* policy flags do not", () => {
    expect(envDeclaresFederationPeers({ FLAIR_FEDERATION_HUB: "https://hub.example" })).toBe(true);
    expect(envDeclaresFederationPeers({ FLAIR_FEDERATION_REQUIRE_RECORD_SIGNATURES: "true" })).toBe(false);
    expect(envDeclaresFederationPeers({ FLAIR_FEDERATION_REQUIRE_RECORD_PRINCIPAL: "true" })).toBe(false);
    expect(federationPeersConfigured({
      env: { FLAIR_FEDERATION_REQUIRE_RECORD_SIGNATURES: "true" },
    })).toBe(false);
  });

  it("federation.hub / federation.endpoint in config.yaml count", () => {
    expect(configDeclaresFederationPeers({ federation: { hub: "https://hub.example" } })).toBe(true);
    expect(configDeclaresFederationPeers({ federation: { endpoint: "https://hub.example" } })).toBe(true);
    expect(configDeclaresFederationPeers({ name: "flair", rest: true })).toBe(false);
  });

  it("top-level peers[] only counts when entries look like federation peers", () => {
    expect(configDeclaresFederationPeers({
      peers: [{ id: "hub", endpoint: "https://hub.example" }],
    })).toBe(true);
    expect(configDeclaresFederationPeers({ peers: ["not-a-peer-object"] })).toBe(false);
    expect(configDeclaresFederationPeers({ peers: [] })).toBe(false);
  });
});

// ─── Config resolution order ────────────────────────────────────────────────

describe("resolveFlairConfigYaml — runtime order", () => {
  let homeDir: string;
  let cwd: string;
  let componentDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "flair-1514-home-"));
    cwd = mkdtempSync(join(tmpdir(), "flair-1514-cwd-"));
    componentDir = mkdtempSync(join(tmpdir(), "flair-1514-component-"));
    mkdirSync(join(homeDir, ".flair"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(componentDir, { recursive: true, force: true });
  });

  it("prefers cwd/config.yaml over the component dir and ~/.flair", () => {
    writeFileSync(join(cwd, "config.yaml"), "port: 1\n");
    writeFileSync(join(componentDir, "config.yaml"), "port: 2\n");
    writeFileSync(join(homeDir, ".flair", "config.yaml"), "port: 3\n");
    expect(resolveFlairConfigYaml({ cwd, homeDir, componentDir })).toBe(join(cwd, "config.yaml"));
  });

  it("falls back to ~/.flair/config.yaml when cwd and component dir have none", () => {
    writeFileSync(join(homeDir, ".flair", "config.yaml"), "port: 9926\n");
    expect(resolveFlairConfigYaml({ cwd, homeDir, componentDir })).toBe(join(homeDir, ".flair", "config.yaml"));
  });

  it("returns null when nothing exists — candidates still name the component dir", () => {
    expect(resolveFlairConfigYaml({ cwd, homeDir, componentDir })).toBeNull();
    const candidates = flairConfigYamlCandidates({ cwd, homeDir, componentDir });
    expect(candidates[0]).toBe(join(cwd, "config.yaml"));
    expect(candidates).toContain(join(componentDir, "config.yaml"));
    expect(candidates).toContain(join(homeDir, ".flair", "config.yaml"));
  });

  it("accepts config.yml in the component dir", () => {
    writeFileSync(join(componentDir, "config.yml"), "name: flair\n");
    expect(resolveFlairConfigYaml({ cwd, homeDir, componentDir })).toBe(join(componentDir, "config.yml"));
  });
});

// ─── .env collection (process env wins) ─────────────────────────────────────

describe("collectFederationEnv / parseEnvAssignments", () => {
  it("parses KEY=value and export KEY=value, strips quotes", () => {
    const parsed = parseEnvAssignments(
      'export FLAIR_FEDERATION_HUB="https://hub.example"\n# comment\nFLAIR_FEDERATION_PEERS=spoke-a\n',
    );
    expect(parsed.FLAIR_FEDERATION_HUB).toBe("https://hub.example");
    expect(parsed.FLAIR_FEDERATION_PEERS).toBe("spoke-a");
  });

  it("process env wins over a component .env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-1514-env-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "FLAIR_FEDERATION_HUB=from-file\nFLAIR_FEDERATION_PEERS=from-file\n");
      const merged = collectFederationEnv({
        processEnv: { FLAIR_FEDERATION_HUB: "from-process" },
        envFilePaths: [envPath],
      });
      expect(merged.FLAIR_FEDERATION_HUB).toBe("from-process");
      expect(merged.FLAIR_FEDERATION_PEERS).toBe("from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cli wiring (supplementary)", () => {
  it("cli.ts calls the gate and the component-dir resolver (not a second copy)", () => {
    const cli = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf-8");
    expect(cli).toContain("describeFederationDriverFinding");
    expect(cli).toContain("resolveFlairConfigYaml");
    expect(cli).toContain("federationPeersConfigured");
  });
});

// ─── flair#3056: the node path on the shim's exec line does not exist ───────

describe("flair#3056 — describeScheduledDriverFinding with shimMissingNode", () => {
  const missing = { unitPath: "/h/unit.plist", shimPath: "/h/.flair/bin/flair-federation-sync", nodeBin: "/h/Cellar/node/26.10.0_1/bin/node" };
  const lastExits: Array<LastExitStatus | null> = [
    recorded(1),
    recorded(0),
    { state: "never-ran", exitCode: null, detail: "never" },
    { state: "running", exitCode: null, detail: "running" },
    { state: "unavailable", exitCode: null, detail: "unavailable" },
    null,
  ];
  for (const lastExit of lastExits) {
    it(`names the missing node path and points at flair init (last exit: ${lastExit ? `${lastExit.state} ${lastExit.exitCode ?? ""}` : "not read"})`, () => {
      const f = describeFederationDriverFinding({ peersConfigured: true, driver: driverFacts({ lastExit, shimMissingNode: missing }) });
      expect(f.state).toBe("degraded");
      expect(f.isIssue).toBe(true);
      expect(f.message).toContain(missing.nodeBin);
      expect(f.detail[0]).toBe(`${missing.unitPath} names ${missing.shimPath} as its program; the shim's exec line names ${missing.nodeBin}, which does not exist.`);
      expect(f.detail.join("\n")).toContain("Fix: flair init");
    });
  }

  it("is not reported for a driver that is not loaded (that finding names enable)", () => {
    const f = describeFederationDriverFinding({ peersConfigured: true, driver: driverFacts({ active: false, lastExit: null, shimMissingNode: missing }) });
    expect(f.message).toContain("NOT LOADED");
    expect(f.message).not.toContain(missing.nodeBin);
  });
});

describe("flair#3056 — inspectFederationShimNode reads the unit and the shim from disk", () => {
  const templateRoot = join(import.meta.dir, "..", "..", "templates");

  function setup(platform: "darwin" | "linux") {
    const root = tempDir("flair-3056-inspect-");
    const home = join(root, "home");
    mkdirSync(join(home, ".flair", "bin"), { recursive: true });
    const tree = join(root, "tree");
    mkdirSync(join(tree, "dist"), { recursive: true });
    writeFileSync(join(tree, "dist", "cli.js"), "// flair\n");
    writeFileSync(join(home, ".flair", "admin-pass"), "x\n", { mode: 0o600 });
    const paths = {
      platformOverride: platform,
      shimPathOverride: join(home, ".flair", "bin", "flair-federation-sync"),
      launchdPlistOverride: join(home, "Library", "LaunchAgents", "dev.flair.federation.sync.plist"),
      systemdServiceOverride: join(home, ".config", "systemd", "user", "flair-federation-sync.service"),
      templateRootOverride: templateRoot,
    };
    const nodeBin = join(root, "Cellar", "node", "26.10.0_1", "bin", "node");
    enableScheduler({
      ...paths,
      intervalSeconds: 300,
      adminPassFile: join(home, ".flair", "admin-pass"),
      flairBin: join(tree, "dist", "cli.js"),
      nodeBin,
      systemdTimerOverride: join(home, ".config", "systemd", "user", "flair-federation-sync.timer"),
      homeOverride: home,
      skipLoad: true,
    });
    const unitPath = platform === "darwin" ? paths.launchdPlistOverride : paths.systemdServiceOverride;
    return { root, paths, nodeBin, unitPath, shim: paths.shimPathOverride };
  }

  for (const platform of ["darwin", "linux"] as const) {
    it(`${platform}: names the node path when the unit file names the generated shim and the path does not exist`, () => {
      const s = setup(platform);
      expect(inspectFederationShimNode(s.paths)).toEqual({ unitPath: s.unitPath, shimPath: s.shim, nodeBin: s.nodeBin });
    });

    it(`${platform}: null once the node path exists`, () => {
      const s = setup(platform);
      mkdirSync(dirname(s.nodeBin), { recursive: true });
      writeFileSync(s.nodeBin, "#!/bin/sh\n", { mode: 0o755 });
      expect(inspectFederationShimNode(s.paths)).toBeNull();
    });

    it(`${platform}: null when the unit file names another program`, () => {
      const s = setup(platform);
      const unit = readFileSync(s.unitPath, "utf-8");
      const other = join(s.root, "other-sync.sh");
      const changed = platform === "darwin"
        ? unit.replace(`<string>${s.shim}</string>`, `<string>${other}</string>`)
        : unit.replace(`ExecStart=${s.shim}`, `ExecStart=${other}`);
      expect(changed).not.toBe(unit);
      writeFileSync(s.unitPath, changed);
      expect(inspectFederationShimNode(s.paths)).toBeNull();
    });

    it(`${platform}: null when the unit names the shim by a relative program path`, () => {
      const s = setup(platform);
      const unit = readFileSync(s.unitPath, "utf-8");
      // A relative path that would resolve to the shim from this process's
      // cwd; the unit's own directory is not this process's cwd.
      const relativeProgram = relative(process.cwd(), s.shim);
      expect(resolve(relativeProgram)).toBe(resolve(s.shim));
      const changed = platform === "darwin"
        ? unit.replace(`<string>${s.shim}</string>`, `<string>${relativeProgram}</string>`)
        : unit.replace(`ExecStart=${s.shim}`, `ExecStart=${relativeProgram}`);
      expect(changed).not.toBe(unit);
      writeFileSync(s.unitPath, changed);
      expect(inspectFederationShimNode(s.paths)).toBeNull();
    });
  }

  it("darwin: null when an XML comment names the shim but the top-level ProgramArguments runs another program", () => {
    const s = setup("darwin");
    const unit = readFileSync(s.unitPath, "utf-8");
    const other = join(s.root, "other-sync.sh");
    const decoy = `<dict>\n  <!-- <key>ProgramArguments</key><array><string>${s.shim}</string></array> -->`;
    const changed = unit.replace(`<string>${s.shim}</string>`, `<string>${other}</string>`).replace("<dict>", decoy);
    expect(changed.indexOf(s.shim)).toBeLessThan(changed.indexOf(other));
    writeFileSync(s.unitPath, changed);
    expect(inspectFederationShimNode(s.paths)).toBeNull();
  });

  it("darwin: null when the plist declares a Program key", () => {
    const s = setup("darwin");
    const unit = readFileSync(s.unitPath, "utf-8");
    const other = join(s.root, "other-sync.sh");
    const changed = unit.replace("<key>ProgramArguments</key>", `<key>Program</key>\n  <string>${other}</string>\n  <key>ProgramArguments</key>`);
    expect(changed).not.toBe(unit);
    writeFileSync(s.unitPath, changed);
    expect(inspectFederationShimNode(s.paths)).toBeNull();
  });

  // Comment markup that one removal pass cannot clear: the unit file is not confirmed to run the shim.
  const unclearComments: Array<[string, (unit: string, shim: string, other: string) => string]> = [
    ["overlapping comment markup hides a ProgramArguments that names the shim", (unit, shim, other) =>
      unit.replace(`<string>${shim}</string>`, `<string>${other}</string>`)
        .replace("<dict>", `<dict>\n  <!<!---->-- <key>ProgramArguments</key><array><string>${shim}</string></array> -->`)],
    ["overlapping comment markup sits before a ProgramArguments that names the shim", (unit) =>
      unit.replace("<dict>", "<dict>\n  <!<!---->-- hidden -->")],
    ["a comment is not closed", (unit) => unit.replace("</plist>", "</plist>\n<!-- not closed")],
  ];
  for (const [what, edit] of unclearComments) {
    it(`darwin: null when ${what}`, () => {
      const s = setup("darwin");
      const unit = readFileSync(s.unitPath, "utf-8");
      const changed = edit(unit, s.shim, join(s.root, "other-sync.sh"));
      expect(changed).not.toBe(unit);
      writeFileSync(s.unitPath, changed);
      expect(inspectFederationShimNode(s.paths)).toBeNull();
    });
  }

  it("darwin: null when the plist's top-level Label is another job's", () => {
    const s = setup("darwin");
    const unit = readFileSync(s.unitPath, "utf-8");
    const changed = unit.replace("<string>dev.flair.federation.sync</string>", "<string>dev.example.other</string>");
    expect(changed).not.toBe(unit);
    writeFileSync(s.unitPath, changed);
    expect(inspectFederationShimNode(s.paths)).toBeNull();
  });

  it("linux: null when the service has a second ExecStart", () => {
    const s = setup("linux");
    const unit = readFileSync(s.unitPath, "utf-8");
    const changed = unit.replace(`ExecStart=${s.shim}`, `ExecStart=${s.shim}\nExecStart=${join(s.root, "other-sync.sh")}`);
    expect(changed).not.toBe(unit);
    writeFileSync(s.unitPath, changed);
    expect(inspectFederationShimNode(s.paths)).toBeNull();
  });

  it("null when the unit file path is a symlink (it is not followed)", () => {
    const s = setup("darwin");
    const real = join(s.root, "elsewhere-unit.plist");
    writeFileSync(real, readFileSync(s.unitPath, "utf-8"));
    rmSync(s.unitPath);
    symlinkSync(real, s.unitPath);
    expect(inspectFederationShimNode(s.paths)).toBeNull();
  });

  it("null when the unit file is larger than the read bound", () => {
    const s = setup("darwin");
    const unit = readFileSync(s.unitPath, "utf-8");
    writeFileSync(s.unitPath, unit.replace("<dict>", `<dict>\n  <!-- ${"x".repeat(64 * 1024)} -->`));
    expect(inspectFederationShimNode(s.paths)).toBeNull();
  });

  it("null when the shim runs a command the generated shim does not", () => {
    const s = setup("darwin");
    const shim = readFileSync(s.shim, "utf-8");
    writeFileSync(s.shim, shim.replace(/^exec /m, "echo hand-edit\nexec "));
    expect(inspectFederationShimNode(s.paths)).toBeNull();
  });

  it("null when the shim path is a symlink (it is not followed)", () => {
    const s = setup("darwin");
    const real = join(s.root, "elsewhere-shim");
    writeFileSync(real, readFileSync(s.shim, "utf-8"));
    rmSync(s.shim);
    symlinkSync(real, s.shim);
    expect(inspectFederationShimNode(s.paths)).toBeNull();
  });

  it("null when the shim is larger than the read bound", () => {
    const s = setup("darwin");
    writeFileSync(s.shim, readFileSync(s.shim, "utf-8") + `# ${"x".repeat(64 * 1024)}\n`);
    expect(inspectFederationShimNode(s.paths)).toBeNull();
  });
});
