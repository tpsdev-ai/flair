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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
