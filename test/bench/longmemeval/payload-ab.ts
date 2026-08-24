#!/usr/bin/env bun
/**
 * payload-ab.ts — the PAIRED, same-retrieval A/B on the reader payload format.
 *
 *   bun run test/bench/longmemeval/payload-ab.ts --dataset <path> \
 *     [--n 60] [--seed 0] [--ability temporal-reasoning] [--out <dir>] [--resume <jsonl>]
 *
 * ── Why paired ───────────────────────────────────────────────────────────────
 * The two payload formats differ ONLY in the reader prompt. Not in ingest, not
 * in retrieval, not in the reader, not in the judge. So running them as two
 * independent arms would spend two ingests and two retrievals to re-measure the
 * one thing they share, and would then compare two noisy accuracy numbers whose
 * noise is dominated by WHICH QUESTIONS landed in each sample.
 *
 * Instead: per question, ingest ONCE, retrieve ONCE, then format that SAME
 * retrieved set both ways and run the reader twice, judging both. Question
 * difficulty and retrieval luck are held EXACTLY constant within a pair and
 * difference out. What is left is the payload format.
 *
 * Cost: one ingest (~80s, the dominant term) + 2 reader + 2 judge calls per
 * question, versus two full arms. Power: the informative unit is the DISCORDANT
 * pair, so ~n=60 paired buys roughly what ~n=180 unpaired would here — see
 * paired-stats.ts for the statistic and its honest limits.
 *
 * ── Why this slice ───────────────────────────────────────────────────────────
 * The prior 30-question smoke slice could not measure this change at all: that
 * slice round-robins across abilities, carried a handful of temporal questions,
 * and scored 100% on them at baseline. A check at its ceiling cannot fire. This
 * runner selects 60 questions of ONE ability (default temporal-reasoning — the
 * ability the dated payload is hypothesised to help) by an explicit,
 * re-derivable rule: see dataset.ts selectAbilitySlice.
 *
 * ── What is held fixed ───────────────────────────────────────────────────────
 * Retrieval is the `flair` arm's configuration (hybrid BM25+RRF on, scoring raw,
 * readerTopK) over ONE shared ephemeral Harper store, agent-scoped per question.
 * The store grows as questions accumulate, exactly as it does in the four-arm
 * headline run; that growth affects BOTH sides of every pair identically because
 * both sides consume the same retrieved set, so it cannot bias the comparison.
 * There are no mode flips here (one retrieval configuration), so unlike the
 * headline run there are no per-question Harper restarts.
 *
 * Produces a content-addressed artifact. NEVER publishes one.
 */
import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, type HarperInstance } from "../../helpers/harper-lifecycle";
import {
  mkAgent, registerAgent, ingestSessionHistory, retrieveContext, adminOp, signedFetch,
  type BenchClient, type TestAgent,
} from "../../../packages/flair-bench/lib/index";
import {
  OLLAMA_HOST, JUDGE, READER, DATASET, RETRIEVAL, INGESTION,
  assertCrossFamily, hashConfig,
} from "./config";
import { assertModelPinned, pingOllama, generate, OllamaError } from "./ollama";
import { buildJudgePrompt, parseVerdict, JudgeParseError, JUDGE_PROMPT_TEMPLATES } from "./judge";
import {
  loadDataset, selectAbilitySlice, goldEvidenceFor, entryToSessions, toSessionHistories,
  abilityOf, type LmeEntry, type Ability,
} from "./dataset";
import {
  READER_SYSTEM, READER_PROMPT_VERSION, PAYLOAD_FORMATS, buildReaderPrompt, formatRetrievedAs,
  type PayloadFormat,
} from "./arms";
import { EXTRACTION_METHOD } from "./extraction";
import { stampArtifactHash, verifyStampedHash } from "./artifact";
import { mcnemarExact, pairedTable, type PairedTable } from "./paired-stats";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const clean = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
const pct = (x: number) => (x * 100).toFixed(1) + "%";

function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const hasFlag = (f: string) => process.argv.includes(f);

