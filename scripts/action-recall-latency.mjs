#!/usr/bin/env node
/**
 * Action-recall latency gate (flair#2067 slice 2).
 *
 * Times the EXACT installed shell command — the stdout-capture/zero-exit
 * wrapper around the built artefact run by an absolute Bun — over 200 fresh
 * processes per scenario, with a parent monotonic timer that starts before the
 * spawn and stops after exit and output are collected. Reports raw samples and
 * the nearest-rank p50/p95. The spec's 25 ms is an internal deadline, not this
 * number; this is the honest end-to-end figure.
 *
 * Usage: node scripts/action-recall-latency.mjs [--runs 200]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function installedCommand(cacheRoot, home) {
  const env = `HOME=${home} FLAIR_ACTION_RECALL_DIR=${cacheRoot} FLAIR_AGENT_ID=${AGENT} FLAIR_URL=${URL}`;
  return `sh -c 'out=$(${env} ${BUN} ${ARTIFACT} 2>/dev/null) && printf %s "$out" || true'`;
}

function runOnce(command, input, holdOpen) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ ms, code, out });
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

async function scenario(name, count, command, input, holdOpen) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const { ms } = await runOnce(command, input, holdOpen);
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
  const root = mkdtempSync(join(tmpdir(), "flair-2067-lat-"));
  const home = mkdtempSync(join(tmpdir(), "flair-2067-lat-home-"));
  const fullRoot = root + "-full";
  const corruptRoot = root + "-corrupt";
  const missingRoot = root + "-missing";
  console.log(`artifact: ${ARTIFACT}`);
  console.log(`bun:      ${BUN}\n`);
  const results = [];
  try {
    makeCache(fullRoot, [entry("m1"), entry("m2"), entry("m3")]);
    makeCache(corruptRoot, [entry("m1")]);
    // Corrupt the generation in place (digest mismatch): a full-size, well
    // formed, wrong-content file. Mode stays 0600 so ONLY the digest refuses.
    const corruptDir = join(corruptRoot, sha(URL), sha(AGENT), sha(SESSION), sha(INSTANCE));
    writeFileSync(join(corruptDir, "gen-1.json"), JSON.stringify({ payload: "{}", sha256: "0".repeat(64) }), { mode: 0o600 });
    const matching = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: "/repo", session_id: SESSION });
    const unrelated = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/repo", session_id: SESSION });
    results.push(await scenario("unrelated", runs, installedCommand(fullRoot, home), unrelated, false));
    results.push(await scenario("matching ", runs, installedCommand(fullRoot, home), matching, false));
    results.push(await scenario("missing  ", runs, installedCommand(missingRoot, home), matching, false));
    results.push(await scenario("corrupt  ", runs, installedCommand(corruptRoot, home), matching, false));
    results.push(await scenario("held-open", runs, installedCommand(fullRoot, home), "", true));
  } finally {
    for (const p of [root, home, fullRoot, corruptRoot, missingRoot]) rmSync(p, { recursive: true, force: true });
  }
  const failing = results.filter((r) => r.p95 > 50);
  console.log(`\np95 <= 50 ms: ${failing.length === 0 ? "PASS" : "FAIL " + failing.map((f) => f.name.trim()).join(",")}`);
  process.exit(failing.length === 0 ? 0 : 1);
}

await main();
