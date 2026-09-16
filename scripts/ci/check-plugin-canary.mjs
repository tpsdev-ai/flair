#!/usr/bin/env node
/**
 * check-plugin-canary.mjs — published-adapter canary (flair#1338).
 *
 * The post-publish canary (#1698/#1702) installs and boots `@tpsdev-ai/flair`.
 * It does not install the adapters a host actually runs. That is the delta
 * that let the #1323/#1332/#1336 class ship through green CI: we tested our
 * tree against our Harper, not the pip/npm-installed package driven the way
 * a user drives it.
 *
 * This script is the adapter half of that canary:
 *
 *   1. Install `@tpsdev-ai/flair-mcp@<ver>` and `@tpsdev-ai/flair-client@<ver>`
 *      from the public registry, exact version, never a dist-tag, into a
 *      throwaway prefix. Workspace `packages/` must not be on the resolve path.
 *   2. Write the documented host config (`npx -y @tpsdev-ai/flair-mcp@<ver>`
 *      plus FLAIR_AGENT_ID / FLAIR_URL / FLAIR_KEY_PATH) — the snippet in
 *      docs/mcp-clients.md, not an in-process import of our sources.
 *   3. Drive that config as an MCP host: initialize, tools/list, then a real
 *      memory_store → memory_get round-trip over stdio.
 *   4. Import FlairClient from the installed prefix (not the repo) and do a
 *      second write → get against the same running instance.
 *
 * The running Flair is the canary-booted instance (#1698). From the adapter's
 * side that is the hosted path: HTTP + Ed25519 key, not an in-process call.
 * A real Fabric TLS cluster is out of scope here — the canary is
 * credential-less by construction.
 *
 * Exit codes (same family as the other check scripts):
 *   0 — ran, every assertion passed
 *   1 — ran, an assertion failed
 *   2 — DID NOT RUN (missing version, registry miss, install failed, host
 *       unreachable). Never green. Unmeasurable is FAIL.
 *
 * Usage:
 *   node scripts/ci/check-plugin-canary.mjs --version <ver> \
 *     [--flair-url <url>] [--agent <id>] [--key-path <path>] \
 *     [--flair-bin <path>] [--prefix <dir>] [--keep]
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_DID_NOT_RUN = 2;

export const FLAIR_MCP_PACKAGE = "@tpsdev-ai/flair-mcp";
export const FLAIR_CLIENT_PACKAGE = "@tpsdev-ai/flair-client";

/** Tools the documented host path must expose and that the round-trip uses. */
export const REQUIRED_TOOLS = Object.freeze(["memory_store", "memory_get", "bootstrap"]);

export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
export const WORKSPACE_PACKAGES = join(REPO_ROOT, "packages");

export function parseArgs(argv) {
  const out = {
    version: "",
    flairUrl: "",
    agent: "canary",
    keyPath: "",
    flairBin: "",
    prefix: "",
    keep: false,
    help: false,
    unknown: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") out.version = argv[++i] ?? "";
    else if (a === "--flair-url") out.flairUrl = argv[++i] ?? "";
    else if (a === "--agent") out.agent = argv[++i] ?? out.agent;
    else if (a === "--key-path") out.keyPath = argv[++i] ?? "";
    else if (a === "--flair-bin") out.flairBin = argv[++i] ?? "";
    else if (a === "--prefix") out.prefix = argv[++i] ?? "";
    else if (a === "--keep") out.keep = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--skip" || a === "--skip-live" || a === "--dry-run") {
      out.unknown = a;
    } else {
      out.unknown = a;
    }
  }
  return out;
}

/** Exact-version registry spec. Never a dist-tag. */
export function registrySpec(packageName, version) {
  const value = String(version ?? "").trim();
  if (!VERSION_RE.test(value)) {
    throw new Error(`version must be a semver (e.g. 0.54.2), got '${version}'`);
  }
  return `${packageName}@${value}`;
}

