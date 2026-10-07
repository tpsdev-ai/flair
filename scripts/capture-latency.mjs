#!/usr/bin/env node
/**
 * Capture hot-path latency gate (flair#2068).
 *
 * Process start-up (the launcher and Bun) happens before the hook runs and is
 * reported for context, not gated, as for the other hooks.
 *
 * Gated, timed in-process with a monotonic timer against a spool already at
 * its record cap, each run asserted to have done its work:
 *   - "stop": a Stop decision appended, including the real background-flush
 *     kick (slot claim + detached spawn).
 *   - "failure": a PostToolUseFailure recorded as a pending error.
 *   - "fix": the PostToolUse that pairs with it, appended, including the kick.
 *   - "pair": failure + fix.
 *   - "kick": the flush kick alone.
 * The kick's `npx` is a stub on PATH that logs and exits, so the spawn is real,
 * nothing is fetched, and every kick is checked to have spawned. The flush
 * stamp is removed before each timed run so every kick claims the slot.
 *
 * Usage: node scripts/capture-latency.mjs [--runs 200]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const ARTIFACT = join(ROOT, "packages", "flair-mcp", "dist", "capture-hook.js");
const SPOOL_SOURCE = join(ROOT, "packages", "flair-mcp", "src", "capture-spool.ts");
const HOOK_SOURCE = join(ROOT, "packages", "flair-mcp", "src", "capture-hook.ts");
const BUN = process.env.FLAIR_BUN_PATH || join(process.env.HOME || "", ".bun", "bin", "bun");

const BUDGET_MS = 10;

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
  return { p50, p95 };
}

/** The hook's own work, timed in-process. Throws if any run did not do it. */
function measureInProcess(runs, home, stubBin) {
  const dir = join(home, "inproc");
  const program = `
    import { appendRecord, flushStampPath, readSpool, runCapture, spoolPath, CAPTURE_SPOOL_MAX_RECORDS } from ${JSON.stringify(SPOOL_SOURCE)};
    import { captureHash } from ${JSON.stringify(join(ROOT, "packages/flair-mcp/src/capture.ts"))};
    import { kickBackgroundFlush } from ${JSON.stringify(HOOK_SOURCE)};
    import { readFileSync, rmSync, statSync } from "node:fs";
    import { performance } from "node:perf_hooks";
    const dir = ${JSON.stringify(dir)};
    const agent = ${JSON.stringify(AGENT)};
    const spawns = ${JSON.stringify(join(home, "spawns.log"))};
    const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir, FLAIR_CAPTURE_FLUSH_SPEC: "@tpsdev-ai/flair-mcp@0.0.0-latency", PATH: ${JSON.stringify(stubBin)} + ":/usr/bin:/bin", FLAIR_LATENCY_SPAWNS: spawns };
    for (let i = 0; i < CAPTURE_SPOOL_MAX_RECORDS; i++) {
      appendRecord(dir, agent, { kind: "decision", content: "x".repeat(380) + i, dedupKey: captureHash("fill" + i), provenance: { hook: "Stop", sessionId: "lat", cwd: "/repo/" + "d".repeat(40), capturedAt: new Date().toISOString() } });
    }
    const deps = { env, dir, kickFlush: () => kickBackgroundFlush(env) };
    const resetSlot = () => rmSync(flushStampPath(dir, agent), { force: true });
    const expectReason = (what, got, want) => { if (got !== want) throw new Error(what + " returned " + got + ", expected " + want); };
    const out = { stop: [], failure: [], fix: [], pair: [], kick: [] };
    const tail = "progress\\n".repeat(400) + "fatal: cause";
    for (let i = 0; i < ${runs}; i++) {
      const stop = JSON.stringify({ session_id: "lat", cwd: "/repo", hook_event_name: "Stop", last_assistant_message: "Decision: prefer host-" + i + " for embeddings." });
      const command = "bun test case-" + i;
      const failure = JSON.stringify({ session_id: "lat", cwd: "/repo", hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_f" + i, error: "Exit code 1\\n" + tail, is_interrupt: false, duration_ms: 5 });
      const fix = JSON.stringify({ session_id: "lat", cwd: "/repo", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_s" + i, tool_response: { stdout: "1 pass", stderr: "", interrupted: false, isImage: false } });

      resetSlot();
      let t = performance.now();
      expectReason("stop", runCapture(stop, deps).reason, "appended");
      out.stop.push(performance.now() - t);

      t = performance.now();
      expectReason("failure", runCapture(failure, deps).reason, "error-recorded");
      const failureMs = performance.now() - t;
      out.failure.push(failureMs);

      resetSlot();
      t = performance.now();
      expectReason("fix", runCapture(fix, deps).reason, "appended");
      const fixMs = performance.now() - t;
      out.fix.push(fixMs);
      out.pair.push(failureMs + fixMs);

      resetSlot();
      t = performance.now();
      kickBackgroundFlush(env);
      out.kick.push(performance.now() - t);
      if (!statSync(flushStampPath(dir, agent)).isFile()) throw new Error("kick did not claim the flush slot");
    }
    // Three kicks per run (stop, fix, kick): every one must have spawned.
    const want = ${runs} * 3;
    const count = () => { try { return readFileSync(spawns, "utf8").split("\\n").filter(Boolean).length; } catch { return 0; } };
    const deadline = Date.now() + 10_000;
    while (count() < want && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    if (count() < want) throw new Error("only " + count() + " of " + want + " kicks spawned");
    out.spawned = count();
    const spool = readSpool(dir, agent);
    out.spoolRecords = spool.length;
    out.spoolBytes = statSync(spoolPath(dir, agent)).size;
    process.stdout.write(JSON.stringify(out));
  `;
  const out = execFileSync(BUN, ["-e", program], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${stubBin}:${process.env.PATH ?? ""}` },
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function measureCommand(runs, home) {
  const dir = join(home, ".flair", "capture");
  const command = `sh -c 'FLAIR_AGENT_ID=${AGENT} ${BUN} ${ARTIFACT} >/dev/null 2>/dev/null || true'`;
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const payload = JSON.stringify({ session_id: "lat", hook_event_name: "Stop", last_assistant_message: `Decision: prefer host-${i} for search.` });
    const start = performance.now();
    const result = spawnSync("sh", ["-c", command], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, HOME: home, FLAIR_CAPTURE_DIR: dir, FLAIR_CAPTURE_NO_FLUSH: "1" },
      timeout: 10_000,
    });
    samples.push(performance.now() - start);
    if (result.status !== 0 || result.stdout !== "" || result.stderr !== "") {
      throw new Error(`command run failed: status=${result.status} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
    }
    const spool = JSON.parse(readFileSync(join(dir, `${AGENT}.spool.json`), "utf8"));
    if (!spool.records.some((r) => r.content.includes(`host-${i} `))) throw new Error(`command run ${i} did not append`);
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
    const stubBin = join(home, "bin");
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(join(stubBin, "npx"), '#!/bin/sh\necho "$$" >> "$FLAIR_LATENCY_SPAWNS"\n');
    chmodSync(join(stubBin, "npx"), 0o755);

    const measured = measureInProcess(runs, home, stubBin);
    console.log(`spool during measurement: ${measured.spoolRecords} records, ${measured.spoolBytes} bytes; flush spawns observed: ${measured.spawned}\n`);
    const gated = {
      "stop (append + kick)": summarize("stop (append + kick)", measured.stop),
      "failure (pending write)": summarize("failure (pending write)", measured.failure),
      "fix (pair + append + kick)": summarize("fix (pair + append + kick)", measured.fix),
      "pair (failure + fix)": summarize("pair (failure + fix)", measured.pair),
      "kick (slot claim + spawn)": summarize("kick (slot claim + spawn)", measured.kick),
    };
    summarize("command (launcher + runtime + append), not gated", measureCommand(runs, home));
    let ok = true;
    console.log("");
    for (const [name, { p95 }] of Object.entries(gated)) {
      const pass = p95 <= BUDGET_MS;
      ok &&= pass;
      console.log(`${name} p95 <= ${BUDGET_MS} ms: ${pass ? "PASS" : "FAIL"}`);
    }
    process.exitCode = ok ? 0 : 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
