/**
 * openclaw-flair's declared tools under the pinned OpenClaw host's own manifest
 * and registration path.
 *
 * REAL host components (the pinned release, `openclaw-supported`):
 *   - the manifest reader and normalizer: the host reads this package's
 *     `openclaw.plugin.json` and normalizes `contracts` with its own
 *     `normalizeManifestContracts` (each contract family is a list of strings);
 *   - the plugin loader (`loadOpenClawPlugins`): discovery from
 *     `plugins.load.paths`, the plugin's `api`, and the tool-registration gate
 *     that refuses a tool whose name is not among the manifest's declared
 *     `contracts.tools`;
 *   - the config reader and normalizer (`loadConfig`) that feeds the loader.
 * The host loads the plugin itself, from this package's `index.ts`.
 *
 * The host runs in a child Node process. The pinned host declares a Node engine
 * range and imports Node builtins that Bun does not provide. The environment is
 * built from scratch: HOME, TMPDIR, the state dir, the config path and the key
 * dir point into one temporary directory, removed after each test. Two host
 * defaults that are fixed system paths are redirected into that directory
 * through the host's own controls: the file log (`logging.file` in the config)
 * and the state-lock directory (the host's
 * `withStateDatabaseCoordinatorRuntimeDirectory` scope around the run). On a
 * Node outside the host's declared engine range the host itself is unsupported,
 * so these cases are skipped with the reason printed.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const PLUGIN_ID = "openclaw-flair";
const PLUGIN_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
/** The tools the manifest under test must declare (openclaw.plugin.json). */
const EXPECTED_TOOLS = ["memory_search", "memory_store", "memory_get"];
/** The one agent the host config declares; its key is keys/<AGENT>.key. */
const AGENT = "hostcfg-agent";
const CHILD_TIMEOUT_MS = 45_000;

// ── the pinned host ──────────────────────────────────────────────────────────

function pinnedHost(): { dist: string; version: string; nodeRange: string } {
  const dist = dirname(fileURLToPath(import.meta.resolve("openclaw-supported")));
  const pkg = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")) as {
    version: string;
    engines?: { node?: string };
  };
  return { dist, version: pkg.version, nodeRange: pkg.engines?.node ?? "*" };
}

/**
 * The dist chunk whose name matches `pattern` and whose source contains
 * `needle`. Chunk names carry a build hash, so they are found by content.
 */
function hostChunk(dist: string, pattern: RegExp, needle: string): string {
  const hits = readdirSync(dist).filter(
    (name) => pattern.test(name) && readFileSync(join(dist, name), "utf8").includes(needle),
  );
  if (hits.length !== 1) {
    throw new Error(`expected exactly one ${pattern} chunk containing ${JSON.stringify(needle)} in ${dist}, found ${hits.length}`);
  }
  return join(dist, hits[0]);
}

/** A Node that satisfies the pinned host's declared engine range, or why not. */
function hostNode(nodeRange: string): { path: string; version: string } | { skip: string } {
  const path = Bun.which("node");
  if (!path) return { skip: "no `node` on PATH" };
  const out = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  const version = out.stdout.toString().trim().replace(/^v/, "");
  if (out.exitCode !== 0 || !version) return { skip: `\`${path} --version\` failed` };
  if (!Bun.semver.satisfies(version, nodeRange)) {
    return { skip: `node ${version} is outside the pinned host's engines.node range ${nodeRange}` };
  }
  return { path, version };
}

const HOST = pinnedHost();
const NODE = hostNode(HOST.nodeRange);
if ("skip" in NODE) {
  console.warn(`manifest-tool-contract: skipping the real-host case: ${NODE.skip}`);
}
const hostTest = "skip" in NODE ? test.skip : test;

// ── the host-side driver (runs in the child) ─────────────────────────────────
//
// Plain ESM so the host's own runtime runs it unmodified. It reads a spec,
// drives config -> loader, and writes what it observed to a result file. Host
// functions are picked by their (unhashed) function names.
const DRIVER = String.raw`
import { readFileSync, writeFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = { stage: "start", logs: [], tools: [], diagnostics: [] };
const save = () => writeFileSync(spec.resultPath, JSON.stringify(out));

try {
  globalThis.fetch = async (url, init = {}) => {
    out.calls = out.calls ?? [];
    out.calls.push({ url: String(url), method: init.method ?? "GET" });
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const record = (level) => (message) => { out.logs.push({ level, message: String(message) }); };
  const logger = { info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") };
  const pick = (mod, name) => {
    const fn = Object.values(mod).find((value) => typeof value === "function" && value.name === name);
    if (!fn) throw new Error("the host chunk does not export " + name);
    return fn;
  };

  const loadConfig = pick(await import(spec.modules.config), "loadConfig");
  const loadOpenClawPlugins = pick(await import(spec.modules.loader), "loadOpenClawPlugins");
  const withLockDirectory = pick(await import(spec.modules.locks), "withStateDatabaseCoordinatorRuntimeDirectory");

  // The host keeps its state-lock files under a fixed system directory unless
  // the caller scopes one; keep them inside this run's temp tree.
  await withLockDirectory(spec.lockDir, () => drive({ loadConfig, loadOpenClawPlugins, logger }));
} catch (err) {
  out.error = String(err?.stack ?? err);
}
save();
process.exit(0);

async function drive({ loadConfig, loadOpenClawPlugins, logger }) {
  out.stage = "config";
  const config = loadConfig();
  out.configAgents = Object.keys(config.agents?.entries ?? {});

  out.stage = "load";
  const registry = loadOpenClawPlugins({
    config,
    logger,
    onlyPluginIds: [spec.pluginId],
    cache: false,
    activate: false,
  });
  const plugin = registry.plugins.find((p) => p.id === spec.pluginId);
  out.plugin = plugin
    ? {
        status: plugin.status,
        origin: plugin.origin,
        source: plugin.source,
        error: plugin.error ? String(plugin.error) : null,
        contracts: plugin.contracts ?? null,
      }
    : null;
  out.tools = registry.tools
    .filter((t) => t.pluginId === spec.pluginId)
    .map((t) => ({ names: t.names, declaredNames: t.declaredNames }));
  out.diagnostics = registry.diagnostics
    .filter((d) => d.pluginId === spec.pluginId)
    .map((d) => d.level + ": " + d.message);
  out.stage = "done";
}
`;

