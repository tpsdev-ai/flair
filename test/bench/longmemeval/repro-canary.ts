#!/usr/bin/env bun
/**
 * repro-canary.ts — the diagnostic behind the readiness gate's SHAPE.
 *
 * Ported from tps-bench with the harness (flair#1366). It is in the repo
 * because eval.ts's readiness-gate comment cites it as evidence, and a
 * classification a reviewer cannot check is a classification taken on faith.
 *
 * The question it settled (take-5 post-mortem, 2026-08-22): when the run died
 * waiting on canary 51a45a95__s50__t11 in vector-only mode, was that canary
 * UNINDEXED, or indexed but OUTRANKED (present, yet rank > 20 for its own
 * prefix query)?
 *
 * Method: ingest ONLY question 51a45a95's haystack into a fresh ephemeral
 * Harper with FLAIR_HYBRID_RETRIEVAL=false (the mode of the phase that died),
 * settle generously, then run the exact check the harness ran
 * (content.slice(0,200), limit 20) AND a limit-100 query to find the true
 * rank. Repeat under hybrid=true (the mode of the ingest phase that PASSED).
 * Also probe the proposed fix: a nonce canary under a SEPARATE probe agent.
 *
 * Result: in a fresh single-question store the canary ranks 1-2 in BOTH modes
 * — it was indexed all along. The failure needs the ~66k-row store, where
 * agent-filtered ANN candidate recall collapses for generic content in
 * pure-vector mode.
 *
 * Why that matters for the gate: ANY readiness gate built on search RANKING
 * can starve at scale, including a nonce self-match. So the hard gate became a
 * deterministic, scale-independent existence+embeddingModel-stamp check, and
 * the ranking probe was demoted to non-fatal telemetry. That demotion is what
 * lets the readiness gate be classified OPERATIONAL-ONLY: there is no
 * scale-sensitive threshold left that could be tuned toward a nicer number.
 *
 * Usage:
 *   bun test/bench/longmemeval/repro-canary.ts --dataset <longmemeval_s.json>
 */
import { startHarper, stopHarper } from "../../helpers/harper-lifecycle";
import {
  mkAgent, registerAgent, ingestSessionHistory, retrieveContext, signedFetch,
  type BenchClient, type TestAgent,
} from "../../../packages/flair-bench/lib/index";
import { loadDataset, entryToSessions, toSessionHistories } from "./dataset";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

const QID = process.env.LME_CANARY_QID ?? "51a45a95";

// No baked-in dataset path: the VM copy defaulted to an absolute /home path
// that only existed there. A shipped default that resolves to whatever is on
// disk is a trust anchor — require it explicitly.
const argi = process.argv.indexOf("--dataset");
const datasetPath = (argi >= 0 ? process.argv[argi + 1] : undefined) ?? process.env.LME_DATASET;
if (!datasetPath) {
  console.error("repro-canary requires --dataset <path to longmemeval_s.json> (or LME_DATASET)");
  process.exit(2);
}

const entries = loadDataset(datasetPath);
const entry = entries.find((e) => e.question_id === QID);
if (!entry) {
  console.error(`repro-canary: question ${QID} not present in ${datasetPath}`);
  process.exit(2);
}
const sessions = entryToSessions(entry);
const events = sessions.flatMap((s) => s.events);
const canary = events[events.length - 1]!;
console.log(`events: ${events.length}; canary id: ${canary.id}`);
console.log(`canary content (${canary.content.length} ch): ${JSON.stringify(canary.content.slice(0, 300))}`);

const startOpts = {
  cwd: process.env.LME_FLAIR_PKG_DIR,
  harperBinDir: process.env.LME_HARPER_BIN_DIR,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rank of `id` for `query`, or -1 when absent from the top `limit`. */
async function rankIn(client: BenchClient, query: string, limit: number, id: string): Promise<number> {
  const ctx = await retrieveContext(client, query, { limit, scoring: "raw" });
  return ctx.rankedIds.indexOf(id);
}

// The question agent is created once and REUSED across both modes: its keypair
// must survive the restart, or the second pass would query a different agent's
// (empty) scope and "prove" a starvation that is really an identity change.
let questionAgent: TestAgent | null = null;

async function testMode(hybrid: boolean, installDir?: string): Promise<string> {
  process.env.FLAIR_HYBRID_RETRIEVAL = hybrid ? "true" : "false";
  const harper = await startHarper({ ...startOpts, installDir });
  const dir = harper.installDir;
  try {
    if (!installDir) {
      questionAgent = mkAgent(`lme-shared-${QID}`);
      await registerAgent(harper, questionAgent);
      const c: BenchClient = { harper, agent: questionAgent };
      const t0 = performance.now();
      await ingestSessionHistory(c, toSessionHistories(sessions), { concurrency: 16 });
      console.log(`[hybrid=${hybrid}] ingested in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
      await sleep(20_000); // generous settle, far beyond anything the harness allows
    } else {
      await sleep(10_000);
    }
    const client: BenchClient = { harper, agent: questionAgent! };

    const q = canary.content.slice(0, 200);
    const r20 = await rankIn(client, q, 20, canary.id);   // the harness's exact check
    const r100 = await rankIn(client, q, 100, canary.id); // the true rank
    const rFull = await rankIn(client, canary.content.slice(0, 2000), 100, canary.id);

    // The proposed fix shape: a nonce under a SEPARATE probe agent.
    const probe = mkAgent(`lme-readiness-probe-${hybrid}`);
    await registerAgent(harper, probe);
    const pc: BenchClient = { harper, agent: probe };
    const nonce = `readiness-canary readiness-nonce-${randomUUID()}`;
    const pid = `probe__${hybrid}__${Date.now()}`;
    const w = await signedFetch(harper, probe, "PUT", `/Memory/${pid}`, {
      id: pid, agentId: probe.id, content: nonce, durability: "standard", createdAt: new Date().toISOString(),
    });
    if (!w.ok) throw new Error(`probe write failed ${w.status}`);
    let pRank = -1;
    const pt0 = Date.now();
    while (Date.now() - pt0 < 60_000) {
      pRank = await rankIn(pc, nonce, 20, pid);
      if (pRank >= 0) break;
      await sleep(1000);
    }

    // Agent scoping must hold across the shared store, or ingest-reuse would be
    // leaking one question's memories into another's retrieval.
    const leak = await rankIn(client, nonce, 100, pid);
    console.log(
      `[hybrid=${hybrid}] prefix200: rank@20=${r20} rank@100=${r100} | fullContent: rank=${rFull} | ` +
      `nonce-probe: rank=${pRank} in ${((Date.now() - pt0) / 1000).toFixed(1)}s | ` +
      `cross-agent leak: ${leak === -1 ? "NONE" : "LEAKED rank " + leak}`,
    );
    return dir;
  } finally {
    await stopHarper(harper, { keepInstallDir: true });
  }
}

const dir = await testMode(false); // the mode that died
await testMode(true, dir);         // the mode that passed
rmSync(dir, { recursive: true, force: true });
console.log("repro done");