function gitCommit(): string | null {
  // stdio pipe: the bench VM runs from an exported tree with no .git, and a
  // "fatal: not a git repository" on stderr mid-report reads like a run failure.
  try { return execSync("git rev-parse HEAD", { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
}

/** The A and B sides. A is the CONTROL (what every run before 2026-08-23 fed
 *  the reader); B is the variant under test. Order is fixed and recorded — the
 *  reader is stateless at temperature 0, so there is no carry-over between the
 *  two calls, but "we did not randomise the order" is a fact the artifact should
 *  state rather than leave to be assumed. */
const SIDE_A: PayloadFormat = "v1-undated";
const SIDE_B: PayloadFormat = "v2-dated";

/** An A/B whose two sides are the same format measures nothing and would report
 *  a perfectly clean "no difference". Fail loud instead — same shape as
 *  config.ts's assertCrossFamily. Compared as strings so the const-literal types
 *  cannot narrow the check away. */
export function assertSidesDiffer(): void {
  for (const side of [SIDE_A, SIDE_B]) {
    if (!PAYLOAD_FORMATS.includes(side)) throw new Error(`payload-ab: "${side}" is not a declared PayloadFormat (${PAYLOAD_FORMATS.join(", ")})`);
  }
  if ((SIDE_A as string) === (SIDE_B as string)) {
    throw new Error(`payload-ab: both sides are "${SIDE_A}" — an A/B against itself always reports no difference. Refusing to run.`);
  }
}

interface PairRecord {
  questionId: string;
  ability: string;
  /** Retrieved memory ids in final rank order — the SAME set both sides saw. */
  rankedIds: string[];
  retrievalMs: number;
  /** Did retrieval surface any memory from a labelled answer session? */
  goldSessionHit: boolean;
  /** Did retrieval surface a turn the dataset flags `has_answer`? */
  goldAnswerHit: boolean;
  goldAnswerHitCount: number;
  sides: Record<PayloadFormat, {
    answer: string;
    verdict: string | null;
    judgeError: string | null;
    tokensFed: number;
    latencyMs: number;
  }>;
  cfg: string;
  at: string;
}

async function readAndJudge(
  host: string, entry: LmeEntry, context: string,
): Promise<PairRecord["sides"][PayloadFormat]> {
  const prompt = buildReaderPrompt(entry.question, entry.question_date, context);
  const g = await generate(host, READER, prompt);
  const answer = clean(g.response);
  const abstention = entry.question_id.includes("_abs");
  const { prompt: jp, allowed } = buildJudgePrompt({
    task: entry.question_type, question: entry.question, answer: entry.answer,
    response: answer, abstention,
  });
  const jg = await generate(host, JUDGE, jp);
  let verdict: string | null = null;
  let judgeError: string | null = null;
  try { verdict = parseVerdict(jg.response, allowed); }
  catch (err) {
    if (err instanceof JudgeParseError) judgeError = err.message;
    else throw err;
  }
  return { answer, verdict, judgeError, tokensFed: g.promptTokens, latencyMs: g.latencyMs };
}

async function main(): Promise<void> {
  assertCrossFamily();
  assertSidesDiffer();
  const host = arg("--host", OLLAMA_HOST)!;
  const datasetPath = arg("--dataset");
  if (!datasetPath) { console.error("payload-ab requires --dataset <path to longmemeval_s.json>"); process.exit(2); }
  const n = parseInt(arg("--n", "60")!, 10);
  const seed = parseInt(arg("--seed", "0")!, 10);
  const ability = arg("--ability", "temporal-reasoning") as Ability;
  const outDir = arg("--out", path.join(REPO_ROOT, "longmemeval-artifacts"))!;
  const allowUnpinned = hasFlag("--allow-unpinned");
  const recordsPath = arg("--records", path.join(outDir, `payload-ab-records-${ability}-n${n}-seed${seed}.jsonl`))!;
  const progressPath = arg("--progress");
  const resumePath = arg("--resume");

  // Harper serves resources from dist/ — a missing build is a silent no-op run.
  const marker = path.join(process.env.LME_FLAIR_PKG_DIR ?? REPO_ROOT, "dist", "resources", "SemanticSearch.js");
  if (!existsSync(marker)) { console.error(`FATAL: ${marker} not found — run \`bun run build\` first.`); process.exit(2); }

  console.log(`\n=== LongMemEval_s — PAIRED reader-payload A/B (${SIDE_A} vs ${SIDE_B}) ===`);
  await pingOllama(host);
  await assertModelPinned(host, READER);
  await assertModelPinned(host, JUDGE);
  console.log(`reader=${READER.model} (${READER.family})  judge=${JUDGE.model} (${JUDGE.family})  [digests verified]`);

  const entries = loadDataset(datasetPath!, { allowUnpinned });
  const slice = selectAbilitySlice(entries, ability, n, seed);
  const candidates = entries.filter((e) => abilityOf(e) === ability).length;
  console.log(`dataset ${DATASET.name}: ${entries.length} questions; ability "${ability}" has ${candidates}; slice ${slice.length} (seed ${seed})`);

  // Gold-evidence labels must be MAPPABLE or the attribution read is decorative.
  const unmappable = slice.filter((e) => goldEvidenceFor(e).unresolvedSessionIds.length > 0);
  if (unmappable.length > 0) {
    throw new Error(
      `gold-evidence labels unmappable for ${unmappable.length} question(s) (e.g. ${unmappable[0]!.question_id}): ` +
      `answer_session_ids not found in haystack_session_ids. The attribution read would silently score 0 — refusing to run.`,
    );
  }

  // ── The hashed, self-describing config. The paired DESIGN lives in here so
  //    the artifact explains its own experiment without a companion document.
  const manifest = {
    schema: "longmemeval-s.payload-ab.config/1",
    design: {
      kind: "paired-same-retrieval-ab",
      unitOfAnalysis: "question",
      statedAs:
        "For each question: ingest its haystack ONCE, retrieve ONCE, then format that SAME retrieved " +
        "set both ways and run the pinned reader twice (once per payload format), judging both with the " +
        "pinned judge. Ingest, retrieval, reader model, judge model, prompts and question set are IDENTICAL " +
        "across the two sides by construction — the ONLY difference is the payload format of the retrieved " +
        "memories inside the reader prompt.",
      sideA: SIDE_A,
      sideB: SIDE_B,
      sideOrder: "A then B, fixed (reader is stateless at temperature 0; order was NOT randomised)",
      statistic:
        "Exact two-sided McNemar on the discordant pairs (v1-wrong/v2-right vs v1-right/v2-wrong). " +
        "Concordant pairs carry no information about the format and are reported but not tested.",
      powerNote:
        "Pairing differences out question difficulty and retrieval luck, which dominate the variance here; " +
        "n=60 paired is worth roughly n=180 unpaired for this contrast. It still cannot detect an effect " +
        "smaller than the discordant count can express — the artifact reports that count so the reader can " +
        "judge the null honestly.",
      attribution:
        "Per question the retrieved id set is checked against the dataset's own evidence labels " +
        "(answer_session_ids, and the per-turn has_answer flags within them). A null result on the " +
        "gold-evidence-hit subset means dates did not help; a null driven by misses means the evidence " +
        "was not there to date in the first place.",
    },
    dataset: DATASET,
    judge: JUDGE,
    reader: READER,
    retrieval: { ...RETRIEVAL, hybrid: true, arm: "flair", storeSharing: "one-shared-store-no-mode-flips" },
    ingestion: INGESTION,
    prompts: {
      judge: JUDGE_PROMPT_TEMPLATES,
      readerSystem: READER_SYSTEM,
      readerPromptVersion: READER_PROMPT_VERSION,
      payloadFormats: { A: SIDE_A, B: SIDE_B },
    },
    extraction: EXTRACTION_METHOD,
    slice: {
      ability, n, seed,
      abilityCandidates: candidates,
      selectionRule:
        "entries with abilityOf(e)===ability (abstention rolls up to 'abstention', so *_abs is excluded " +
        "by construction), ordered by sha256(`${seed}:${question_id}`) ascending, first n taken, emitted " +
        "sorted by question_id. A keyed pseudo-random draw, NOT a lexicographic prefix: question_id " +
        "prefixes encode question provenance (gpt4_* is 67% of the temporal-reasoning population but only " +
        "30% of a lexicographic first-60), so a prefix draw would confound provenance with the treatment.",
      questionIds: slice.map((e) => e.question_id).sort(),
    },
  };
  const configHash = hashConfig(manifest);
  const cfgShort = configHash.slice(0, 16);
  console.log(`configHash: ${configHash}`);
  console.log(`records: ${recordsPath}`);

  // ── Resume: skip questions already fully recorded (both sides judged). ─────
  // Documented limit: a resumed run re-ingests into a FRESH store, so resumed
  // questions face a smaller corpus than they did originally. That shifts
  // retrieval difficulty across questions — it does NOT break the pairing,
  // because both sides of every pair still consume one identical retrieved set.
  const banked = new Map<string, PairRecord>();
  if (resumePath) {
    for (const line of readFileSync(resumePath, "utf8").split("\n").filter((l) => l.trim())) {
      const r = JSON.parse(line) as PairRecord;
      if (r.cfg !== cfgShort) throw new Error(`resume: record for ${r.questionId} carries cfg ${r.cfg}, expected ${cfgShort} — refusing to mix configs`);
      if (r.sides?.[SIDE_A] && r.sides?.[SIDE_B]) banked.set(r.questionId, r);
    }
    console.log(`resume: ${banked.size} question(s) already paired in ${resumePath} — skipping their ingest`);
  }
  const todo = slice.filter((e) => !banked.has(e.question_id));

  const startOpts = () => ({
    cwd: process.env.LME_FLAIR_PKG_DIR ?? REPO_ROOT,
    harperBinDir: process.env.LME_HARPER_BIN_DIR ?? REPO_ROOT,
  });
  const prevHybrid = process.env.FLAIR_HYBRID_RETRIEVAL;
  process.env.FLAIR_HYBRID_RETRIEVAL = "true"; // the `flair` arm's retrieval
  const records: PairRecord[] = [...banked.values()];
  let harper: HarperInstance = await startHarper(startOpts());
  const installDir = harper.installDir;
  console.log(`store: ${installDir}  (hybrid=true, one shared store, no mode flips)\n`);

  // ── Readiness gate (ported from eval.ts's take-5 post-mortem shape) ────────
  // HARD GATE: ops-API SQL — the last-ingested canary row EXISTS and carries an
  // embeddingModel stamp (persisted + embedded). Scale-independent, unlike any
  // gate built on search RANKING, which starves as the store grows.
  // SOFT PROBE: a nonce self-query under a separate probe agent; logged, never
  // fatal. Deadline scales from MEASURED waits; one same-store restart on a
  // blown deadline before failing the run.
  let maxSearchWaitMs = 5_000;
  const searchDeadlineMs = () => Math.min(1_200_000, Math.max(90_000, 6 * maxSearchWaitMs));
  async function canaryStamped(entry: LmeEntry): Promise<{ ready: boolean; detail: string }> {
    const events = entryToSessions(entry).flatMap((s) => s.events);
    const canary = events[events.length - 1];
    if (!canary) return { ready: true, detail: "no events" };
    const res = await adminOp(harper, { operation: "sql", sql: `SELECT id, embeddingModel FROM flair.Memory WHERE id = '${canary.id}'` });
    if (!res.ok) return { ready: false, detail: `sql HTTP ${res.status}` };
    const j: any = await res.json().catch(() => null);
    const row = Array.isArray(j) ? j[0] : null;
    if (!row) return { ready: false, detail: `row ${canary.id} absent` };
    if (!row.embeddingModel) return { ready: false, detail: `row ${canary.id} embedding unstamped` };
    return { ready: true, detail: "persisted+stamped" };
  }
  async function pollStamped(entry: LmeEntry, deadlineMs: number): Promise<number> {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < deadlineMs) {
      const r = await canaryStamped(entry);
      if (r.ready) return Date.now() - t0;
      last = r.detail;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error(`readiness gate: canary for ${entry.question_id} not persisted+stamped within ${deadlineMs}ms (last: ${last})`);
  }
  let probeAgent: TestAgent | null = null;
  async function softSearchProbe(tag: string): Promise<void> {
    try {
      if (!probeAgent) { probeAgent = mkAgent("payload-ab-readiness-probe"); await registerAgent(harper, probeAgent); }
      const nonce = `readiness-canary readiness-nonce-${randomUUID()}`;
      const pid = `probe__${Date.now()}__${Math.floor(Math.random() * 1e6)}`;
      const w = await signedFetch(harper, probeAgent, "PUT", `/Memory/${pid}`,
        { id: pid, agentId: probeAgent.id, content: nonce, durability: "standard", createdAt: new Date().toISOString() });
      if (!w.ok) { console.log(`  [probe-warn] ${tag}: nonce write HTTP ${w.status}`); return; }
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        const ctx = await retrieveContext({ harper, agent: probeAgent }, nonce, { limit: 20 });
        if (ctx.rankedIds.includes(pid)) return;
        await new Promise((res) => setTimeout(res, 1000));
      }
      console.log(`  [probe-warn] ${tag}: nonce not surfacing via search within 20s (hard gate passed; telemetry only)`);
    } catch (err) {
      console.log(`  [probe-warn] ${tag}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }
  async function ensureSearchable(entry: LmeEntry): Promise<void> {
    const deadline = searchDeadlineMs();
    try {
      maxSearchWaitMs = Math.max(maxSearchWaitMs, await pollStamped(entry, deadline));
    } catch (err) {
      console.log(`  !! readiness timeout (${deadline}ms) for ${entry.question_id} — one same-store restart+retry`);
      await stopHarper(harper, { keepInstallDir: true });
      harper = await startHarper({ ...startOpts(), installDir });
      maxSearchWaitMs = Math.max(maxSearchWaitMs, await pollStamped(entry, deadline));
      console.log(`  recovered after restart: ${entry.question_id} ready`);
    }
    await softSearchProbe(entry.question_id);
  }

  const t0All = Date.now();
  try {
    for (let qi = 0; qi < todo.length; qi++) {
      const entry = todo[qi]!;
      const agent = mkAgent(`payload-ab-${entry.question_id}`);
      await registerAgent(harper, agent);
      const client: BenchClient = { harper, agent };
      const sessions = entryToSessions(entry);
      const ing = await ingestSessionHistory(client, toSessionHistories(sessions), {
        concurrency: Math.max(1, parseInt(process.env.LME_INGEST_CONCURRENCY ?? "6", 10) || 6),
      });
      await ensureSearchable(entry);

      // ONE retrieval. Both sides consume exactly this.
      const tR = performance.now();
      const ctx = await retrieveContext(client, entry.question, { limit: RETRIEVAL.readerTopK, scoring: RETRIEVAL.scoring });
      const retrievalMs = performance.now() - tR;

      const gold = goldEvidenceFor(entry);
      const got = new Set(ctx.rankedIds);
      const goldSessionHit = gold.sessionEventIds.some((id) => got.has(id));
      const answerHits = gold.answerEventIds.filter((id) => got.has(id));

      const sides = {} as PairRecord["sides"];
      for (const fmt of [SIDE_A, SIDE_B]) {
        sides[fmt] = await readAndJudge(host, entry, formatRetrievedAs(ctx.items, fmt));
      }

      const rec: PairRecord = {
        questionId: entry.question_id, ability: abilityOf(entry),
        rankedIds: ctx.rankedIds, retrievalMs,
        goldSessionHit, goldAnswerHit: answerHits.length > 0, goldAnswerHitCount: answerHits.length,
        sides, cfg: cfgShort, at: new Date().toISOString(),
      };
      records.push(rec);
      try { appendFileSync(recordsPath, JSON.stringify(rec) + "\n"); } catch { /* journal is best-effort */ }

      const a = sides[SIDE_A].verdict, b = sides[SIDE_B].verdict;
      // The pair's cell is decided by CORRECTNESS, not by verdict equality:
      // NOT_ATTEMPTED vs INCORRECT are different verdicts but the same cell
      // (both wrong), and a marker that called that a loss would misreport the
      // discordant count a reader is scanning the log for.
      const aOk = a === "CORRECT", bOk = b === "CORRECT";
      const mark = aOk === bOk ? "=" : (bOk ? "+" : "-");
      const elapsedMin = (Date.now() - t0All) / 60000;
      const etaMin = qi + 1 < todo.length ? (elapsedMin / (qi + 1)) * (todo.length - qi - 1) : 0;
      console.log(
        `  [${String(qi + 1).padStart(2)}/${todo.length}] ${entry.question_id.padEnd(16)} ` +
        `${mark} A=${String(a).padEnd(13)} B=${String(b).padEnd(13)} ` +
        `gold(sess/ans)=${goldSessionHit ? "Y" : "n"}/${answerHits.length} ` +
        `ingest=${(ing.elapsedMs / 1000).toFixed(0)}s retr=${retrievalMs.toFixed(0)}ms ` +
        `| elapsed ${elapsedMin.toFixed(0)}m eta ${etaMin.toFixed(0)}m`,
      );
      if (progressPath) {
        try {
          writeFileSync(progressPath, JSON.stringify({
            unit: "question-pair", total: slice.length, done: records.length,
            startedAt: new Date(t0All).toISOString(), updatedAt: new Date().toISOString(),
            etaMinutes: Math.round(etaMin), configHash, done_: false,
          }, null, 2));
        } catch { /* best effort */ }
      }
    }
  } finally {
    await stopHarper(harper, { keepInstallDir: false });
    try { rmSync(installDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* best effort */ }
    if (prevHybrid === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL;
    else process.env.FLAIR_HYBRID_RETRIEVAL = prevHybrid;
  }

  report(records, manifest, configHash, outDir, host, slice.length);
}

/** A judge error on EITHER side voids the pair: it is excluded from the table
 *  and counted, never silently folded in as a wrong answer. */
function usablePairs(records: PairRecord[]) {
  const usable = records.filter((r) => !r.sides[SIDE_A].judgeError && !r.sides[SIDE_B].judgeError && r.sides[SIDE_A].verdict && r.sides[SIDE_B].verdict);
  return { usable, voided: records.length - usable.length };
}

function tableFor(records: PairRecord[]): PairedTable {
  return pairedTable(records.map((r) => ({
    v1: r.sides[SIDE_A].verdict === "CORRECT",
    v2: r.sides[SIDE_B].verdict === "CORRECT",
  })));
}

function report(
  records: PairRecord[], manifest: unknown, configHash: string, outDir: string,
  host: string, sliceSize: number,
): void {
  const { usable, voided } = usablePairs(records);
  const table = tableFor(usable);
  const mc = mcnemarExact(table.wins, table.losses);

  // Attribution split: did retrieval even put the evidence in front of the reader?
  const withEvidence = usable.filter((r) => r.goldAnswerHit);
  const withoutEvidence = usable.filter((r) => !r.goldAnswerHit);
  const tEv = tableFor(withEvidence), mcEv = mcnemarExact(tEv.wins, tEv.losses);
  const tNo = tableFor(withoutEvidence), mcNo = mcnemarExact(tNo.wins, tNo.losses);
  const sessionHitRate = usable.length ? usable.filter((r) => r.goldSessionHit).length / usable.length : 0;
  const answerHitRate = usable.length ? withEvidence.length / usable.length : 0;

  const results = {
    pairsAttempted: records.length,
    pairsVoidedByJudgeError: voided,
    overall: { table, mcnemar: mc },
    attribution: {
      goldSessionHitRate: sessionHitRate,
      goldAnswerHitRate: answerHitRate,
      withGoldEvidence: { n: withEvidence.length, table: tEv, mcnemar: mcEv },
      withoutGoldEvidence: { n: withoutEvidence.length, table: tNo, mcnemar: mcNo },
    },
    perQuestion: records.map((r) => ({
      questionId: r.questionId,
      a: r.sides[SIDE_A].verdict, b: r.sides[SIDE_B].verdict,
      goldSessionHit: r.goldSessionHit, goldAnswerHitCount: r.goldAnswerHitCount,
      retrievedCount: r.rankedIds.length,
    })).sort((x, y) => x.questionId.localeCompare(y.questionId)),
  };

  // Same partition discipline as the four-arm artifact (artifact.ts): hashed
  // CONTENT above, unhashed PROVENANCE (generatedAt, host, notice, artifactHash)
  // below, stamped after. resultsHash content-addresses the results alone so a
  // reviewer can cite the numbers independently of the config they came from.
  const artifact = stampArtifactHash({
    schema: "longmemeval-s.payload-ab.artifact/1",
    validationSlice: true,
    gitCommit: gitCommit(),
    configHash,
    config: manifest,
    resultsHash: hashConfig(results),
    results,
    // ── provenance (excluded from the hash) ──
    notice:
      "VALIDATION ARTIFACT — NOT FOR PUBLICATION. This harness produces numbers; it does not publish " +
      "them. Publishing any number requires a recorded human sign-off referencing this artifact's " +
      "artifactHash. Spend and outward-publishing are the founder's gates.",
    generatedAt: new Date().toISOString(),
    host: { ollama: host, benchHost: process.env.LME_BENCH_HOST ?? "unknown" },
  });

  const outPath = path.join(outDir, `payload-ab-artifact-${artifact.artifactHash.slice(0, 16)}.json`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));

  const bar = "═".repeat(72);
  console.log(`\n${bar}\n  PAIRED READER-PAYLOAD A/B — ${SIDE_A} (A) vs ${SIDE_B} (B)\n${bar}`);
  console.log(`  slice: ${sliceSize} questions | pairs attempted ${records.length} | usable ${usable.length}` +
              (voided ? ` | VOIDED by judge error ${voided}` : ""));
  console.log(`\n  paired 2x2 (rows = A/v1-undated, cols = B/v2-dated)`);
  console.log(`    ${"".padEnd(18)}${"B right".padEnd(12)}${"B wrong".padEnd(12)}`);
  console.log(`    ${"A right".padEnd(18)}${String(table.bothRight).padEnd(12)}${String(table.losses).padEnd(12)}`);
  console.log(`    ${"A wrong".padEnd(18)}${String(table.wins).padEnd(12)}${String(table.bothWrong).padEnd(12)}`);
  console.log(`\n  wins  (A wrong -> B right): ${table.wins}`);
  console.log(`  losses(A right -> B wrong): ${table.losses}`);
  console.log(`  concordant (both same)    : ${table.bothRight + table.bothWrong}  (${table.bothRight} both right, ${table.bothWrong} both wrong)`);
  console.log(`  DISCORDANT pairs          : ${mc.discordant}   <- the only pairs carrying information`);
  console.log(`\n  overall accuracy  A (${SIDE_A}) = ${pct(table.v1Accuracy)}   B (${SIDE_B}) = ${pct(table.v2Accuracy)}   delta = ${(table.delta * 100).toFixed(1)} pts`);
  console.log(`  McNemar exact two-sided p = ${mc.p.toFixed(4)}  (lean: ${mc.direction})`);
  console.log(
    mc.minSplitForP05 === null
      ? `  UNDERPOWERED BY CONSTRUCTION: at ${mc.discordant} discordant pair(s), NO split reaches p<0.05 — this run could not have detected any effect`
      : `  at ${mc.discordant} discordant pairs, p<0.05 needs a ${mc.minSplitForP05}-${mc.discordant - mc.minSplitForP05} split or wider`,
  );
  console.log(`\n  ── attribution: was the evidence even retrieved? ──`);
  console.log(`  gold SESSION hit rate (any memory from a labelled answer session): ${pct(sessionHitRate)}`);
  console.log(`  gold ANSWER  hit rate (a has_answer turn retrieved)             : ${pct(answerHitRate)}`);
  console.log(`    with gold evidence    (n=${tEv.n}): A ${pct(tEv.v1Accuracy)} B ${pct(tEv.v2Accuracy)} | wins ${tEv.wins} losses ${tEv.losses} discordant ${mcEv.discordant} p=${mcEv.p.toFixed(4)}`);
  console.log(`    without gold evidence (n=${tNo.n}): A ${pct(tNo.v1Accuracy)} B ${pct(tNo.v2Accuracy)} | wins ${tNo.wins} losses ${tNo.losses} discordant ${mcNo.discordant} p=${mcNo.p.toFixed(4)}`);
  console.log(`\n  configHash  : ${configHash}`);
  console.log(`  resultsHash : ${artifact.resultsHash}`);
  console.log(`  artifactHash: ${artifact.artifactHash}`);
  console.log(`  self-verifies: ${verifyStampedHash(artifact)}`);
  console.log(`  written     : ${outPath}`);
  console.log(`\nNOTICE: ${artifact.notice}\n`);
}

main().catch((err) => {
  if (err instanceof OllamaError) console.error(`\nOLLAMA/JUDGE SEAM: ${err.message}\n`);
  else console.error(err);
  process.exit(1);
});
