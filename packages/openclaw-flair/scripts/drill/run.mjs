#!/usr/bin/env node
/**
 * openclaw-flair — real-host drills (slice 1).
 *
 * STATUS: this runner is NOT a working drill suite yet. It sets up an isolated
 * HOME, learns the host version, and drives ONE embedded agent turn per step,
 * but it does not yet assert the properties the spec's drills require. The
 * numbered TODO in README.md lists what a real run must add. It is delivered so
 * a tested host can finish it.
 *
 * SAFETY: the scratch HOME is ALWAYS a fresh private mkdtemp directory — a
 * caller-supplied HOME is never accepted (a symlink planted at a predictable
 * path could make the runner overwrite a real ~/.openclaw / ~/.flair/keys). The
 * runner refuses to run unless invoked with an explicit --local/--embedded flag
 * and with no OPENCLAW_GATEWAY_* in the environment, so it cannot reach a live
 * gateway. The scratch HOME is removed on exit.
 *
 * Usage:
 *   node packages/openclaw-flair/scripts/drill/run.mjs --local
 *
 * Env: OPENCLAW_BIN (default: openclaw), FLAIR_URL (default: http://127.0.0.1:19926)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, cpSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const TESTED_HOST_VERSIONS = ["2026.8.1", "2026.9.6"];
const HOST_BIN = process.env.OPENCLAW_BIN || "openclaw";

/** Ask the host CLI for its version; parse the first semver. */
function resolveHostVersion() {
  const r = spawnSync(HOST_BIN, ["--version"], { encoding: "utf8", timeout: 30_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * One embedded agent turn. The documented invocation is
 * `openclaw agent --agent <id> --message <text>` (gateway by default; `--local`
 * runs the embedded agent). The child environment is filtered — no ambient
 * OPENCLAW_* / FLAIR_* settings cross into it.
 */
function hostInvoke(home, agentId, message) {
  const env = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    FLAIR_URL: process.env.FLAIR_URL || "http://127.0.0.1:19926",
  };
  const args = localArgs(["agent", "--local", "--agent", agentId, "--message", message]);
  return spawnSync(HOST_BIN, args, { env, encoding: "utf8", timeout: 120_000 });
}

/** `--local` is the flag that selects an embedded run. */
function localArgs(base) {
  return base;
}

const results = [];
function record(drill, ok, detail) {
  results.push({ drill, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${drill}  ${detail}`);
}

function pluginPackageDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Build a FALSIFIED COPY of the plugin's built entry whose tested set excludes
 * the real host version. The host version comes from the host API, so this is
 * the only way to force the out-of-set branch.
 */
function falsifiedPluginDir() {
  const src = join(pluginPackageDir(), "dist");
  const dst = mkdtempSync(join(tmpdir(), "ocf-drill-falsified-"));
  cpSync(src, dst, { recursive: true });
  const entry = join(dst, "index.js");
  const text = readFileSync(entry, "utf8");
  const falsified = text.replace(/\["2026\.8\.1",\s*"2026\.9\.6"\]/, '["0.0.0"]');
  if (falsified === text) throw new Error("could not falsify the tested set in dist/index.js (pattern not found)");
  writeFileSync(entry, falsified);
  cpSync(join(pluginPackageDir(), "openclaw.plugin.json"), join(dst, "openclaw.plugin.json"));
  return dst;
}

let scratchHomes = [];

/** A FRESH private scratch HOME. A caller-supplied HOME is never accepted. */
function setupHome(hooks, extraPluginPath) {
  const home = mkdtempSync(join(tmpdir(), "ocf-drill-"));
  scratchHomes.push(home);
  // The scratch HOME must be a real directory: realpath() is the same string.
  if (realpathSync(home) !== home) throw new Error("scratch HOME resolved through a symlink — refusing");
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  mkdirSync(join(home, ".flair", "keys"), { recursive: true });
  for (const id of ["agent-a", "agent-b"]) {
    const key = join(home, ".flair", "keys", `${id}.key`);
    writeFileSync(key, randomBytes(32));
    chmodSync(key, 0o600);
  }
  const config = {
    plugins: {
      allow: ["openclaw-flair"],
      slots: { memory: "openclaw-flair" },
      ...(extraPluginPath ? { load: { paths: [extraPluginPath] } } : {}),
      entries: {
        "openclaw-flair": {
          enabled: true,
          hooks,
          config: { url: process.env.FLAIR_URL || "http://127.0.0.1:19926", autoRecall: true, autoCapture: hooks.allowConversationAccess === true },
        },
      },
    },
    // BOTH agents are declared (the two-agent drill needs two). NOTE: on a host
    // where both agents share one OS user the plugin refuses to register — the
    // two-agent drill requires per-agent OS users (the cutover).
    agents: { entries: { "agent-a": {}, "agent-b": {} } },
  };
  writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify(config, null, 2));
  return home;
}

function cleanup() {
  for (const h of scratchHomes) {
    try { rmSync(h, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  scratchHomes = [];
}

function main() {
  // Safety gate 1: embedded only.
  if (!process.argv.includes("--local") && !process.argv.includes("--embedded")) {
    console.error("refusing to run drills: pass --local (embedded agent run); this runner must never touch a live gateway");
    process.exit(2);
  }
  // Safety gate 2: no gateway environment.
  const gatewayVars = Object.keys(process.env).filter((k) => k.startsWith("OPENCLAW_GATEWAY_"));
  if (gatewayVars.length > 0) {
    console.error(`refusing to run drills: OPENCLAW_GATEWAY_* is set (${gatewayVars.join(", ")}) — unset it and retry`);
    process.exit(2);
  }

  const hostVersion = resolveHostVersion();
  if (!hostVersion || !TESTED_HOST_VERSIONS.includes(hostVersion)) {
    console.error(`refusing to run drills: host reports "${hostVersion ?? "(unknown)"}", not in the tested set ${TESTED_HOST_VERSIONS.join(", ")}`);
    process.exit(2);
  }
  console.log(`host version: ${hostVersion}`);

  const full = { allowPromptInjection: true, allowConversationAccess: true };
  const noConv = { allowPromptInjection: true, allowConversationAccess: false };
  const noPrompt = { allowPromptInjection: false, allowConversationAccess: true };

  // 1. happy path — one embedded turn completes; the plugin does not report itself disabled.
  {
    const home = setupHome(full);
    const r = hostInvoke(home, "agent-a", "remember this: the drill marker is happy-path");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    record("happy", r.status === 0 && !/openclaw-flair disabled/.test(out), `exit=${r.status}`);
  }

  // 2. decline — falsified tested set -> the disabled line, no [plugins] warnings.
  {
    const falsified = falsifiedPluginDir();
    const home = setupHome(full, falsified);
    const r = hostInvoke(home, "agent-a", "say hello");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    record("decline", /openclaw-flair disabled: host .* not in tested set/.test(out) && !/\[plugins\]/.test(out), `exit=${r.status}`);
    rmSync(falsified, { recursive: true, force: true });
  }

  // 3. two agents — requires per-agent OS users; on a shared user the plugin declines.
  {
    const home = setupHome(full);
    const r = hostInvoke(home, "agent-a", "as agent-a: remember this: marker two-agents");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    record("two-agents", r.status === 0, `exit=${r.status} (verify signer id in the Flair request log; requires per-agent OS users)`);
  }

  // 4. gates.
  {
    const homeNoConv = setupHome(noConv);
    const r1 = hostInvoke(homeNoConv, "agent-a", "say hello");
    record("gates-capture", /capture disabled \(permission\)/.test(`${r1.stdout ?? ""}\n${r1.stderr ?? ""}`), `exit=${r1.status}`);

    const homeNoPrompt = setupHome(noPrompt);
    const r2 = hostInvoke(homeNoPrompt, "agent-a", "say hello");
    record("gates-prompt", /prompt context disabled: policy/.test(`${r2.stdout ?? ""}\n${r2.stderr ?? ""}`), `exit=${r2.status}`);
  }

  // 5. transcript — record the raw host output for the mock to replay.
  {
    const home = setupHome(full);
    const r = hostInvoke(home, "agent-a", "say hello");
    const here = dirname(fileURLToPath(import.meta.url));
    const outPath = join(here, `transcript-${hostVersion}.json`);
    writeFileSync(outPath, JSON.stringify({ hostVersion, exit: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2));
    record("transcript", true, `wrote ${outPath}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed (see README TODO — these are scaffolding, not the spec's drills).`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
}

try {
  main();
} finally {
  cleanup();
}
