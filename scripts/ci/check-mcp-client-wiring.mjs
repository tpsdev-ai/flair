#!/usr/bin/env node
/**
 * check-mcp-client-wiring.mjs — CI gate for `flair init --client` (flair#908).
 *
 * MCP client wiring had no CI coverage: no workflow invoked `--client`, and
 * none read back a config `flair init` wrote. That is the class that let
 * #906 (silent Claude Code skip) and #907 (unpinned / `unknown` spec) ship.
 *
 * This script runs the real new-user sequence against a fake HOME and then
 * reads back what was written. It does not install Claude Code or Codex —
 * detection is filesystem-only (bin on PATH or a known config path), so a
 * fake bin plus a known HOME is enough to exercise write + report.
 *
 * Exit codes:
 *   0 — ran, every supported client was written or explicitly reported
 *   1 — ran, an assertion failed (silence, missing pin, clobber, init error)
 *   2 — DID NOT RUN (missing CLI, missing version, empty inventory). Not 0.
 *
 * Usage:
 *   node scripts/ci/check-mcp-client-wiring.mjs \
 *     --flair <path-to-installed-cli.js> \
 *     --version <cli-version-under-test>
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_DID_NOT_RUN = 2;

export const FLAIR_MCP_PACKAGE = "@tpsdev-ai/flair-mcp";
export const PI_FLAIR_PACKAGE = "@tpsdev-ai/pi-flair";
export const CLOBBER_MARKER_SERVER = "preexisting-other";

/**
 * Every client `flair init --client` accepts, other than `all` / `none`.
 *
 * Kept in lockstep with `ALL_CLIENTS` in src/install/clients.ts — the unit
 * test fails if a client is added there and not here. A client this list
 * names MUST land in exactly one bucket after `--client all`: written
 * config, explicit NOT-wired, or explicit "Not installed, skipped".
 * Silence is the failure #908 exists to catch.
 *
 * `exercise: true` means this gate can drive the write path with a fake
 * HOME + fake bin (no real client install). If a future client cannot be
 * exercised that way, set `exercise: false` and `skipReason` — never drop
 * it from the list.
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   bin: string,
 *   relativeConfig: string,
 *   pinKind: "mcp-json" | "mcp-toml" | "pi-packages",
 *   exercise: boolean,
 *   skipReason?: string,
 * }} SupportedClient
 */
/** @type {SupportedClient[]} */
export const SUPPORTED_CLIENTS = [
  { id: "claude-code", label: "Claude Code", bin: "claude", relativeConfig: ".claude.json", pinKind: "mcp-json", exercise: true },
  { id: "codex", label: "Codex", bin: "codex", relativeConfig: ".codex/config.toml", pinKind: "mcp-toml", exercise: true },
  { id: "gemini", label: "Gemini", bin: "gemini", relativeConfig: ".gemini/settings.json", pinKind: "mcp-json", exercise: true },
  { id: "cursor", label: "Cursor", bin: "cursor", relativeConfig: ".cursor/mcp.json", pinKind: "mcp-json", exercise: true },
  { id: "antigravity", label: "Antigravity", bin: "agy", relativeConfig: ".gemini/config/mcp_config.json", pinKind: "mcp-json", exercise: true },
  { id: "pi", label: "pi", bin: "pi", relativeConfig: ".pi/agent/settings.json", pinKind: "pi-packages", exercise: true },
];

export function configPath(home, client) {
  return join(home, client.relativeConfig);
}

/** The "MCP clients" summary `flair init` prints last (flair#906). */
export function wiringSummarySection(output) {
  const idx = output.lastIndexOf("MCP clients");
  return idx === -1 ? "" : output.slice(idx);
}