/**
 * The documented host snippet (docs/mcp-clients.md): npx + pinned package
 * + the three env vars a remote/hosted adapter needs.
 */
export function documentedHostConfig(version, env) {
  return {
    mcpServers: {
      flair: {
        command: "npx",
        args: ["-y", registrySpec(FLAIR_MCP_PACKAGE, version)],
        env: {
          FLAIR_AGENT_ID: env.agentId,
          FLAIR_URL: env.flairUrl,
          ...(env.keyPath ? { FLAIR_KEY_PATH: env.keyPath } : {}),
        },
      },
    },
  };
}

export function readDocumentedPin(config) {
  const args = config?.mcpServers?.flair?.args;
  if (!Array.isArray(args)) return { spec: null, error: "mcpServers.flair.args missing" };
  const spec = args.find((a) => typeof a === "string" && a.includes(FLAIR_MCP_PACKAGE));
  if (!spec) return { spec: null, error: `${FLAIR_MCP_PACKAGE} missing from args` };
  return { spec, error: null };
}

export function pinCheck(spec, packageName, version) {
  if (!spec || typeof spec !== "string") return { ok: false, reason: "no spec written" };
  if (spec === packageName || spec === `npm:${packageName}`) {
    return { ok: false, reason: `unpinned bare spec: ${spec}` };
  }
  const expected = `${packageName}@${version}`;
  if (spec !== expected) return { ok: false, reason: `expected ${expected}, got ${spec}` };
  return { ok: true, reason: expected };
}

/**
 * A resolved file must live under the throwaway prefix, never under
 * `packages/` in this checkout. Resolving the workspace copy is the
 * #1323/#1332 class: we tested the code we wrote, not the artifact a user
 * installs.
 */
export function assertPublishedResolve(resolvedPath, prefix) {
  const abs = resolve(String(resolvedPath));
  const prefixAbs = resolve(String(prefix));
  const prefixRoot = prefixAbs.endsWith(sep) ? prefixAbs : prefixAbs + sep;
  if (!abs.startsWith(prefixRoot) && abs !== prefixAbs) {
    return { ok: false, reason: `resolved outside prefix: ${abs}` };
  }
  const wsRoot = WORKSPACE_PACKAGES.endsWith(sep) ? WORKSPACE_PACKAGES : WORKSPACE_PACKAGES + sep;
  if (abs.startsWith(wsRoot)) {
    return { ok: false, reason: `resolved workspace package, not the published install: ${abs}` };
  }
  return { ok: true, reason: abs };
}

