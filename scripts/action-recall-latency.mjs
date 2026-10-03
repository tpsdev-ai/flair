#!/usr/bin/env node
/**
 * Action-recall latency gate (flair#2067 slice 2).
 *
 * Times the installer-produced command with a parent monotonic timer.
 *
 * Usage: node scripts/action-recall-latency.mjs [--runs 200]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const ARTIFACT = join(ROOT, "packages", "flair-mcp", "dist", "action-recall-hook.js");
const BUN = process.env.FLAIR_BUN_PATH || join(process.env.HOME || "", ".bun", "bin", "bun");

const URL = "http://localhost:19926";
const AGENT = "latency-agent";
const SESSION = "latency-session";
const INSTANCE = "latency-instance";
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function makeCache(root, entries) {
  const dir = join(root, sha(URL), sha(AGENT), sha(SESSION));
  const instDir = join(dir, sha(INSTANCE));
  mkdirSync(instDir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  chmodSync(instDir, 0o700);
  const now = Date.now();
  const payload = {
    v: 1,
    url: URL,
    principal: AGENT,
    session: SESSION,
    instance: INSTANCE,
    generation: "gen-1",
    refreshStart: now,
    expiry: now + 5 * 60 * 1000,
    entries,
  };
  const json = JSON.stringify(payload);
  const envelope = JSON.stringify({ payload: json, sha256: sha(json) });
  writeFileSync(join(instDir, "gen-1.json"), envelope, { mode: 0o600 });
  const binding = { v: 1, url: URL, principal: AGENT, session: SESSION, instance: INSTANCE, generation: "gen-1" };
  writeFileSync(join(dir, "current.json"), JSON.stringify(binding), { mode: 0o600 });
  return dir;
}

function entry(id) {
  return {
    id,
    owner: AGENT,
    createdAt: "2026-10-01T00:00:00.000Z",
    triggers: [{ verb: "git", subcommands: ["push"], flags: ["--force"], paths: [] }],
    excerpt: `lesson ${id}: force push the release branch after the unit lane passes`,
    safetyFlags: [],
  };
}

function installedCommand(home) {
  const script = `
    import { installActionRecall, hookSettingsPath } from ${JSON.stringify(join(ROOT, "src", "hook-install.ts"))};
    import { readFileSync } from "node:fs";
    const homeDir = ${JSON.stringify(home)};
    const result = installActionRecall({ homeDir, harness: "claude-code", agentId: ${JSON.stringify(AGENT)}, flairUrl: ${JSON.stringify(URL)}, runtime: { bunPath: ${JSON.stringify(BUN)}, artifactPath: ${JSON.stringify(ARTIFACT)} } });
    if (!result.ok) throw new Error(result.message);
    console.log(JSON.parse(readFileSync(hookSettingsPath(homeDir, "claude-code"), "utf8")).hooks.PreToolUse[0].hooks[0].command);
  `;
  return execFileSync(BUN, ["-e", script], { encoding: "utf8", env: { ...process.env, HOME: home } }).trim();
}

function runOnce(command, input, holdOpen, env) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.once("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      child.stdin.destroy();
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ ms, code, signal, out, err });
    });
    if (!holdOpen) {
      child.stdin.write(input);
      child.stdin.end();
    }
    // holdOpen: never write, never end — the hook's internal deadline must end it.
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

async function scenario(name, count, command, input, holdOpen, env, expectedIds = []) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const { ms, code, signal, out, err } = await runOnce(command, input, holdOpen, env);
    if (code !== 0 || signal !== null) throw new Error(`${name.trim()}: expected exit 0, got ${code}/${signal}`);
    if (err !== "") throw new Error(`${name.trim()}: unexpected stderr`);
    if (expectedIds.length === 0) {
      if (out !== "") throw new Error(`${name.trim()}: unexpected stdout`);
    } else {
      let parsed;
      try { parsed = JSON.parse(out); } catch { throw new Error(`${name.trim()}: expected context-only output`); }
      const hook = parsed.hookSpecificOutput;
      if (JSON.stringify(Object.keys(parsed)) !== '["hookSpecificOutput"]' || !hook ||
          JSON.stringify(Object.keys(hook).sort()) !== '["additionalContext","hookEventName"]' ||
          hook.hookEventName !== "PreToolUse" || typeof hook.additionalContext !== "string" ||
          expectedIds.some(id => !hook.additionalContext.includes(`id: ${id} `)) || Buffer.byteLength(out) > 4096) {
        throw new Error(`${name.trim()}: expected context-only output with every lesson`);
      }
    }
    samples.push(ms);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  console.log(`${name}: n=${count} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms min=${sorted[0].toFixed(3)} max=${sorted[sorted.length - 1].toFixed(3)}`);
  return { name, count, p50, p95, min: sorted[0], max: sorted[sorted.length - 1], samples };
}

async function main() {
  const runsIdx = process.argv.indexOf("--runs");
  const runs = runsIdx > -1 ? Number(process.argv[runsIdx + 1]) : 200;
  if (!(runs > 0)) throw new Error("--runs must be positive");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flair-2067-lat-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "flair-2067-lat-home-")));
  const fullRoot = root + "-full";
  const corruptRoot = root + "-corrupt";
  const missingRoot = root + "-missing";
  console.log(`artifact: ${ARTIFACT}`);
  console.log(`bun:      ${BUN}\n`);
  const results = [];
  try {
    const command = installedCommand(home);
    const env = (cacheRoot) => ({ ...process.env, HOME: home, FLAIR_ACTION_RECALL_DIR: cacheRoot });
    makeCache(fullRoot, [entry("m1"), entry("m2"), entry("m3")]);
    makeCache(corruptRoot, [entry("m1")]);
    // Corrupt the generation in place (digest mismatch): a full-size, well
    // formed, wrong-content file. Mode stays 0600 so ONLY the digest refuses.
    const corruptDir = join(corruptRoot, sha(URL), sha(AGENT), sha(SESSION), sha(INSTANCE));
    writeFileSync(join(corruptDir, "gen-1.json"), JSON.stringify({ payload: "{}", sha256: "0".repeat(64) }), { mode: 0o600 });
    const matching = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: "/repo", session_id: SESSION });
    const unrelated = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/repo", session_id: SESSION });
    results.push(await scenario("unrelated", runs, command, unrelated, false, env(fullRoot)));
    results.push(await scenario("matching ", runs, command, matching, false, env(fullRoot), ["m1", "m2", "m3"]));
    results.push(await scenario("missing  ", runs, command, matching, false, env(missingRoot)));
    results.push(await scenario("corrupt  ", runs, command, matching, false, env(corruptRoot)));
    results.push(await scenario("held-open", runs, command, "", true, env(fullRoot)));
  } finally {
    for (const p of [root, home, fullRoot, corruptRoot, missingRoot]) rmSync(p, { recursive: true, force: true });
  }
  const failing = results.filter((r) => r.p95 > 50);
  console.log(`\np95 <= 50 ms: ${failing.length === 0 ? "PASS" : "FAIL " + failing.map((f) => f.name.trim()).join(",")}`);
  process.exit(failing.length === 0 ? 0 : 1);
}

await main();
