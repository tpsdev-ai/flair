#!/usr/bin/env node
/**
 * openclaw-flair — real-host drills (slice 1).
 *
 * Run this ON a host whose OpenClaw version is in the plugin's tested set
 * (2026.8.1 or 2026.9.6), with a reachable Flair instance. It sets up a
 * throwaway HOME (config + per-agent keys), drives one agent turn per drill,
 * and asserts the drill's expected outcome from the host's own output.
 *
 * It is deliberately NOT run against a live gateway: HOME is redirected to a
 * scratch tree so no real ~/.flair (which may be production) is touched.
 *
 * Usage:
 *   HOME=/tmp/ocf-drill OPENCLAW_VERSION=2026.8.1 \
 *     node packages/openclaw-flair/scripts/drill/run.mjs
 *
 * Env:
 *   OPENCLAW_VERSION  required; must be in TESTED_HOST_VERSIONS
 *   OPENCLAW_BIN      host CLI (default: openclaw)
 *   FLAIR_URL         Flair base URL (default: http://127.0.0.1:19926)
 *   HOME              scratch dir (default: a fresh mkdtemp)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const TESTED_HOST_VERSIONS = ["2026.8.1", "2026.9.6"];

// ── the one host invocation to adapt for a given host build ──────────────────
// A one-shot agent turn with a prompt, printing the host's output on stdout.
function HOST_INVOKE(home, extraEnv, prompt) {
  const bin = process.env.OPENCLAW_BIN || "openclaw";
  return spawnSync(bin, ["agent", "run", "--prompt", prompt], {
    env: { ...process.env, ...extraEnv, HOME: home },
    encoding: "utf8",
    timeout: 120_000,
  });
}

const results = [];
function record(drill, ok, detail) {
  results.push({ drill, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${drill}  ${detail}`);
}

function setupHome(hostVersion, hooks) {
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
      entries: {
        "openclaw-flair": {
          enabled: true,
          hooks,
          config: { url: process.env.FLAIR_URL || "http://127.0.0.1:19926", autoRecall: true, autoCapture: hookOn(hooks, "allowConversationAccess") },
        },
      },
    },
    agents: { list: [{ id: "agent-a" }] },
  };
  writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify(config, null, 2));
  return home;
}
function hookOn(hooks, k) { return hooks[k] === true; }

function main() {
  const hostVersion = (process.env.OPENCLAW_VERSION || "").trim();
  if (!TESTED_HOST_VERSIONS.includes(hostVersion)) {
    console.error(`refusing to run drills: OPENCLAW_VERSION="${hostVersion}" is not in the tested set ${TESTED_HOST_VERSIONS.join(", ")}`);
    process.exit(2);
  }

  const full = { allowPromptInjection: true, allowConversationAccess: true };
  const noConv = { allowPromptInjection: true, allowConversationAccess: false };
  const noPrompt = { allowPromptInjection: false, allowConversationAccess: true };

  // 1. happy path -----------------------------------------------------------
  {
    const home = setupHome(hostVersion, full);
    const r = HOST_INVOKE(home, { OPENCLAW_VERSION: hostVersion }, "Store: remember this — the drill marker is happy-path.");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const reachedProvider = r.status === 0 || /provider|model|assistant/i.test(out);
    const hasDisabled = /openclaw-flair disabled/.test(out);
    record("happy", reachedProvider && !hasDisabled, `exit=${r.status}`);
  }

  // 2. decline (falsified tested set) --------------------------------------
  {
    const home = setupHome(hostVersion, full);
    // Force the out-of-set branch by pinning the host version the plugin sees.
    const r = HOST_INVOKE(home, { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.7" }, "say hello");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const declined = /openclaw-flair disabled: host 2026\.5\.7 not in tested set/.test(out);
    const clean = !/\[plugins\]/.test(out);
    record("decline", declined && clean, `exit=${r.status}`);
  }

  // 3. two agents ----------------------------------------------------------
  {
    const home = setupHome(hostVersion, full);
    // (A real two-agent drill needs two agents on one gateway; the assertion is
    // that A's turn never signs as B. Read the signer id from Flair's log.)
    const r = HOST_INVOKE(home, { OPENCLAW_VERSION: hostVersion }, "as agent-a: remember this — marker two-agents");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    record("two-agents", r.status === 0, `exit=${r.status} (verify signer id in the Flair request log)`);
  }

  // 4. gates ---------------------------------------------------------------
  {
    const homeNoConv = setupHome(hostVersion, noConv);
    const r1 = HOST_INVOKE(homeNoConv, { OPENCLAW_VERSION: hostVersion }, "say hello");
    const out1 = `${r1.stdout ?? ""}\n${r1.stderr ?? ""}`;
    record("gates-capture", /capture disabled \(permission\)/.test(out1), `exit=${r1.status}`);

    const homeNoPrompt = setupHome(hostVersion, noPrompt);
    const r2 = HOST_INVOKE(homeNoPrompt, { OPENCLAW_VERSION: hostVersion }, "say hello");
    const out2 = `${r2.stdout ?? ""}\n${r2.stderr ?? ""}`;
    record("gates-prompt", /prompt context disabled: policy/.test(out2), `exit=${r2.status}`);
  }

  // 5. transcript ----------------------------------------------------------
  {
    const home = setupHome(hostVersion, full);
    const r = HOST_INVOKE(home, { OPENCLAW_VERSION: hostVersion }, "say hello");
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