export function readInstalledVersion(prefix, packageName) {
  const pkgJson = join(prefix, "node_modules", ...packageName.split("/"), "package.json");
  if (!existsSync(pkgJson)) return { version: null, path: pkgJson, error: `missing ${pkgJson}` };
  try {
    const parsed = JSON.parse(readFileSync(pkgJson, "utf8"));
    return { version: parsed.version ?? null, path: pkgJson, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { version: null, path: pkgJson, error: msg };
  }
}

export function pluginCanaryWired(yml) {
  const hasScript = yml.includes("scripts/ci/check-plugin-canary.mjs");
  const hasId = /^\s+id:\s+plugin\s*$/m.test(yml);
  const hasOutcome = yml.includes("PLUGIN_OUTCOME") && yml.includes("steps.plugin.outcome");
  const hasContinue = /plugin[\s\S]{0,400}continue-on-error:\s*true/.test(yml);
  return { hasScript, hasId, hasOutcome, hasContinue, wired: hasScript && hasId && hasOutcome && !hasContinue };
}

function dieDidNotRun(msg) {
  console.error(`DID NOT RUN: ${msg}`);
  return EXIT_DID_NOT_RUN;
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  return EXIT_FAIL;
}

function npmView(spec) {
  const r = spawnSync("npm", ["view", spec, "version"], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0) return { ok: false, version: "", detail: out.split("\n")[0] ?? "npm view failed" };
  const version = (r.stdout ?? "").trim();
  if (!VERSION_RE.test(version)) return { ok: false, version, detail: `npm view ${spec} did not print a semver` };
  return { ok: true, version, detail: version };
}

function npmInstall(prefix, specs) {
  const r = spawnSync("npm", ["install", "--prefix", prefix, ...specs], {
    encoding: "utf8",
    timeout: 180_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

async function waitHealth(url, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      last = `HTTP ${res.status}`;
      if (res.ok) return { ok: true, detail: last };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { ok: false, detail: last };
}

function startFlair(flairBin, port) {
  const r = spawnSync(flairBin, ["start", "--port", String(port)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function portFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return 19926;
  }
}

function resolveFromPrefix(prefix, specifier) {
  const require = createRequire(join(prefix, "package.json"));
  return require.resolve(specifier);
}

function toolText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n");
}

async function driveMcpRoundTrip(opts) {
  const { Client } = await import(pathToFileURL(opts.clientModule).href);
  const stdio = await import(pathToFileURL(opts.stdioModule).href);
  const transport = new stdio.StdioClientTransport({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    stderr: "pipe",
    env: {
      ...(typeof stdio.getDefaultEnvironment === "function" ? stdio.getDefaultEnvironment() : process.env),
      ...opts.env,
      FLAIR_MCP_PARENT_POLL_MS: "30000",
    },
  });
  const client = new Client({ name: "flair-plugin-canary", version: "0.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = (listed.tools ?? []).map((t) => t.name);
    const missing = REQUIRED_TOOLS.filter((t) => !names.includes(t));
    if (missing.length > 0) {
      return { ok: false, reason: `tools/list missing ${missing.join(", ")} (have: ${names.join(", ") || "(none)"})` };
    }
    const token = `plugin-canary-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const stored = await client.callTool({
      name: "memory_store",
      arguments: {
        content: token,
        type: "fact",
        durability: "standard",
        tags: ["plugin-canary"],
      },
    });
    if (stored.isError) return { ok: false, reason: `memory_store isError: ${toolText(stored)}` };
    const id = stored.structuredContent?.id;
    if (!id || typeof id !== "string") {
      return { ok: false, reason: `memory_store did not return an id (text: ${toolText(stored).slice(0, 200)})` };
    }
    const got = await client.callTool({ name: "memory_get", arguments: { id } });
    if (got.isError) return { ok: false, reason: `memory_get isError: ${toolText(got)}` };
    const text = toolText(got);
    if (!text.includes(token)) {
      return { ok: false, reason: `memory_get did not echo the stored token (id=${id})` };
    }
    return { ok: true, reason: `mcp round-trip id=${id}`, id, token };
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

async function driveClientRoundTrip(opts) {
  const mod = await import(pathToFileURL(opts.clientModule).href);
  const FlairClient = mod.FlairClient;
  if (typeof FlairClient !== "function") {
    return { ok: false, reason: "published flair-client did not export FlairClient" };
  }
  const flair = new FlairClient({
    agentId: opts.agentId,
    url: opts.flairUrl,
    keyPath: opts.keyPath || undefined,
  });
  const token = `plugin-canary-client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const written = await flair.memory.write(token, {
    type: "fact",
    durability: "standard",
    tags: ["plugin-canary"],
  });
  if (!written?.id) return { ok: false, reason: "FlairClient.memory.write returned no id" };
  const got = await flair.memory.get(written.id);
  if (!got) return { ok: false, reason: `FlairClient.memory.get(${written.id}) returned null` };
  if (!String(got.content ?? "").includes(token)) {
    return { ok: false, reason: `FlairClient.memory.get did not echo the stored token (id=${written.id})` };
  }
  return { ok: true, reason: `client round-trip id=${written.id}`, id: written.id, token };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node scripts/ci/check-plugin-canary.mjs --version <ver> [--flair-url <url>] [--agent <id>] [--key-path <path>] [--flair-bin <path>] [--prefix <dir>]",
    );
    return EXIT_OK;
  }
  if (args.unknown) {
    return dieDidNotRun(
      `unknown argument: ${args.unknown} — this check has no skip/dry-run; unmeasurable is FAIL`,
    );
  }
  if (!args.version) return dieDidNotRun("missing --version <semver>");
  let mcpSpec;
  let clientSpec;
  try {
    mcpSpec = registrySpec(FLAIR_MCP_PACKAGE, args.version);
    clientSpec = registrySpec(FLAIR_CLIENT_PACKAGE, args.version);
  } catch (err) {
    return dieDidNotRun(err instanceof Error ? err.message : String(err));
  }

  const flairUrl = (args.flairUrl || process.env.FLAIR_URL || "http://127.0.0.1:19926").replace(/\/$/, "");
  const agentId = args.agent || process.env.FLAIR_AGENT_ID || "canary";
  const keyPath =
    args.keyPath ||
    process.env.FLAIR_KEY_PATH ||
    join(process.env.HOME || "", ".flair", "keys", `${agentId}.key`);

  const ownPrefix = !args.prefix;
  const prefix = args.prefix ? resolve(args.prefix) : mkdtempSync(join(tmpdir(), "flair-plugin-canary-"));
  mkdirSync(prefix, { recursive: true });
  if (ownPrefix || !existsSync(join(prefix, "package.json"))) {
    writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "flair-plugin-canary", private: true }, null, 2));
  }

  console.log(`[plugin-canary] version=${args.version} prefix=${prefix}`);
  console.log(`[plugin-canary] specs: ${mcpSpec} ${clientSpec}`);

  const viewedMcp = npmView(mcpSpec);
  if (!viewedMcp.ok) return dieDidNotRun(`could not resolve ${mcpSpec}: ${viewedMcp.detail}`);
  const viewedClient = npmView(clientSpec);
  if (!viewedClient.ok) return dieDidNotRun(`could not resolve ${clientSpec}: ${viewedClient.detail}`);
  if (viewedMcp.version !== args.version) {
    return dieDidNotRun(`npm view ${mcpSpec} printed ${viewedMcp.version}, not the dispatched version`);
  }
  if (viewedClient.version !== args.version) {
    return dieDidNotRun(`npm view ${clientSpec} printed ${viewedClient.version}, not the dispatched version`);
  }
  console.log(`[plugin-canary] registry has both packages at ${args.version}`);

  const install = npmInstall(prefix, [mcpSpec, clientSpec]);
  if (install.status !== 0) {
    console.error(install.output.split("\n").slice(-20).join("\n"));
    return dieDidNotRun(`npm install ${mcpSpec} ${clientSpec} failed (unmeasurable is FAIL)`);
  }
  console.log(`[plugin-canary] installed ${mcpSpec} and ${clientSpec} into prefix`);

  for (const name of [FLAIR_MCP_PACKAGE, FLAIR_CLIENT_PACKAGE]) {
    const installed = readInstalledVersion(prefix, name);
    if (installed.error) return fail(`${name}: ${installed.error}`);
    if (installed.version !== args.version) {
      return fail(`${name} installed version ${installed.version}, expected ${args.version}`);
    }
  }

  let mcpBin;
  let clientEntry;
  let sdkClient;
  let sdkStdio;
  try {
    mcpBin = resolveFromPrefix(prefix, `${FLAIR_MCP_PACKAGE}/dist/mcp-shim.cjs`);
    clientEntry = resolveFromPrefix(prefix, FLAIR_CLIENT_PACKAGE);
    sdkClient = resolveFromPrefix(prefix, "@modelcontextprotocol/sdk/client/index.js");
    sdkStdio = resolveFromPrefix(prefix, "@modelcontextprotocol/sdk/client/stdio.js");
  } catch (err) {
    return dieDidNotRun(`could not resolve published modules from prefix: ${err instanceof Error ? err.message : err}`);
  }
  for (const [label, resolved] of [
    ["flair-mcp bin", mcpBin],
    ["flair-client", clientEntry],
    ["mcp sdk client", sdkClient],
    ["mcp sdk stdio", sdkStdio],
  ]) {
    const check = assertPublishedResolve(resolved, prefix);
    if (!check.ok) return fail(`${label}: ${check.reason}`);
    console.log(`[plugin-canary] ${label}: ${resolved}`);
  }

  const healthUrl = `${flairUrl}/Health`;
  let health = await waitHealth(healthUrl, 5);
  if (!health.ok && args.flairBin) {
    if (!existsSync(args.flairBin)) return dieDidNotRun(`--flair-bin does not exist: ${args.flairBin}`);
    console.log(`[plugin-canary] /Health down (${health.detail}); starting ${args.flairBin}`);
    const started = startFlair(args.flairBin, portFromUrl(flairUrl));
    if (started.status !== 0) {
      console.error(started.output.split("\n").slice(-20).join("\n"));
      return dieDidNotRun(`flair start failed — host unreachable (unmeasurable is FAIL)`);
    }
    health = await waitHealth(healthUrl, 180);
  }
  if (!health.ok) {
    return dieDidNotRun(`host ${healthUrl} did not answer (${health.detail}) — unmeasurable is FAIL`);
  }
  console.log(`[plugin-canary] host ${healthUrl} → ${health.detail}`);

  if (!existsSync(keyPath)) {
    return dieDidNotRun(`agent key missing at ${keyPath} — instance was not inited the way the canary boots`);
  }

  const config = documentedHostConfig(args.version, { agentId, flairUrl, keyPath });
  const { spec, error } = readDocumentedPin(config);
  if (error) return fail(`documented config: ${error}`);
  const pin = pinCheck(spec, FLAIR_MCP_PACKAGE, args.version);
  if (!pin.ok) return fail(`documented config pin: ${pin.reason}`);
  const configPath = join(prefix, ".mcp.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`[plugin-canary] wrote documented host config ${configPath} pin=${pin.reason}`);

  const host = config.mcpServers.flair;
  const mcpEnv = {
    FLAIR_AGENT_ID: agentId,
    FLAIR_URL: flairUrl,
    FLAIR_KEY_PATH: keyPath,
    FLAIR_CLIENT: "plugin-canary",
  };

  let mcpResult;
  try {
    mcpResult = await driveMcpRoundTrip({
      clientModule: sdkClient,
      stdioModule: sdkStdio,
      command: host.command,
      args: host.args,
      cwd: prefix,
      env: mcpEnv,
    });
  } catch (err) {
    return fail(`MCP host drive threw: ${err instanceof Error ? err.message : err}`);
  }
  if (!mcpResult.ok) return fail(mcpResult.reason);
  console.log(`[plugin-canary] ${mcpResult.reason}`);

  let clientResult;
  try {
    clientResult = await driveClientRoundTrip({
      clientModule: clientEntry,
      agentId,
      flairUrl,
      keyPath,
    });
  } catch (err) {
    return fail(`FlairClient drive threw: ${err instanceof Error ? err.message : err}`);
  }
  if (!clientResult.ok) return fail(clientResult.reason);
  console.log(`[plugin-canary] ${clientResult.reason}`);

  if (ownPrefix && !args.keep) {
    try {
      rmSync(prefix, { recursive: true, force: true });
    } catch {
      /* leftover temp dir is not a gate failure */
    }
  }

  console.log("[plugin-canary] PASS — published adapters, documented host wiring, tool-call round-trip");
  return EXIT_OK;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`DID NOT RUN: ${err instanceof Error ? err.message : err}`);
    process.exit(EXIT_DID_NOT_RUN);
  });
}
