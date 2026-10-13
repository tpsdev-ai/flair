/**
 * openclaw-flair under the pinned OpenClaw host's own config and plugin loaders.
 *
 * REAL host components (the pinned release, `openclaw-supported`):
 *   - the config reader and normalizer: the gateway's `loadConfig()`, which
 *     resolves its file from `OPENCLAW_CONFIG_PATH` / `OPENCLAW_STATE_DIR`,
 *     parses it, validates it against the host schema and the plugin manifest,
 *     and materializes the runtime config;
 *   - the plugin loader (`loadOpenClawPlugins`): discovery from
 *     `plugins.load.paths`, the plugin's `api` (`api.config`, `api.pluginConfig`,
 *     `api.runtime.version`, `api.logger`), and its typed-hook registration
 *     gate on `plugins.entries.<id>.hooks.allowConversationAccess`;
 *   - the hook runner (`createHookRunner`), built from the registry that loader
 *     returned.
 * The host loads the plugin itself, from this package's `index.ts`.
 *
 * SYNTHETIC: the `agent_end` event and its hook context. They follow the host's
 * types (`PluginHookAgentEndEvent`, `PluginHookAgentContext`): the session id is
 * carried on the context, as the host carries it. Network is a stub on
 * `globalThis.fetch` inside the host process, so every request the plugin makes
 * is recorded and nothing leaves the process.
 *
 * The host runs in a child Node process. The pinned host declares a Node engine
 * range and imports Node builtins that Bun does not provide. A fresh process
 * also keeps the host's process-wide state away from the other test files. Its
 * environment is built from scratch: HOME, TMPDIR, the state dir, the config
 * path and the key dir all point into one temporary directory, removed after
 * each test. Two host defaults that are fixed system paths are redirected into
 * that directory through the host's own controls: the file log
 * (`logging.file` in the config) and the state-lock directory (the host's
 * `withStateDatabaseCoordinatorRuntimeDirectory` scope around the run). On a
 * Node outside the host's declared engine range the host itself is
 * unsupported, so these cases are skipped with the reason printed.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const PLUGIN_ID = "openclaw-flair";
const PLUGIN_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
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
 * `needle`. Chunk names carry a build hash, so they are found by content, the
 * way `runnerEntry` in plugin.test.ts finds the runner.
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
  console.warn(`host-config-loader: skipping the real-host cases: ${NODE.skip}`);
}
const hostTest = "skip" in NODE ? test.skip : test;

// ── the host-side driver (runs in the child) ─────────────────────────────────
//
// Plain ESM so the host's own runtime runs it unmodified. It reads a spec,
// drives config -> loader -> runner, and writes what it observed to a result
// file. Host functions are picked by their (unhashed) function names.
const DRIVER = String.raw`
import { readFileSync, writeFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = { stage: "start", logs: [], calls: [] };
const save = () => writeFileSync(spec.resultPath, JSON.stringify(out));

try {
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers ?? {};
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    out.calls.push({
      url: String(url),
      method: init.method ?? "GET",
      authorization: (typeof headers.get === "function" ? headers.get("Authorization") : headers["Authorization"]) ?? null,
      body,
    });
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
  const createHookRunner = pick(await import(spec.modules.runner), "createHookRunner");
  const withLockDirectory = pick(await import(spec.modules.locks), "withStateDatabaseCoordinatorRuntimeDirectory");

  // The host keeps its state-lock files under a fixed system directory unless
  // the caller scopes one; keep them inside this run's temp tree.
  await withLockDirectory(spec.lockDir, () => drive({ loadConfig, loadOpenClawPlugins, createHookRunner, logger }));
} catch (err) {
  out.error = String(err?.stack ?? err);
}
save();
process.exit(0);

async function drive({ loadConfig, loadOpenClawPlugins, createHookRunner, logger }) {
  out.stage = "config";
  const config = loadConfig();
  out.configAgents = Object.keys(config.agents?.entries ?? {});
  out.configEntry = config.plugins?.entries?.[spec.pluginId] ?? null;

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
    ? { status: plugin.status, origin: plugin.origin, source: plugin.source, error: plugin.error ? String(plugin.error) : null }
    : null;
  out.pluginHooks = registry.typedHooks.filter((h) => h.pluginId === spec.pluginId).map((h) => h.hookName);
  out.pluginDiagnostics = registry.diagnostics
    .filter((d) => d.pluginId === spec.pluginId)
    .map((d) => d.level + ": " + d.message);

  // The plugin's status service reports the host version it was handed.
  const status = registry.services.find((s) => s.pluginId === spec.pluginId && s.id === "openclaw-flair-status");
  if (status) await status.service.start({ logger });

  out.stage = "run";
  const runner = createHookRunner(registry, { catchErrors: false });
  out.hasAgentEnd = runner.hasHooks("agent_end");
  await runner.runAgentEnd(spec.event, spec.ctx);
  out.stage = "done";
}
`;

// ── one host run per test, in its own temp tree ──────────────────────────────

interface HostCall { url: string; method: string; authorization: string | null; body: any }
interface HostResult {
  stage: string;
  error?: string;
  logs: Array<{ level: string; message: string }>;
  calls: HostCall[];
  configAgents?: string[];
  configEntry?: any;
  plugin?: { status: string; origin: string; source: string; error: string | null } | null;
  pluginHooks?: string[];
  pluginDiagnostics?: string[];
  hasAgentEnd?: boolean;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RUN_ID = "run-hostcfg-0001";
const SESSION_ID = "session-hostcfg-0001";
const CAPTURE_TEXT = "remember this: the host config loader delivered this turn";

/** `hooks` is the `plugins.entries["openclaw-flair"].hooks` block, or undefined for none. */
async function runHost(hooks: Record<string, unknown> | undefined): Promise<HostResult> {
  if ("skip" in NODE) throw new Error(NODE.skip);
  const root = mkdtempSync(join(tmpdir(), "ocf-hostcfg-"));
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
        [PLUGIN_ID]: {
          enabled: true,
          ...(hooks !== undefined ? { hooks } : {}),
          config: { url: "http://127.0.0.1:19926", autoCapture: true },
        },
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
      runner: pathToFileURL(hostChunk(HOST.dist, /^hooks-.*\.mjs$/, "export { createHookRunner };")).href,
      locks: pathToFileURL(
        hostChunk(HOST.dist, /^sqlite-source-handle-.*\.mjs$/, "function withStateDatabaseCoordinatorRuntimeDirectory("),
      ).href,
    },
    event: {
      runId: RUN_ID,
      success: true,
      durationMs: 12,
      messages: [{ role: "user", content: CAPTURE_TEXT, timestamp: 1 }],
    },
    ctx: { agentId: AGENT, sessionId: SESSION_ID },
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

