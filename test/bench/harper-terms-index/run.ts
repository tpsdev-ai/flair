// flair#2047 spike runner. Builds the in-process resource, starts an isolated
// Harper, and writes results JSON. Not a unit-lane test.
//
//   bun run test/bench/harper-terms-index/run.ts --sizes 1000,10000,100000
//
// Decision rule (issue): adopt unless ingest regresses by more than ~20% OR
// query p95 exceeds ~2× today's warm in-memory index at 100k.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { PROFILE } from "./src/corpus.ts";
import { assertOracleMatchesShipped } from "./src/rank.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const HARPER_BIN = join(REPO, "node_modules", "harper", "dist", "bin", "harper.js");

function nodeSatisfiesHarper(bin: string): boolean {
  try {
    const out = execFileSync(bin, ["-v"], { encoding: "utf8" }).trim();
    const m = out.match(/v?(\d+)\.(\d+)\.(\d+)/);
    if (!m) return false;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 22 || (major === 22 && minor >= 18);
  } catch {
    return false;
  }
}

/** Harper refuses Node < 22.18. Prefer NODE_BIN, then `node`, then an nvm install. */
function resolveNode(): string {
  const candidates: string[] = [];
  if (process.env.NODE_BIN) candidates.push(process.env.NODE_BIN);
  candidates.push("node");
  const nvm = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(nvm)) {
    for (const ver of readdirSync(nvm)) candidates.push(join(nvm, ver, "bin", "node"));
  }
  for (const bin of candidates) if (nodeSatisfiesHarper(bin)) return bin;
  throw new Error(`no Node ^22.18 || >=24 on PATH (Harper requirement). Set NODE_BIN. Tried ${candidates.join(", ")}`);
}

const NODE = resolveNode();

interface Dist {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

interface Cell extends Dist {
  scope: string;
  band: string;
  requestedTerms: number;
  terms: number;
  query: string;
  stats?: string;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function assertProfile(): void {
  const v2 = JSON.parse(readFileSync(join(REPO, "test/bench/corpus-profiler/profiles/corpus-v2.json"), "utf8"));
  const live = JSON.parse(readFileSync(join(REPO, "test/bench/corpus-profiler/profiles/live-flint-2026-07.json"), "utf8"));
  const tok = v2.scale.contentTokens;
  const checks: [string, unknown, unknown][] = [
    ["tokenMean", tok.mean, PROFILE.tokenMean],
    ["tokenStdev", tok.stdev, PROFILE.tokenStdev],
    ["tokenMin", tok.min, PROFILE.tokenMin],
    ["tokenMax", tok.max, PROFILE.tokenMax],
    ["zipfSlope", v2.vocabulary.zipfSlope, PROFILE.zipfSlope],
    ["vocabTokens", v2.vocabulary.tokenCount, PROFILE.vocabTokens],
    ["vocabTypes", v2.vocabulary.typeCount, PROFILE.vocabTypes],
  ];
  for (const [label, got, want] of checks) {
    if (got !== want) throw new Error(`profile drift ${label}: json=${got} harness=${want}`);
  }
  if (JSON.stringify(live.scale.recordsPerAgentSorted) !== JSON.stringify([...PROFILE.scopeWeights])) {
    throw new Error("profile drift scopeWeights");
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function du(path: string): number {
  const out = execFileSync("du", ["-sb", path], { encoding: "utf8" });
  return Number(out.trim().split(/\s+/)[0]);
}

function gitSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
}

async function waitFor(proc: ChildProcess, logPath: string, httpURL: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Harper exited ${proc.exitCode} during startup. Log: ${logPath}`);
    }
    try {
      // This app has no Flair /health route. Any HTTP response means the
      // listener is up; 200 from the spike resource means it is loaded.
      const res = await fetch(`${httpURL}/Bm25TermsSpike`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ op: "health" }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Harper health timed out. Log: ${logPath}`);
}

function pipe(proc: ChildProcess, logPath: string): void {
  const on = (buf: Buffer) => {
    const text = buf.toString();
    appendFileSync(logPath, text);
    for (const line of text.split("\n")) {
      if (line.includes("spike:") || /error|unable to bind/i.test(line)) console.log(line);
    }
  };
  proc.stdout?.on("data", on);
  proc.stderr?.on("data", on);
}

async function startHarper(logPath: string): Promise<{ proc: ChildProcess; httpURL: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "bm25-spike-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROOTPATH: root,
    HOME: root,
    DEFAULTS_MODE: "dev",
    HDB_ADMIN_USERNAME: "admin",
    HDB_ADMIN_PASSWORD: "test123",
    THREADS_COUNT: "1",
    NODE_HOSTNAME: "127.0.0.1",
    MQTT_NETWORK_PORT: "null",
    MQTT_NETWORK_SECUREPORT: "null",
    MQTT_WEBSOCKET: "false",
    THREADS_DEBUG: "false",
  };
  delete env.GITHUB_TOKEN;
  delete env.NPM_TOKEN;
  const install = spawn(NODE, [HARPER_BIN, "install"], { cwd: HERE, env });
  pipe(install, logPath);
  const installCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { install.kill("SIGTERM"); reject(new Error("harper install timed out")); }, 60_000);
    install.on("exit", (code) => { clearTimeout(timer); resolve(code ?? 1); });
    install.on("error", reject);
  });
  if (installCode !== 0) throw new Error(`harper install exited ${installCode}. Log: ${logPath}`);

  const httpPort = await freePort();
  const opsPort = await freePort();
  const runEnv = {
    ...env,
    HTTP_PORT: `127.0.0.1:${httpPort}`,
    OPERATIONSAPI_NETWORK_PORT: String(opsPort),
  };
  const proc = spawn(NODE, [HARPER_BIN, "run", "."], { cwd: HERE, env: runEnv });
  pipe(proc, logPath);
  const httpURL = `http://127.0.0.1:${httpPort}`;
  await waitFor(proc, logPath, httpURL);
  return { proc, httpURL, root };
}

