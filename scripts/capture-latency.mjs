#!/usr/bin/env node
/**
 * Capture hot-path latency gate (flair#2068).
 *
 * The brief's budget: capture is never on the agent's critical path — the hook
 * appends to a local spool and RETURNS, and its own work is single-digit
 * milliseconds. Process start-up (the launcher and Bun) happens before the
 * hook runs and is outside that budget, exactly as documented for the other
 * hooks.
 *
 * So this measures two things and gates only the first:
 *   - "append": the hook's own work — planning + the bounded spool write,
 *     timed in-process with a monotonic timer.
 *   - "command": the full installed `sh -c '… bun <artifact>'` invocation
 *     (launcher + runtime + append), reported for context.
 *
 * Usage: node scripts/capture-latency.mjs [--runs 200]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const ARTIFACT = join(ROOT, "packages", "flair-mcp", "dist", "capture-hook.js");
const SOURCE = join(ROOT, "packages", "flair-mcp", "src", "capture-spool.ts");
const BUN = process.env.FLAIR_BUN_PATH || join(process.env.HOME || "", ".bun", "bin", "bun");

const APPEND_BUDGET_MS = 10;

// A neutral, non-default agent id for the measurement only.
const AGENT = "agent-2068";

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function summarize(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  console.log(`${name}: n=${samples.length} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms min=${sorted[0].toFixed(3)} max=${sorted[sorted.length - 1].toFixed(3)}`);
  return { p50, p95, min: sorted[0], max: sorted[sorted.length - 1] };
}

/** The hook's own work, timed in-process over N Stop payloads. */
function measureAppend(runs, dir) {
  const program = `
    import { runCapture } from ${JSON.stringify(SOURCE)};
    import { performance } from "node:perf_hooks";
    const dir = ${JSON.stringify(dir)};
    const payload = JSON.stringify({ hook_event_name: "Stop", session_id: "lat", last_assistant_message: "Decision: prefer host-a for embeddings." });
    const samples = [];
    for (let i = 0; i < ${runs}; i++) {
      const start = performance.now();
      runCapture(payload + " " + i, { env: { FLAIR_AGENT_ID: ${JSON.stringify(AGENT)}, FLAIR_CAPTURE_DIR: dir }, dir, kickFlush: () => {} });
      samples.push(performance.now() - start);
    }
    process.stdout.write(JSON.stringify(samples));
  `;
  const out = execFileSync(BUN, ["-e", program], { encoding: "utf8", env: { ...process.env, HOME: dir } });
  return JSON.parse(out);
}

/** The full installed command, timed with the shell's own resolution. */
function measureCommand(runs, dir) {
  const command = `sh -c 'FLAIR_AGENT_ID=${AGENT} ${BUN} ${ARTIFACT} >/dev/null 2>/dev/null || true'`;
  const payload = JSON.stringify({ hook_event_name: "Stop", session_id: "lat", last_assistant_message: "Decision: prefer host-a for embeddings." });
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const result = spawnSync("sh", ["-c", command], {
      input: payload + " " + i,
      encoding: "utf8",
      env: { ...process.env, HOME: dir, FLAIR_CAPTURE_DIR: join(dir, ".flair", "capture"), FLAIR_CAPTURE_NO_FLUSH: "1" },
      timeout: 10_000,
    });
    if (result.status !== 0 || result.stdout !== "" || result.stderr !== "") {
      throw new Error(`command run failed: status=${result.status} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
    }
    samples.push(performance.now() - start);
  }
  return samples;
}

async function main() {
  const runsIdx = process.argv.indexOf("--runs");
  const runs = runsIdx > -1 ? Number(process.argv[runsIdx + 1]) : 200;
  if (!(runs > 0)) throw new Error("--runs must be positive");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "flair-2068-lat-home-")));
  console.log(`artifact: ${ARTIFACT}`);
  console.log(`bun:      ${BUN}\n`);
  try {
    mkdirSync(join(home, ".flair", "capture"), { recursive: true, mode: 0o700 });
    const append = summarize("append (hook work)", measureAppend(runs, join(home, "inproc")));
    summarize("command (launcher + runtime + append)", measureCommand(runs, home));
    const ok = append.p95 <= APPEND_BUDGET_MS;
    console.log(`\nappend p95 <= ${APPEND_BUDGET_MS} ms: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