function splitCommaList(raw) {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse the end-of-run wiring summary into three named buckets.
 * Mid-run `✓ Claude Code wired in ~/.claude.json` lines are ignored — the
 * #906 defect was that those facts vanished from the closing summary.
 *
 * @param {string} output
 * @returns {{ wired: string[], notWired: string[], skipped: string[], hasHeading: boolean }}
 */
export function parseWiringSummary(output) {
  const section = wiringSummarySection(output);
  const hasHeading = section.length > 0;
  const wired = [];
  const notWired = [];
  const skipped = [];

  const wiredMatch = section.match(/^\s*(?:[^\n]*\s)?Wired:\s*(.+)$/m);
  if (wiredMatch) wired.push(...splitCommaList(wiredMatch[1]));

  for (const m of section.matchAll(/NOT wired:\s*([^—\n]+)/g)) {
    const label = m[1].trim();
    if (label) notWired.push(label);
  }

  const skipMatch = section.match(/Not installed, skipped:\s*(.+)$/m);
  if (skipMatch) skipped.push(...splitCommaList(skipMatch[1]));

  return { wired, notWired, skipped, hasHeading };
}

/**
 * One client → exactly one of wired / not-wired / skipped / silent / ambiguous.
 *
 * @param {string} output
 * @param {SupportedClient} client
 */
export function classifyClientReport(output, client) {
  const { wired, notWired, skipped, hasHeading } = parseWiringSummary(output);
  const buckets = [];
  if (wired.includes(client.label)) buckets.push("wired");
  if (notWired.includes(client.label)) buckets.push("not-wired");
  if (skipped.includes(client.label)) buckets.push("skipped");
  if (buckets.length === 0) {
    return { status: hasHeading ? "silent" : "no-summary", buckets, hasHeading };
  }
  if (buckets.length > 1) return { status: "ambiguous", buckets, hasHeading };
  return { status: buckets[0], buckets, hasHeading };
}

/**
 * @param {string} spec
 * @param {string} packageName
 * @param {string} version
 */
export function pinCheck(spec, packageName, version) {
  if (!spec || typeof spec !== "string") {
    return { ok: false, reason: "no spec written" };
  }
  if (spec === packageName || spec === `npm:${packageName}`) {
    return { ok: false, reason: `unpinned bare spec: ${spec}` };
  }
  if (spec.includes("@unknown") || spec.endsWith("@unknown")) {
    return { ok: false, reason: `unresolved version (unknown): ${spec}` };
  }
  const expected = spec.startsWith("npm:")
    ? `npm:${packageName}@${version}`
    : `${packageName}@${version}`;
  if (spec !== expected) {
    return { ok: false, reason: `expected ${expected}, got ${spec}` };
  }
  return { ok: true, reason: expected };
}

export function readJsonMcpPin(raw) {
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { spec: null, error: `invalid JSON (${msg})` };
  }
  const args = cfg?.mcpServers?.flair?.args;
  if (!Array.isArray(args)) return { spec: null, error: "mcpServers.flair.args missing" };
  const spec = args.find((a) => typeof a === "string" && a.includes(FLAIR_MCP_PACKAGE));
  if (!spec) return { spec: null, error: `${FLAIR_MCP_PACKAGE} missing from args` };
  return { spec, error: null };
}

export function readTomlMcpPin(raw) {
  const m = String(raw).match(/args\s*=\s*\[\s*"\-y"\s*,\s*"([^"]+)"\s*\]/);
  if (!m) return { spec: null, error: "Codex args = [\"-y\", \"...\"] not found" };
  return { spec: m[1], error: null };
}

export function readPiPin(raw) {
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { spec: null, error: `invalid JSON (${msg})` };
  }
  const packages = cfg?.packages;
  if (!Array.isArray(packages)) return { spec: null, error: "packages array missing" };
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : null;
    if (source && source.includes(PI_FLAIR_PACKAGE)) return { spec: source, error: null };
  }
  return { spec: null, error: `${PI_FLAIR_PACKAGE} missing from packages` };
}