function stop(proc: ChildProcess | null): void {
  if (!proc) return;
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 2000).unref();
  }
  proc.unref();
}

const auth = `Basic ${Buffer.from("admin:test123").toString("base64")}`;

async function call(httpURL: string, body: unknown): Promise<any> {
  const res = await fetch(`${httpURL}/Bm25TermsSpike`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 180)}: ${text.slice(0, 2000)}`);
  if (json?.error) throw new Error(String(json.error));
  return json;
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(digits);
}

function cellKey(c: { scope: string; band: string; requestedTerms: number }): string {
  return `${c.scope}|${c.band}|${c.requestedTerms}`;
}

interface Gate {
  id: string;
  pass: boolean;
  detail: string;
}

function decide(sizes: any[]): { recommendation: "adopt" | "do-not-adopt" | "inconclusive"; gates: Gate[]; notes: string[] } {
  const at = sizes.find((s) => s.n === 100000 && !s.error);
  if (!at) {
    return {
      recommendation: "inconclusive",
      gates: [{ id: "100k-present", pass: false, detail: "no successful 100k measurement" }],
      notes: ["The decision rule is defined at 100k. Smaller sizes are context only."],
    };
  }
  const base = at.baseline;
  const terms = at.terms;
  const throughputRatio = terms.docsPerSec / base.docsPerSec;
  const latencyRatio = terms.putPlusTokenize.p95 / base.put.p95;
  const gates: Gate[] = [
    {
      id: "ingest-throughput",
      pass: throughputRatio >= 0.8,
      detail: `terms docs/s ${fmt(terms.docsPerSec)} vs baseline ${fmt(base.docsPerSec)} (${fmt((1 - throughputRatio) * 100, 1)}% regression, gate 20%)`,
    },
    {
      id: "ingest-p95",
      pass: latencyRatio <= 1.2,
      detail: `terms put+tokenize p95 ${fmt(terms.putPlusTokenize.p95)}ms vs baseline put p95 ${fmt(base.put.p95)}ms (${fmt(latencyRatio, 2)}×, gate 1.2×)`,
    },
  ];
  const memory = new Map<string, Cell>(at.measure.memory.map((c: Cell) => [cellKey(c), c]));
  let queryFail = 0;
  const queryNotes: string[] = [];
  for (const h of at.measure.harperHybrid as Cell[]) {
    const m = memory.get(cellKey(h));
    if (!m) continue;
    const ratio = h.p95 / m.p95;
    const pass = ratio <= 2;
    if (!pass) queryFail++;
    queryNotes.push(`${h.scope} ${h.band} ${h.requestedTerms}-term p95 ${fmt(h.p95)}ms vs memory ${fmt(m.p95)}ms (${fmt(ratio, 2)}×)`);
    gates.push({
      id: `query-${h.scope}-${h.band}-${h.requestedTerms}`,
      pass,
      detail: queryNotes[queryNotes.length - 1],
    });
  }
  const ingestFail = gates.some((g) => g.id.startsWith("ingest") && !g.pass);
  const recommendation = ingestFail || queryFail > 0 ? "do-not-adopt" : "adopt";
  return {
    recommendation,
    gates,
    notes: [
      "Ingest gate uses wall-clock docs/s and p95 of (Harper put + tokenize) versus today's put of the same row without a terms index. Tokenize is inside the indexed arm because the attribute cannot be written without it; it is also reported separately.",
      "Query gate uses warmed p95. Head queries include the most frequent term. Mid queries sit off the head. Single scope is the dominant agent share from the live profile. Broad scope is the whole corpus.",
      "Stats on the decision query are maintained per-scope N and sum(dl), plus df taken from the posting list the scorer has to read anyway.",
    ],
  };
}

function markdown(report: any): string {
  const lines: string[] = [];
  lines.push("## BM25 Harper indexed-terms spike (flair#2047)");
  lines.push("");
  lines.push(`Recommendation: **${report.decision.recommendation}**.`);
  lines.push("");
  lines.push("Query p95 misses the 2× bar on every cell at 100k. That includes head queries, where the in-memory index is already walking a large posting list (about 6–14×), not only mid queries whose memory p95 is sub-millisecond and whose ratio is mostly fixed search overhead. Ingest here is the lexical row only — content, scope columns, and the terms index — with no embedding. The absolute add at 100k is about a quarter of a millisecond per put. That delta would be a small fraction of an embedding-bound `Memory.put`, but the query gate fails on its own, so the recommendation does not depend on reading the ingest percentage as an end-to-end Memory.put regression.");
  lines.push("");
  lines.push("Decision rule: adopt unless ingest regresses by more than ~20% OR query p95 exceeds ~2× today's warm in-memory index at 100k.");
  lines.push("");
  lines.push("### Environment");
  lines.push("");
  const h = report.host;
  lines.push(`- Host: ${h.cpuModel} × ${h.cpus}, ${fmt(h.totalMem / 1024 ** 3, 1)} GiB RAM, ${h.platform} ${h.release} ${h.arch}`);
  lines.push(`- Harper Node ${h.harperNode}, Harper ${h.harper}. Runner ${h.runner}. Flair git ${h.gitSha}.`);
  lines.push(`- Isolated Harper, THREADS_COUNT=1, no embedding. Puts are one transaction each, sequential.`);
  lines.push(`- Corpus: corpus-v2 token length (mean ${PROFILE.tokenMean.toFixed(2)}, stdev ${PROFILE.tokenStdev.toFixed(2)}, clamp ${PROFILE.tokenMin}–${PROFILE.tokenMax}) and Zipf slope ${PROFILE.zipfSlope}. Vocabulary grows with Heaps beta ${PROFILE.heapsBeta} from the profile's ${PROFILE.vocabTypes} types / ${PROFILE.vocabTokens} tokens. Scope skew is live-flint recordsPerAgentSorted ${JSON.stringify(PROFILE.scopeWeights)} (single = a0, the dominant share).`);
  lines.push("");
  lines.push("### Ingest");
  lines.push("");
  lines.push("| n | arm | docs/s | put p50 ms | put p95 ms | put+tokenize p50 | put+tokenize p95 | mean unique terms |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const s of report.sizes) {
    if (s.error) {
      lines.push(`| ${s.n} | ERROR | | | | | | ${s.error} |`);
      continue;
    }
    for (const arm of [s.baseline, s.terms, s.termsNoAgg, s.termsDf].filter(Boolean)) {
      lines.push(`| ${s.n} | ${arm.arm} | ${fmt(arm.docsPerSec)} | ${fmt(arm.put.p50)} | ${fmt(arm.put.p95)} | ${fmt(arm.putPlusTokenize.p50)} | ${fmt(arm.putPlusTokenize.p95)} | ${fmt(arm.uniqueTerms.mean)} |`);
    }
  }
  lines.push("");
  lines.push("### Query p50 / p95 (ms), warmed");
  lines.push("");
  lines.push("| n | scope | band | terms | memory p50 | memory p95 | harper hybrid p50 | harper hybrid p95 | ratio p95 |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const s of report.sizes) {
    if (s.error || !s.measure) continue;
    const mem = new Map<string, Cell>(s.measure.memory.map((c: Cell) => [cellKey(c), c]));
    for (const h of s.measure.harperHybrid as Cell[]) {
      const m = mem.get(cellKey(h));
      if (!m) continue;
      lines.push(`| ${s.n} | ${h.scope} | ${h.band} | ${h.requestedTerms} | ${fmt(m.p50, 3)} | ${fmt(m.p95, 3)} | ${fmt(h.p50, 3)} | ${fmt(h.p95, 3)} | ${fmt(h.p95 / m.p95)} |`);
    }
  }
  lines.push("");
  lines.push("### Cold build (what adoption removes) and disk");
  lines.push("");
  lines.push("| n | cold build ms | baseline footprint bytes | terms-table bytes | estimated same-row growth bytes | term index entries |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const s of report.sizes) {
    if (s.error) continue;
    lines.push(`| ${s.n} | ${fmt(s.coldBuild.coldBuildMs, 0)} | ${s.disk.baselineFootprint} | ${s.disk.secondTableFootprint} | ${s.disk.estimatedSameRowGrowth} | ${s.terms.termEntries} |`);
  }
  lines.push("");
  lines.push("`estimatedSameRowGrowth` = (du after the terms table) − (du after the baseline table) − (baseline table footprint). The terms table repeats content and the scope columns, so subtracting the baseline footprint estimates the bytes a same-row `terms` index would add. Negative values mean fixed overhead dominated; use the raw du fields in the JSON.");
  lines.push("");
  lines.push("### Per-scope statistics");
  lines.push("");
  lines.push("Three ways df / N / avgdl can come out of Harper, timed separately from the ranking formula:");
  lines.push("");
  lines.push("1. **Hybrid (decision query).** N and sum(dl) are point reads of a per-scope aggregate written in the same transaction as the row. df is the length of the term's posting list, which the scorer reads anyway. Scoped df is therefore not a second pass.");
  lines.push("2. **Scope scan.** N and avgdl come from walking every row in the scope (`docLen` only) on each query. df still comes from postings. See `harperScopeScan` in the JSON.");
  lines.push("3. **Global index count.** `terms` index `getValuesCount(term)` counts index entries for one token. It is global df, not scoped df, so it is the wrong idf for a single-agent query. At n=50 it was ~0.01ms; at 100k, df(t1)=24906, it was ~3.8ms p50. Cost is `globalDfCount`.");
  lines.push("4. **Maintained per-(scope, term) df.** Extra counter rows, one per unique term per scope plus a global counter. Ingest cost is the `terms-df` arm (1k and 10k). Query cost is two point reads (`dfProbe`).");
  lines.push("");
  lines.push("### Ranking equivalence");
  lines.push("");
  for (const s of report.sizes) {
    if (s.error || !s.equivalence) continue;
    lines.push(`- n=${s.n}: ${s.equivalence.matched}/${s.equivalence.total} query/scope cells bit-identical on top-${s.measure.limit} scores; memory-index id match ${s.equivalence.idMatched}/${s.equivalence.total}.`);
    if (s.equivalence.failures.length) {
      for (const f of s.equivalence.failures.slice(0, 6)) lines.push(`  - ${f.label}: mismatches=${f.mismatches} expectedN=${f.expectedN} gotN=${f.gotN} expectedDf=${JSON.stringify(f.expectedDf)} gotDf=${JSON.stringify(f.gotDf)}`);
    }
  }
  lines.push("");
  lines.push("### Federation");
  lines.push("");
  lines.push("Store `terms` on the memory row and let it replicate with the row. Harper builds the secondary index locally from the replicated values, so the receiver does not re-tokenize. Recomputing on receive would duplicate that index build and would drift if `tokenize()` ever diverged between peers. The attribute is a pure function of `content`, but the durable copy is the one written in the author's transaction.");
  lines.push("");
  lines.push("### Gates");
  lines.push("");
  for (const g of report.decision.gates) lines.push(`- ${g.pass ? "PASS" : "FAIL"} \`${g.id}\`: ${g.detail}`);
  lines.push("");
  for (const n of report.decision.notes) lines.push(n);
  lines.push("");
  return lines.join("\n");
}

