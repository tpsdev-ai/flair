#!/usr/bin/env node
/**
 * openclaw-flair — real-host drills (slice 1).
 *
 * Run this ON a host that runs OpenClaw, with a reachable Flair instance. It
 * learns the host version from the host CLI itself, sets up a throwaway HOME
 * (config + per-agent keys), drives one agent turn per drill, and asserts the
 * drill's expected outcome from the host's own output.
 *
 * It is deliberately NOT run against a live gateway: HOME is redirected to a
 * scratch tree so no real ~/.flair (which may be production) is touched.
 *
 * Usage:
 *   HOME=/tmp/ocf-drill node packages/openclaw-flair/scripts/drill/run.mjs
 *
 * Env:
 *   OPENCLAW_BIN   host CLI (default: openclaw)
 *   FLAIR_URL      Flair base URL (default: http://127.0.0.1:19926)
 *   HOME           scratch dir (default: a fresh mkdtemp)
 *
 * The plugin's host-version source is the host API (`api.runtime.version`), not
 * an environment variable, so this runner never sets a version env var — it
 * reads the version the host reports.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, cpSync } from "node:fs";
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

/** One agent turn with a prompt, over the scratch HOME. */
function HOST_INVOKE(home, prompt, extra = {}) {
  return spawnSync(HOST_BIN, ["agent", "run", "--prompt", prompt], {
    env: { ...process.env, ...extra, HOME: home },
    encoding: "utf8",
    timeout: 120_000,
  });
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
 * Drill 2 needs the out-of-set branch. Since the host version comes from the
 * host API, the only way to force that branch is a plugin whose tested set does
 * not contain the real host version — so we build a falsified COPY of the
 * plugin's built entry and load that copy.
 */
function falsifiedPluginDir() {
  const src = join(pluginPackageDir(), "dist");
  const dst = mkdtempSync(join(tmpdir(), "ocf-drill-falsified-"));
  cpSync(src, dst, { recursive: true });
  const entry = join(dst, "index.js");
  const text = readFileSync(entry, "utf8");
  const falsified = text.replace(
    /\["2026\.8\.1",\s*"2026\.9\.6"\]/,
    '["0.0.0"]',
  );
  if (falsified === text) {
    throw new Error("could not falsify the tested set in dist/index.js (pattern not found)");
  }
  writeFileSync(entry, falsified);
  // The package's manifest is needed next to the entry.
  cpSync(join(pluginPackageDir(), "openclaw.plugin.json"), join(dst, "openclaw.plugin.json"));
  return dst;
}

function setupHome(hooks, extraPluginPath) {
  const home = process.env.HOME && process.env.HOME.startsWith("/tmp")
    ? process.env.HOME
    : mkdtempSync(join(tmpdir(), "ocf-drill-"));
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
          config: {
            url: process.env.FLAIR_URL || "http://127.0.0.1:19926",
            autoRecall: true,
            autoCapture: hooks.allowConversationAccess === true,
          },
        },
      },
    },
    agents: { entries: { "agent-a": {} } },
  };
  writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify(config, null, 2));
  return home;
}

function main() {
  const hostVersion = resolveHostVersion();
  if (!hostVersion || !TESTED_HOST_VERSIONS.includes(hostVersion)) {
    console.error(
      `refusing to run drills: host reports "${hostVersion ?? "(unknown)"}", not in the tested set ${TESTED_HOST_VERSIONS.join(", ")}`,
    );
    process.exit(2);
  }
  console.log(`host version: ${hostVersion}`);

  const full = { allowPromptInjection: true, allowConversationAccess: true };
  const noConv = { allowPromptInjection: true, allowConversationAccess: false };
  const noPrompt = { allowPromptInjection: false, allowConversationAccess: true };

  // 1. happy path -----------------------------------------------------------
  {
    const home = setupHome(full);
    const r = HOST_INVOKE(home, "Store: remember this — the drill marker is happy-path.");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const reachedProvider = r.status === 0 || /provider|model|assistant/i.test(out);
    const hasDisabled = /openclaw-flair disabled/.test(out);
    record("happy", reachedProvider && !hasDisabled, `exit=${r.status}`);
  }

  // 2. decline (falsified tested set) --------------------------------------
  {
    const falsified = falsifiedPluginDir();
    const home = setupHome(full, falsified);
    const r = HOST_INVOKE(home, "say hello");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const declined = /openclaw-flair disabled: host .* not in tested set/.test(out);
    const clean = !/\[plugins\]/.test(out);
    record("decline", declined && clean, `exit=${r.status}`);
    rmSync(falsified, { recursive: true, force: true });
  }

  // 3. two agents ----------------------------------------------------------
  {
    const home = setupHome(full);
    const r = HOST_INVOKE(home, "as agent-a: remember this — marker two-agents");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    record("two-agents", r.status === 0, `exit=${r.status} (verify signer id in the Flair request log)`);
  }

  // 4. gates ---------------------------------------------------------------
  {
    const homeNoConv = setupHome(noConv);
    const r1 = HOST_INVOKE(homeNoConv, "say hello");
    const out1 = `${r1.stdout ?? ""}\n${r1.stderr ?? ""}`;
    record("gates-capture", /capture disabled \(permission\)/.test(out1), `exit=${r1.status}`);

    const homeNoPrompt = setupHome(noPrompt);
    const r2 = HOST_INVOKE(homeNoPrompt, "say hello");
    const out2 = `${r2.stdout ?? ""}\n${r2.stderr ?? ""}`;
    record("gates-prompt", /prompt context disabled: policy/.test(out2), `exit=${r2.status}`);
  }

  // 5. transcript ----------------------------------------------------------
  {
    const home = setupHome(full);
    const r = HOST_INVOKE(home, "say hello");
    const here = dirname(fileURLToPath(import.meta.url));
    const outPath = join(here, `transcript-${hostVersion}.json`);
    writeFileSync(outPath, JSON.stringify({ hostVersion, exit: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2));
    record("transcript", true, `wrote ${outPath}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} drills passed.`);
  process.exit(failed.length ? 1 : 0);
}

main();