export function readWrittenPin(raw, client) {
  if (client.pinKind === "mcp-json") return readJsonMcpPin(raw);
  if (client.pinKind === "mcp-toml") return readTomlMcpPin(raw);
  if (client.pinKind === "pi-packages") return readPiPin(raw);
  return { spec: null, error: `unknown pinKind ${client.pinKind}` };
}

export function expectedPackage(client) {
  return client.pinKind === "pi-packages" ? PI_FLAIR_PACKAGE : FLAIR_MCP_PACKAGE;
}

export function clobberClaudeFixture() {
  return {
    numStartups: 7,
    theme: "keep-me",
    mcpServers: {
      [CLOBBER_MARKER_SERVER]: {
        command: "npx",
        args: ["-y", "not-flair-at-all"],
      },
    },
  };
}

export function clobberSurvived(raw) {
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "rewritten ~/.claude.json is not JSON" };
  }
  if (cfg.numStartups !== 7) return { ok: false, reason: `numStartups clobbered (now ${cfg.numStartups})` };
  if (cfg.theme !== "keep-me") return { ok: false, reason: `theme clobbered (now ${cfg.theme})` };
  const other = cfg.mcpServers?.[CLOBBER_MARKER_SERVER];
  if (!other || !Array.isArray(other.args) || !other.args.includes("not-flair-at-all")) {
    return { ok: false, reason: `${CLOBBER_MARKER_SERVER} MCP server did not survive` };
  }
  if (!cfg.mcpServers?.flair) return { ok: false, reason: "flair MCP server was not merged in" };
  return { ok: true, reason: "existing servers and keys survived" };
}

export function parseArgs(argv) {
  const out = { flair: "", version: "", port: "19997", agent: "wiretest" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--flair") out.flair = argv[++i] ?? "";
    else if (a === "--version") out.version = argv[++i] ?? "";
    else if (a === "--port") out.port = argv[++i] ?? out.port;
    else if (a === "--agent") out.agent = argv[++i] ?? out.agent;
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      out.unknown = a;
    }
  }
  return out;
}

function dieDidNotRun(msg) {
  console.error(`DID NOT RUN: ${msg}`);
  return EXIT_DID_NOT_RUN;
}

