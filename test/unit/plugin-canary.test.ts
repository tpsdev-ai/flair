/**
 * plugin-canary.test.ts — flair#1338.
 *
 * The post-publish canary (#1698/#1702) installs and boots `@tpsdev-ai/flair`.
 * It does not install the adapters a host runs, and it does not drive a
 * documented MCP config through a real tools/call. These tests are the
 * fails-first fixtures for that missing lane:
 *
 *   - main's canary.yml has no plugin step → pluginCanaryWired.wired is false
 *   - this branch's canary.yml must be wired (script + id + verdict, no skip)
 *   - missing/invalid version and skip flags are DID NOT RUN (never a pass)
 *   - the documented host config is the pinned npx spec, not a bare package
 *   - a resolve under packages/ is the workspace-copy failure, not a pass
 *
 * Live registry install + MCP round-trip is the canary workflow itself.
 * These cases pin the contract so a missing step cannot read as green.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXIT_DID_NOT_RUN,
  EXIT_OK,
  FLAIR_CLIENT_PACKAGE,
  FLAIR_MCP_PACKAGE,
  REQUIRED_TOOLS,
  WORKSPACE_PACKAGES,
  assertPublishedResolve,
  documentedHostConfig,
  parseArgs,
  pinCheck,
  pluginCanaryWired,
  readDocumentedPin,
  readInstalledVersion,
  registrySpec,
} from "../../scripts/ci/check-plugin-canary.mjs";

const REPO = join(import.meta.dir, "../..");
const SCRIPT = join(REPO, "scripts", "ci", "check-plugin-canary.mjs");
const CANARY_YML = readFileSync(join(REPO, ".github", "workflows", "canary.yml"), "utf8");
const RELEASING = readFileSync(join(REPO, "docs", "releasing.md"), "utf8");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

function runGate(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("plugin canary is wired into the post-publish canary (fails on main)", () => {
  test("main's canary.yml (no plugin step) is not wired — the fails-first fixture", () => {
    // Exact contract of #1698/#1702 as merged: sha + install + boot + verdict.
    // No plugin step, no PLUGIN_OUTCOME. This is what a checkout of main has.
    const mainShaped = `
name: Post-publish canary
jobs:
  canary:
    steps:
      - id: sha
        run: echo sha
      - id: install
        run: echo install
      - id: boot
        run: scripts/ci/check-instance-boot.sh
      - if: always()
        run: |
          if [ "$SHA_OUTCOME" = "success" ] && [ "$INSTALL_OUTCOME" = "success" ] && [ "$BOOT_OUTCOME" = "success" ]; then
            scripts/ci/canary-verdict.sh pass
          fi
`;
    const main = pluginCanaryWired(mainShaped);
    expect(main.hasScript).toBe(false);
    expect(main.hasId).toBe(false);
    expect(main.hasOutcome).toBe(false);
    expect(main.wired).toBe(false);
  });

  test("this branch's canary.yml is wired: script, id, verdict, no continue-on-error", () => {
    const wired = pluginCanaryWired(CANARY_YML);
    expect(wired.hasScript).toBe(true);
    expect(wired.hasId).toBe(true);
    expect(wired.hasOutcome).toBe(true);
    expect(wired.hasContinue).toBe(false);
    expect(wired.wired).toBe(true);
  });

  test("verdict pass requires PLUGIN_OUTCOME=success — a skipped plugin cannot promote", () => {
    expect(CANARY_YML).toContain("PLUGIN_OUTCOME");
    expect(CANARY_YML).toMatch(/PLUGIN_OUTCOME" = "success"/);
    expect(CANARY_YML).not.toMatch(/plugin:[\s\S]{0,200}continue-on-error:\s*true/);
    expect(CANARY_YML).not.toContain("continue-on-error");
  });

  test("releasing.md names the published-adapter step", () => {
    expect(RELEASING).toContain("flair-mcp");
    expect(RELEASING).toContain("flair-client");
    expect(RELEASING).toContain("check-plugin-canary.mjs");
  });

  test("the check script never imports the workspace packages", () => {
    expect(SCRIPT_SRC).not.toMatch(/from ["']\.\.\/\.\.\/packages\/flair-mcp/);
    expect(SCRIPT_SRC).not.toMatch(/from ["']\.\.\/\.\.\/packages\/flair-client/);
    expect(SCRIPT_SRC).toContain(FLAIR_MCP_PACKAGE);
    expect(SCRIPT_SRC).toContain(FLAIR_CLIENT_PACKAGE);
    expect(SCRIPT_SRC).toContain("DID NOT RUN");
    expect(SCRIPT_SRC).toMatch(/unmeasurable is FAIL/);
  });
});

describe("CLI refuses to pass when it cannot run", () => {
  test("missing --version is DID NOT RUN, not a pass", () => {
    const r = runGate([]);
    expect(r.status).toBe(EXIT_DID_NOT_RUN);
    expect(r.out).toContain("DID NOT RUN");
    expect(r.out).toContain("--version");
  });

  test("a non-semver version is DID NOT RUN", () => {
    const r = runGate(["--version", "latest"]);
    expect(r.status).toBe(EXIT_DID_NOT_RUN);
    expect(r.out).toMatch(/semver|DID NOT RUN/);
  });

  test("--skip / --dry-run is DID NOT RUN — there is no skip path", () => {
    const r = runGate(["--version", "0.54.2", "--skip"]);
    expect(r.status).toBe(EXIT_DID_NOT_RUN);
    expect(r.out).toContain("unknown argument");
    expect(r.out).toContain("unmeasurable is FAIL");
  });

  test("--help exits 0 without installing", () => {
    const r = runGate(["--help"]);
    expect(r.status).toBe(EXIT_OK);
    expect(r.out).toContain("--version");
  });

  test("parseArgs reads the required flags", () => {
    const a = parseArgs([
      "--version",
      "1.2.3",
      "--flair-url",
      "http://127.0.0.1:19926",
      "--agent",
      "canary",
      "--key-path",
      "/tmp/canary.key",
    ]);
    expect(a.version).toBe("1.2.3");
    expect(a.flairUrl).toBe("http://127.0.0.1:19926");
    expect(a.agent).toBe("canary");
    expect(a.keyPath).toBe("/tmp/canary.key");
    expect(a.unknown).toBe("");
  });
});

describe("documented host wiring is the pinned npx spec", () => {
  test("registrySpec refuses a dist-tag", () => {
    expect(() => registrySpec(FLAIR_MCP_PACKAGE, "latest")).toThrow(/semver/);
    expect(registrySpec(FLAIR_MCP_PACKAGE, "0.54.2")).toBe(`${FLAIR_MCP_PACKAGE}@0.54.2`);
    expect(registrySpec(FLAIR_CLIENT_PACKAGE, "0.54.2")).toBe(`${FLAIR_CLIENT_PACKAGE}@0.54.2`);
  });

  test("documented config is npx -y @tpsdev-ai/flair-mcp@<version>", () => {
    const cfg = documentedHostConfig("0.54.2", {
      agentId: "canary",
      flairUrl: "http://127.0.0.1:19926",
      keyPath: "/tmp/canary.key",
    });
    expect(cfg.mcpServers.flair.command).toBe("npx");
    expect(cfg.mcpServers.flair.args).toEqual(["-y", `${FLAIR_MCP_PACKAGE}@0.54.2`]);
    expect(cfg.mcpServers.flair.env.FLAIR_AGENT_ID).toBe("canary");
    expect(cfg.mcpServers.flair.env.FLAIR_URL).toBe("http://127.0.0.1:19926");
    expect(cfg.mcpServers.flair.env.FLAIR_KEY_PATH).toBe("/tmp/canary.key");
    const { spec, error } = readDocumentedPin(cfg);
    expect(error).toBeNull();
    expect(pinCheck(spec, FLAIR_MCP_PACKAGE, "0.54.2").ok).toBe(true);
  });

  test("an unpinned bare spec fails pinCheck (flair#907 class)", () => {
    expect(pinCheck(FLAIR_MCP_PACKAGE, FLAIR_MCP_PACKAGE, "0.54.2").ok).toBe(false);
    expect(pinCheck(`${FLAIR_MCP_PACKAGE}@latest`, FLAIR_MCP_PACKAGE, "0.54.2").ok).toBe(false);
  });

  test("REQUIRED_TOOLS is the documented round-trip, not an empty list", () => {
    expect(REQUIRED_TOOLS.length).toBeGreaterThan(0);
    expect([...REQUIRED_TOOLS]).toEqual(["memory_store", "memory_get", "bootstrap"]);
  });
});

describe("published resolve refuses the workspace copy", () => {
  test("a path under packages/ is the workspace-copy failure", () => {
    const prefix = mkdtempSync(join(tmpdir(), "flair-plugin-canary-ws-"));
    try {
      const workspaceHit = join(WORKSPACE_PACKAGES, "flair-mcp", "dist", "index.js");
      const check = assertPublishedResolve(workspaceHit, prefix);
      expect(check.ok).toBe(false);
      expect(check.reason).toMatch(/workspace package/);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  test("a path under the throwaway prefix passes", () => {
    const prefix = mkdtempSync(join(tmpdir(), "flair-plugin-canary-ok-"));
    try {
      const inside = join(prefix, "node_modules", "@tpsdev-ai", "flair-mcp", "dist", "mcp-shim.cjs");
      expect(assertPublishedResolve(inside, prefix).ok).toBe(true);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  test("readInstalledVersion fails closed when the package is missing", () => {
    const prefix = mkdtempSync(join(tmpdir(), "flair-plugin-canary-miss-"));
    try {
      const got = readInstalledVersion(prefix, FLAIR_MCP_PACKAGE);
      expect(got.version).toBeNull();
      expect(got.error).toMatch(/missing/);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  test("readInstalledVersion returns the installed version when present", () => {
    const prefix = mkdtempSync(join(tmpdir(), "flair-plugin-canary-ver-"));
    try {
      const dir = join(prefix, "node_modules", "@tpsdev-ai", "flair-mcp");
      writeFileSync(join(prefix, "package.json"), "{}\n");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: FLAIR_MCP_PACKAGE, version: "0.54.2" }));
      const got = readInstalledVersion(prefix, FLAIR_MCP_PACKAGE);
      expect(got.error).toBeNull();
      expect(got.version).toBe("0.54.2");
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});