function memoryWrites(result: HostResult): HostCall[] {
  return result.calls.filter((call) => call.method === "PUT" && /\/Memory\//.test(call.url));
}

function pluginLines(result: HostResult, level: string): string[] {
  return result.logs.filter((l) => l.level === level && l.message.startsWith("openclaw-flair")).map((l) => l.message);
}

// ── cases ─────────────────────────────────────────────────────────────────────

describe(`pinned host ${HOST.version}: config file -> host loader -> host runner`, () => {
  hostTest("GRANTED: allowConversationAccess=true registers agent_end, and one real-runner delivery makes one Memory PUT", async () => {
    const result = await runHost({ allowConversationAccess: true });
    expect(result.error ?? null).toBeNull();
    expect(result.stage).toBe("done");

    // The host's config reader carried the file's roster and grant through.
    expect(result.configAgents).toEqual([AGENT]);
    expect(result.configEntry?.hooks).toEqual({ allowConversationAccess: true });

    // The host loaded THIS package's source, from the configured load path.
    expect(result.plugin).not.toBeNull();
    expect(result.plugin!.status).toBe("loaded");
    expect(result.plugin!.origin).toBe("config");
    expect(realpathSync(result.plugin!.source)).toBe(realpathSync(PLUGIN_ENTRY));

    // The host handed the plugin a tested version, so registration ran fully.
    expect(pluginLines(result, "warn").filter((m) => m.startsWith("openclaw-flair disabled"))).toEqual([]);
    expect(pluginLines(result, "info").some((m) => m.includes(`host=${HOST.version} `) && m.includes("capture=allowed"))).toBe(true);

    // The host's registration gate admitted the conversation hook.
    expect(result.pluginHooks).toContain("agent_end");
    expect(result.hasAgentEnd).toBe(true);

    // One delivery through the host's runner: exactly one signed Memory write.
    const writes = memoryWrites(result);
    expect(writes).toHaveLength(1);
    expect(writes[0].body.hostSource).toEqual({ v: 1, host: "openclaw", kind: "run", id: RUN_ID });
    expect(writes[0].body.agentId).toBe(AGENT);
    expect(writes[0].body.sessionId).toBe(SESSION_ID);
    expect(writes[0].body.content).toBe(CAPTURE_TEXT);
    expect(writes[0].authorization ?? "").toMatch(new RegExp(`^TPS-Ed25519 ${AGENT}:`));
    expect(result.calls).toHaveLength(1);
  }, CHILD_TIMEOUT_MS + 15_000);

  for (const [label, hooks] of [
    ["the hooks block is absent", undefined],
    ["allowConversationAccess=false", { allowConversationAccess: false }],
  ] as const) {
    hostTest(`WITHHELD (${label}): agent_end is not registered and a real-runner delivery sends nothing`, async () => {
      const result = await runHost(hooks);
      expect(result.error ?? null).toBeNull();
      expect(result.stage).toBe("done");
      expect(result.configAgents).toEqual([AGENT]);
      expect(result.configEntry?.hooks?.allowConversationAccess === true).toBe(false);

      // Loaded and registered past the version and identity gates: the absence
      // below is the permission gate, not a load failure.
      expect(result.plugin?.status).toBe("loaded");
      expect(pluginLines(result, "warn").filter((m) => m.startsWith("openclaw-flair disabled"))).toEqual([]);
      expect(pluginLines(result, "warn")).toContain("openclaw-flair: capture disabled (permission)");
      expect(pluginLines(result, "info").some((m) => m.includes("capture=withheld"))).toBe(true);

      // No conversation hook reached the host's registry or its runner. The
      // plugin reads the same host config and requests none of them, so the
      // host's own "typed hook ... blocked" diagnostic has nothing to report;
      // either gate refusing leaves this outcome.
      for (const hook of ["agent_end", "llm_input", "llm_output"]) {
        expect(result.pluginHooks).not.toContain(hook);
      }
      expect(result.hasAgentEnd).toBe(false);

      // The delivery through the host's runner made zero requests.
      expect(result.calls).toEqual([]);
    }, CHILD_TIMEOUT_MS + 15_000);
  }
});