function writeFakeBin(dir, name) {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function isolatedPath(fakeBinDir) {
  const nodeDir = dirname(process.execPath);
  const rest = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  return [fakeBinDir, nodeDir, rest].join(":");
}

export function binOnPath(bin, pathEnv) {
  for (const dir of String(pathEnv || "").split(":")) {
    if (!dir) continue;
    if (existsSync(join(dir, bin))) return true;
  }
  return false;
}

/**
 * @param {{
 *   flair: string,
 *   args: string[],
 *   env: NodeJS.ProcessEnv,
 *   cwd: string,
 *   timeoutMs: number,
 * }} opts
 */
export function runFlair(opts) {
  const result = spawnSync(process.execPath, [opts.flair, ...opts.args], {
    env: opts.env,
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

function childEnv(home, path, extra = {}) {
  const env = { ...process.env, ...extra, HOME: home, USERPROFILE: home, PATH: path };
  // A runner-level FLAIR_URL / FLAIR_TARGET would point init at the wrong instance.
  delete env.FLAIR_URL;
  delete env.FLAIR_TARGET;
  delete env.FLAIR_OPS_TARGET;
  return env;
}

function assertAccounted(output, passName, failures) {
  if (SUPPORTED_CLIENTS.length === 0) {
    failures.push(`${passName}: SUPPORTED_CLIENTS is empty — a gate that covers nothing cannot pass`);
    return [];
  }
  /** @type {{ client: SupportedClient, status: string }[]} */
  const rows = [];
  const parsed = parseWiringSummary(output);
  if (!parsed.hasHeading) {
    failures.push(`${passName}: init output has no "MCP clients" summary — silence is the #908 failure`);
  }
  for (const client of SUPPORTED_CLIENTS) {
    const cls = classifyClientReport(output, client);
    rows.push({ client, status: cls.status });
    if (cls.status === "silent" || cls.status === "no-summary") {
      failures.push(`${passName}: ${client.id} (${client.label}) was not written and not reported — silence`);
    } else if (cls.status === "ambiguous") {
      failures.push(`${passName}: ${client.id} appeared in multiple buckets: ${cls.buckets.join(", ")}`);
    }
  }
  return rows;
}

function assertWrittenPins(home, version, clients, failures, passName) {
  for (const client of clients) {
    const path = configPath(home, client);
    if (!existsSync(path)) {
      failures.push(`${passName}: ${client.id} reported wired but ${client.relativeConfig} was not written`);
      continue;
    }
    const raw = readFileSync(path, "utf8");
    const { spec, error } = readWrittenPin(raw, client);
    if (error) {
      failures.push(`${passName}: ${client.id} config unreadable: ${error}`);
      continue;
    }
    const check = pinCheck(spec, expectedPackage(client), version);
    if (!check.ok) {
      failures.push(`${passName}: ${client.id} pin failed — ${check.reason}`);
    }
  }
}

function printCoverage(rows, title) {
  const written = rows.filter((r) => r.status === "wired").map((r) => r.client.id);
  const notWired = rows.filter((r) => r.status === "not-wired").map((r) => r.client.id);
  const skipped = rows.filter((r) => r.status === "skipped").map((r) => r.client.id);
  const silent = rows.filter((r) => r.status === "silent" || r.status === "no-summary").map((r) => r.client.id);
  const unexercised = SUPPORTED_CLIENTS.filter((c) => !c.exercise).map((c) => `${c.id} (${c.skipReason ?? "no reason"})`);
  console.log(`\n── ${title} ──`);
  console.log(`COVERED (written): ${written.join(", ") || "(none)"}`);
  console.log(`REPORTED not-wired: ${notWired.join(", ") || "(none)"}`);
  console.log(`REPORTED skipped:   ${skipped.join(", ") || "(none)"}`);
  console.log(`SILENT (failure):   ${silent.join(", ") || "(none)"}`);
  console.log(`GATE-SKIPPED:       ${unexercised.join(", ") || "(none)"}`);
  return { written, notWired, skipped, silent, unexercised };
}

function appendStepSummary(text) {
  const dest = process.env.GITHUB_STEP_SUMMARY;
  if (!dest) return;
  try {
    writeFileSync(dest, text, { flag: "a" });
  } catch {
    /* summary is best-effort */
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: node scripts/ci/check-mcp-client-wiring.mjs --flair <cli.js> --version <ver>");
    return EXIT_OK;
  }
  if (args.unknown) return dieDidNotRun(`unknown argument: ${args.unknown}`);
  if (!args.flair) return dieDidNotRun("missing --flair <path-to-installed-cli.js>");
  if (!args.version) return dieDidNotRun("missing --version <cli-version-under-test>");
  if (args.version === "unknown" || !args.version.trim()) {
    return dieDidNotRun(`--version is '${args.version}' — refusing to assert a pin against an unresolved version`);
  }
  if (!existsSync(args.flair)) return dieDidNotRun(`--flair path does not exist: ${args.flair}`);
  if (SUPPORTED_CLIENTS.length === 0) return dieDidNotRun("SUPPORTED_CLIENTS is empty");

  const unexercised = SUPPORTED_CLIENTS.filter((c) => !c.exercise);
  for (const c of unexercised) {
    if (!c.skipReason) return dieDidNotRun(`${c.id} has exercise:false but no skipReason — name why, do not quietly drop it`);
  }

  const work = mkdtempSync(join(tmpdir(), "flair-mcp-wiring-"));
  const home = join(work, "home");
  const cwd = join(work, "cwd");
  const fakeBin = join(work, "fake-bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  const adminPass = "mcp-wiring-ci-admin";
  const port = args.port;
  const agent = args.agent;
  const path = isolatedPath(fakeBin);
  const env = childEnv(home, path, {
    FLAIR_ADMIN_PASS: adminPass,
    ...(process.env.FLAIR_MODELS_DIR ? { FLAIR_MODELS_DIR: process.env.FLAIR_MODELS_DIR } : {}),
  });

  const initBase = [
    "init",
    "--agent", agent,
    "--port", port,
    "--skip-soul",
    "--skip-smoke",
    "--skip-claude-md",
    "--skip-hook",
    "--data-dir", join(home, ".flair", "data"),
    "--keys-dir", join(home, ".flair", "keys"),
  ];

  /** @type {string[]} */
  const failures = [];
  /** @type {ReturnType<typeof printCoverage>[]} */
  const coverage = [];

  const stop = () => {
    runFlair({
      flair: args.flair,
      args: ["stop", "--port", port],
      env,
      cwd,
      timeoutMs: 30_000,
    });
  };

  try {
    // ── Pass 1: genuine new-user HOME, no client bins, --client all ────────
    // Every supported client must be explicitly skipped (or not-wired). A
    // written config here would mean detection fired from something other
    // than the HOME/PATH we control.
    console.log("=== Pass 1: --client all, empty HOME, no client bins ===");
    const pass1 = runFlair({
      flair: args.flair,
      args: [...initBase, "--client", "all"],
      env,
      cwd,
      timeoutMs: 12 * 60 * 1000,
    });
    console.log(pass1.output);
    if (pass1.error) {
      failures.push(`Pass 1: failed to spawn flair (${pass1.error.message})`);
    } else if (pass1.status !== 0) {
      failures.push(`Pass 1: flair init exited ${pass1.status}${pass1.signal ? ` (${pass1.signal})` : ""}`);
    }
    if (/UNPINNED/.test(pass1.output)) {
      failures.push("Pass 1: init reported an UNPINNED MCP spec (flair#907 class)");
    }
    const rows1 = assertAccounted(pass1.output, "Pass 1", failures);
    coverage.push(printCoverage(rows1, "Pass 1 (no client bins)"));
    const preExistingBins = SUPPORTED_CLIENTS.filter((c) => binOnPath(c.bin, path)).map((c) => c.id);
    if (preExistingBins.length > 0) {
      console.log(`Pass 1: runner PATH already has client bin(s): ${preExistingBins.join(", ")}`);
    }
    for (const row of rows1) {
      const hadBin = preExistingBins.includes(row.client.id);
      if (row.status === "wired" && !hadBin) {
        failures.push(`Pass 1: ${row.client.id} was wired with no bin and no config — detection is not under our HOME/PATH control`);
      }
      if (hadBin && row.status === "skipped") {
        failures.push(`Pass 1: ${row.client.id} bin is on PATH but init reported skipped`);
      }
    }

    // ── Pass 2: same HOME, fake bins for every exerciseable client ─────────
    // `--client <name>` bypasses detection; `--client all` does not. Fake
    // bins make `all` actually write, which is the #906 "installed, never
    // run" state. Clients we cannot exercise stay in the skipped bucket
    // and are named.
    console.log("\n=== Pass 2: --client all, fake bins for exerciseable clients ===");
    const exercised = [];
    for (const client of SUPPORTED_CLIENTS) {
      if (!client.exercise) {
        console.log(`SKIP write-path for ${client.id}: ${client.skipReason}`);
        continue;
      }
      writeFakeBin(fakeBin, client.bin);
      exercised.push(client);
    }
    if (exercised.length === 0) {
      failures.push("Pass 2: no client is marked exercise:true — write path was not run");
    }

    const pass2 = runFlair({
      flair: args.flair,
      args: [...initBase, "--client", "all"],
      env,
      cwd,
      timeoutMs: 3 * 60 * 1000,
    });
    console.log(pass2.output);
    if (pass2.error) {
      failures.push(`Pass 2: failed to spawn flair (${pass2.error.message})`);
    } else if (pass2.status !== 0) {
      failures.push(`Pass 2: flair init exited ${pass2.status}${pass2.signal ? ` (${pass2.signal})` : ""}`);
    }
    if (/UNPINNED/.test(pass2.output)) {
      failures.push("Pass 2: init reported an UNPINNED MCP spec (flair#907 class)");
    }
    const rows2 = assertAccounted(pass2.output, "Pass 2", failures);
    coverage.push(printCoverage(rows2, "Pass 2 (fake bins)"));
    const wiredIds = new Set();
    for (const row of rows2) {
      if (row.client.exercise && row.status !== "wired") {
        failures.push(`Pass 2: ${row.client.id} is exerciseable but status was ${row.status} (expected wired)`);
      }
      if (!row.client.exercise && row.status === "silent") {
        failures.push(`Pass 2: ${row.client.id} was skipped by the gate and also silent in init output`);
      }
      if (row.status === "wired") wiredIds.add(row.client.id);
    }
    assertWrittenPins(
      home,
      args.version,
      SUPPORTED_CLIENTS.filter((c) => wiredIds.has(c.id)),
      failures,
      "Pass 2",
    );

    // ── Pass 3: pre-existing ~/.claude.json must not be clobbered (#906) ───
    console.log("\n=== Pass 3: pre-existing ~/.claude.json is not clobbered ===");
    const claudePath = join(home, ".claude.json");
    writeFileSync(claudePath, JSON.stringify(clobberClaudeFixture(), null, 2) + "\n");
    const pass3 = runFlair({
      flair: args.flair,
      args: [...initBase, "--client", "claude-code"],
      env,
      cwd,
      timeoutMs: 3 * 60 * 1000,
    });
    console.log(pass3.output);
    if (pass3.error) {
      failures.push(`Pass 3: failed to spawn flair (${pass3.error.message})`);
    } else if (pass3.status !== 0) {
      failures.push(`Pass 3: flair init exited ${pass3.status}${pass3.signal ? ` (${pass3.signal})` : ""}`);
    }
    if (!existsSync(claudePath)) {
      failures.push("Pass 3: ~/.claude.json was deleted");
    } else {
      const raw = readFileSync(claudePath, "utf8");
      const survived = clobberSurvived(raw);
      if (!survived.ok) failures.push(`Pass 3: ${survived.reason}`);
      const { spec, error } = readJsonMcpPin(raw);
      if (error) failures.push(`Pass 3: ${error}`);
      else {
        const check = pinCheck(spec, FLAIR_MCP_PACKAGE, args.version);
        if (!check.ok) failures.push(`Pass 3: pin failed — ${check.reason}`);
      }
    }
  } finally {
    stop();
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* leftover temp dir is not a gate failure */
    }
  }

  const last = coverage[coverage.length - 1];
  const summaryLines = [
    `## MCP client wiring (flair#908)`,
    ``,
    `Version under test: \`${args.version}\``,
    ``,
    last
      ? [
          `- COVERED (written + pinned): ${last.written.join(", ") || "(none)"}`,
          `- REPORTED not-wired: ${last.notWired.join(", ") || "(none)"}`,
          `- REPORTED skipped: ${last.skipped.join(", ") || "(none)"}`,
          `- GATE-SKIPPED (cannot exercise via fake HOME): ${last.unexercised.join(", ") || "(none)"}`,
        ].join("\n")
      : "- coverage table was not produced",
    ``,
    failures.length === 0 ? `Result: **pass**` : `Result: **fail** (${failures.length} assertion(s))`,
    "",
  ];
  appendStepSummary(summaryLines.join("\n"));

  if (failures.length > 0) {
    console.error("\n── FAILURES ──");
    for (const f of failures) console.error(`- ${f}`);
    return EXIT_FAIL;
  }
  console.log("\nMCP client-wiring gate passed.");
  return EXIT_OK;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  process.exit(main());
}