// ── one host run per test, in its own temp tree ──────────────────────────────

interface HostResult {
  stage: string;
  error?: string;
  logs: Array<{ level: string; message: string }>;
  calls?: Array<{ url: string; method: string }>;
  configAgents?: string[];
  plugin?: {
    status: string;
    origin: string;
    source: string;
    error: string | null;
    contracts: { tools?: string[] } | null;
  } | null;
  tools?: Array<{ names: string[]; declaredNames: string[] }>;
  diagnostics?: string[];
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runHost(): Promise<HostResult> {
  if ("skip" in NODE) throw new Error(NODE.skip);
  const root = mkdtempSync(join(tmpdir(), "ocf-manifest-"));
  tempRoots.push(root);
  const dirs = {
    home: join(root, "home"),
    state: join(root, "state"),
    keys: join(root, "keys"),
    tmp: join(root, "tmp"),
    locks: join(root, "locks"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

  const keyFile = join(dirs.keys, `${AGENT}.key`);
  writeFileSync(keyFile, randomBytes(32));
  chmodSync(keyFile, 0o600);

  // The host's own config shape: a keyed `agents.entries` roster (one agent),
  // the plugin loaded from this package's source, selected for the memory slot,
  // and the host's file log kept inside the temp tree.
  const configPath = join(root, "openclaw.json");
  writeFileSync(configPath, JSON.stringify({
    logging: { file: join(root, "openclaw.log") },
    agents: { entries: { [AGENT]: {} } },
    plugins: {
      load: { paths: [PLUGIN_ENTRY] },
      slots: { memory: PLUGIN_ID },
      entries: {
        [PLUGIN_ID]: { enabled: true, config: { url: "http://127.0.0.1:19926" } },
      },
    },
  }, null, 2));

  const resultPath = join(root, "result.json");
  const specPath = join(root, "spec.json");
  writeFileSync(specPath, JSON.stringify({
    resultPath,
    lockDir: dirs.locks,
    pluginId: PLUGIN_ID,
    modules: {
      config: pathToFileURL(hostChunk(HOST.dist, /^io\.runtime-.*\.mjs$/, "function loadConfig(options)")).href,
      loader: pathToFileURL(hostChunk(HOST.dist, /^loader-runtime-load-.*\.mjs$/, "function loadOpenClawPlugins(")).href,
      locks: pathToFileURL(
        hostChunk(HOST.dist, /^sqlite-source-handle-.*\.mjs$/, "function withStateDatabaseCoordinatorRuntimeDirectory("),
      ).href,
    },
  }));
  const driverPath = join(root, "driver.mjs");
  writeFileSync(driverPath, DRIVER);

  const child = Bun.spawn([NODE.path, driverPath, specPath], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dirs.home,
      TMPDIR: dirs.tmp,
      OPENCLAW_STATE_DIR: dirs.state,
      OPENCLAW_CONFIG_PATH: configPath,
      FLAIR_KEY_DIR: dirs.keys,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (!existsSync(resultPath)) {
    throw new Error(`host child exited ${exitCode} without a result\n--- stdout\n${stdout}\n--- stderr\n${stderr}`);
  }
  return JSON.parse(readFileSync(resultPath, "utf8")) as HostResult;
}

function contractRefusals(result: HostResult): string[] {
  return (result.diagnostics ?? []).filter((line) => line.includes("contracts.tools"));
}

function registeredToolNames(result: HostResult): string[] {
  return (result.tools ?? []).flatMap((entry) => entry.names);
}

// ── cases ─────────────────────────────────────────────────────────────────────

describe(`pinned host ${HOST.version}: manifest contracts.tools -> host registration`, () => {
  hostTest("registers memory_search, memory_store and memory_get", async () => {
    const result = await runHost();
    expect(result.error ?? null).toBeNull();
    expect(result.stage).toBe("done");

    // The host's config reader carried the file's roster through.
    expect(result.configAgents).toEqual([AGENT]);

    // The host loaded THIS package's source, from the configured load path.
    expect(result.plugin).not.toBeNull();
    expect(result.plugin!.status).toBe("loaded");
    expect(realpathSync(result.plugin!.source)).toBe(realpathSync(PLUGIN_ENTRY));

    // No tool was refused for an undeclared name.
    expect(contractRefusals(result)).toEqual([]);

    // The three tools registered through the host's own registration path,
    // each carrying the manifest's declared names.
    const names = registeredToolNames(result);
    expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const entry of result.tools!) {
      expect(entry.declaredNames).toEqual(EXPECTED_TOOLS);
    }

    // The host read this package's manifest and normalized its contracts.tools
    // to the three tool-name strings.
    expect(result.plugin!.contracts).toEqual({ tools: EXPECTED_TOOLS });

    // Registration makes no outgoing request.
    expect(result.calls ?? []).toEqual([]);
  }, CHILD_TIMEOUT_MS + 15_000);
});
