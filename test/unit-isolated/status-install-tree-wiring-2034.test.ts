/**
 * status-install-tree-wiring-2034.test.ts — flair#2034 §2.
 *
 * Drives the REAL `flair status` action with bound fakes (no Harper, network,
 * launchd or HOME) and proves: the install tree is asked about with the pid
 * and version the ANSWERING process reported, only as a local query when the
 * URL is this instance's; a proven divergence prints its block once and
 * replaces the CLI's "run: flair upgrade" nudge; and `status --json` carries
 * the same comparison. mock.module is process-global, hence unit-isolated.
 */
import { describe, test, expect, mock, spyOn } from "bun:test";
import { assessTreeDivergence } from "../../src/lib/tree-divergence.ts";

const NUDGE = "flair 0.55.2 is behind — latest is 0.57.0 (2 minor versions behind). Run: flair upgrade";
mock.module("../../src/version-check.js", () => ({
  checkVersion: async () => ({ latest: "0.57.0", installed: "0.55.2", source: "network" }),
  formatVersionNudge: () => ({ severity: "yellow", message: NUDGE }),
  FLAIR_PKG_NAME: "@tpsdev-ai/flair",
}));
mock.module("../../src/lib/npm-registry.js", () => ({ resolveRegistryNotice: async () => ({}) }));

const { Command } = await import("commander");
const { bindCli, register } = await import("../../src/commands/status.ts");

const OLD_TREE = "/u/.local/share/mise/installs/node/24.18.0/lib/node_modules/@tpsdev-ai/flair";
const NEW_TREE = "/u/.local/share/mise/installs/node/24.19.0/lib/node_modules/@tpsdev-ai/flair";
const diverged = assessTreeDivergence({
  cli: { dir: NEW_TREE, version: "0.55.2" },
  serving: {
    kind: "proven",
    dir: OLD_TREE,
    version: "0.57.0",
    pid: 4242,
    manager: "launchd",
    unitName: "ai.tpsdev.flair.abcd1234",
    unitPath: "/u/Library/LaunchAgents/ai.tpsdev.flair.abcd1234.plist",
    unitNodeBin: null,
    unitTree: OLD_TREE,
    dropInPaths: [],
  },
  runningVersion: "0.57.0",
  currentNodeBin: "/n",
  samePath: (a, b) => a === b,
});

async function status(args: string[], baseUrl = "http://127.0.0.1:9926") {
  const asked: any[] = [];
  bindCli({
    fetchHealthDetail: async () => ({ healthy: true, baseUrl, healthData: { version: "0.57.0", pid: 4242 } }),
    humanBytes: (n: number) => String(n),
    relativeTime: () => "t",
    resolveSigningAgentId: () => ({ agentId: undefined, source: "none" }),
    sortSoulKeyEntries: () => [],
    defaultDataDir: () => "/u/.flair/data",
    readHarperConfig: () => null,
    readPortFromConfig: () => null,
    resolveHttpPort: () => 9926,
    assessInstallTree: (_dataDir: string, _port: number, query: unknown) => {
      asked.push(query);
      return diverged;
    },
    __pkgVersion: "0.55.2",
  });
  const program = new Command();
  register(program);
  const out: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...items: unknown[]) => { out.push(items.map(String).join(" ")); });
  try {
    await program.parseAsync(["status", ...args], { from: "user" });
  } finally {
    spy.mockRestore();
  }
  return { text: out.join("\n"), asked };
}

describe("flair status wiring (#2034)", () => {
  test("a proven divergence prints once and replaces the upgrade nudge", async () => {
    const { text, asked } = await status([]);
    expect(asked).toEqual([{ local: true, queryUrl: "http://127.0.0.1:9926", respondingPid: 4242, runningVersion: "0.57.0" }]);
    expect(text.split("DIFFERENT install trees")).toHaveLength(2);
    expect(text).toContain(OLD_TREE);
    expect(text).not.toContain(NUDGE);
    expect(text.split("npm i -g @tpsdev-ai/flair")).toHaveLength(2);
  });

  test("--target is never a local query", async () => {
    const { asked } = await status(["--target", "https://hub.example"], "https://hub.example");
    expect((asked[0] as { local: boolean }).local).toBe(false);
  });

  test("status --json carries the same comparison", async () => {
    const { text } = await status(["--json"]);
    const j = JSON.parse(text) as Record<string, any>;
    expect(j.serverVersion).toBe("0.57.0");
    expect(j.installTree.state).toBe("diverged");
    expect(j.installTree.serving.dir).toBe(OLD_TREE);
    expect(j.installTree.remedy).toEqual(["npm i -g @tpsdev-ai/flair", "flair init", "flair restart"]);
  });
});