async function buildResource(): Promise<void> {
  const outfile = join(HERE, "resources", "Bm25TermsSpike.js");
  const proc = spawn(process.execPath, [
    "build", join(HERE, "src", "resource.ts"),
    "--outfile", outfile,
    "--target", "node",
    "--format", "esm",
    "--external", "harper",
  ], { cwd: REPO, stdio: "inherit" });
  const code = await new Promise<number>((resolve, reject) => {
    proc.on("exit", (c) => resolve(c ?? 1));
    proc.on("error", reject);
  });
  if (code !== 0) throw new Error(`bun build exited ${code}`);
}

async function runSize(n: number, seed: number, reps: number, extras: boolean): Promise<any> {
  const logPath = join(tmpdir(), `bm25-spike-${n}.log`);
  writeFileSync(logPath, "");
  console.log(`\n=== n=${n} ===`);
  const harper = await startHarper(logPath);
  try {
    const health = await call(harper.httpURL, { op: "health" });
    console.log("health", JSON.stringify(health));
    const emptyBytes = du(harper.root);
    const baseline = await call(harper.httpURL, { op: "ingest", arm: "baseline", n, seed });
    const afterBaseline = du(harper.root);
    const coldBuild = await call(harper.httpURL, { op: "coldBuild" });
    const terms = await call(harper.httpURL, { op: "ingest", arm: "terms", n, seed });
    const afterTerms = du(harper.root);
    const measure = await call(harper.httpURL, { op: "measure", n, seed, reps, warmup: 2, limit: 50 });
    let termsNoAgg = null;
    let termsDf = null;
    let dfProbe = null;
    if (extras) {
      termsNoAgg = await call(harper.httpURL, { op: "ingest", arm: "terms-noagg", n, seed });
      termsDf = await call(harper.httpURL, { op: "ingest", arm: "terms-df", n, seed });
      dfProbe = await call(harper.httpURL, { op: "dfProbe", reps: Math.max(reps, 20) });
    }
    const failures = (measure.equivalence as any[]).filter((e) => !e.match || !e.memoryIndexIdMatch);
    const baselineFootprint = afterBaseline - emptyBytes;
    const secondTableFootprint = afterTerms - afterBaseline;
    return {
      n,
      logPath,
      health,
      baseline,
      terms,
      termsNoAgg,
      termsDf,
      coldBuild,
      measure,
      dfProbe,
      disk: {
        emptyBytes,
        afterBaseline,
        afterTerms,
        baselineFootprint,
        secondTableFootprint,
        estimatedSameRowGrowth: secondTableFootprint - baselineFootprint,
        contentBytes: terms.contentBytes,
        tfBytes: terms.tfBytes,
        termEntries: terms.termEntries,
      },
      equivalence: {
        total: measure.equivalence.length,
        matched: measure.equivalence.filter((e: any) => e.match).length,
        idMatched: measure.equivalence.filter((e: any) => e.memoryIndexIdMatch).length,
        failures,
      },
    };
  } finally {
    stop(harper.proc);
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(harper.root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function main(): Promise<void> {
  const sizes = arg("--sizes", "1000,10000,100000").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  const seed = Number(arg("--seed", "2047"));
  const repsOverride = Number(arg("--reps", "0"));
  const extrasMax = Number(arg("--extras-max", "10000"));
  const out = arg("--out", join(HERE, "results", "spike-2047.json"));
  console.log(`node ${NODE}`);
  console.log("profile check");
  assertProfile();
  console.log("oracle self-check");
  assertOracleMatchesShipped(seed);
  console.log("bundle resource");
  await buildResource();

  const harperPkg = JSON.parse(readFileSync(join(REPO, "node_modules/harper/package.json"), "utf8"));
  const host = {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    totalMem: os.totalmem(),
    freeMemAtStart: os.freemem(),
    harperNode: execFileSync(NODE, ["-v"], { encoding: "utf8" }).trim(),
    runner: `${process.execPath} ${process.version}`,
    harper: harperPkg.version,
    gitSha: gitSha(),
    threads: 1,
    seed,
  };
  const results: any[] = [];
  mkdirSync(dirname(out), { recursive: true });
  for (const n of sizes) {
    const reps = repsOverride > 0 ? repsOverride : (n >= 100000 ? 8 : n >= 10000 ? 12 : 20);
    try {
      results.push(await runSize(n, seed, reps, n <= extrasMax));
    } catch (err: any) {
      console.error(`n=${n} failed`, err?.stack || err);
      results.push({ n, error: String(err?.stack || err) });
    }
    const partial = { host, sizes: results, decision: decide(results) };
    writeFileSync(out, JSON.stringify(partial, null, 2));
    writeFileSync(out.replace(/\.json$/, ".md"), markdown(partial));
  }
  const report = { host, profile: PROFILE, sizes: results, decision: decide(results) };
  writeFileSync(out, JSON.stringify(report, null, 2));
  const mdPath = out.replace(/\.json$/, ".md");
  writeFileSync(mdPath, markdown(report));
  console.log(`\nrecommendation: ${report.decision.recommendation}`);
  console.log(`wrote ${out}`);
  console.log(`wrote ${mdPath}`);
  process.exit(results.some((s) => s.error) ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
