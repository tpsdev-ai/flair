/**
 * S1 parity: HFE vs the in-tree engine on recall-eval corpus v2.
 *
 * The two native llama.cpp builds cannot share a process (the second
 * loader finds no ggml backend). Each engine runs in its own child.
 *
 * Usage (model already verified on disk):
 *   bun test/bench/embeddings-flair-parity.ts
 *
 * Prints min cosine, short-input differences, and exits non-zero when token
 * counts differ, a 64+ token cosine is below 0.999, or any query's top-3 differs.
 *
 * llama.cpp's CPU kernels are not stable across a long run (HFE against
 * itself misses 0.999 on some inputs). Token counts are the stable check.
 * FLAIR_PARITY_THREADS defaults to 2. FLAIR_PARITY_LIMIT slices the corpus.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS, QUERIES } from "./recall-harness/corpus-v2.ts";
import { ensureBuiltinModelFile } from "../../resources/embeddings/fetch.ts";
import { BUILTIN_EMBEDDING_MODEL } from "../../resources/embeddings/models.ts";

const MODEL_DIR = process.env.FLAIR_MODELS_DIR ?? join(process.cwd(), "models");
const THREADS = positiveInt(process.env.FLAIR_PARITY_THREADS) ?? 2;
const MIN_COSINE = 0.999;
const LONG_TOKENS = 64;
const CHILD_TIMEOUT_MS = 180_000;
const SCRIPT = fileURLToPath(import.meta.url);

interface Item {
  id: string;
  text: string;
  kind: "document" | "query";
}

interface Embedded {
  id: string;
  kind: "document" | "query";
  tokens: number;
  vector: number[];
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

function inputs(): Item[] {
  // expectMarker repeats across query kinds. Index keeps each input distinct.
  const rows = [
    ...CORPUS.map((row, index) => ({ id: `d:${index}:${row.marker}`, text: row.text, kind: "document" as const })),
    ...QUERIES.map((row, index) => ({ id: `q:${index}:${row.expectMarker}`, text: row.q, kind: "query" as const })),
  ];
  const limit = Number(process.env.FLAIR_PARITY_LIMIT);
  if (Number.isInteger(limit) && limit > 0) return rows.slice(0, limit);
  return rows;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

async function embedHfe(modelPath: string, texts: readonly Item[]): Promise<Embedded[]> {
  const { EmbeddingEngine } = await import("harper-fabric-embeddings");
  const engine = new EmbeddingEngine({
    modelPath,
    pooling: "mean",
    threads: THREADS,
    gpuLayers: 0,
  });
  try {
    const out: Embedded[] = [];
    for (const item of texts) {
      const { vectors, tokens } = await engine.embedMany([item.text], { inputType: item.kind });
      const vector = vectors[0];
      if (!vector) throw new Error(`HFE returned no vector for ${item.id}`);
      out.push({ id: item.id, kind: item.kind, tokens, vector: Array.from(vector) });
    }
    return out;
  } finally {
    await engine.dispose();
  }
}

async function embedFlair(modelPath: string, texts: readonly Item[]): Promise<Embedded[]> {
  const { createFlairEmbeddingEngine } = await import("../../resources/embeddings/engine.ts");
  const engine = createFlairEmbeddingEngine({ modelPath, threads: THREADS, gpuLayers: 0 });
  try {
    const out: Embedded[] = [];
    for (const item of texts) {
      const { vectors, tokens } = await engine.embedMany([item.text], { inputType: item.kind });
      const vector = vectors[0];
      if (!vector) throw new Error(`flair returned no vector for ${item.id}`);
      out.push({ id: item.id, kind: item.kind, tokens, vector: Array.from(vector) });
    }
    return out;
  } finally {
    await engine.dispose();
  }
}

async function runChild(role: "hfe" | "flair", outPath: string): Promise<void> {
  const modelPath = await ensureBuiltinModelFile(MODEL_DIR, {
    download: async () => {
      throw new Error(`refusing to download; expected ${BUILTIN_EMBEDDING_MODEL.file} in ${MODEL_DIR}`);
    },
  });
  const rows = role === "hfe" ? await embedHfe(modelPath, inputs()) : await embedFlair(modelPath, inputs());
  writeFileSync(outPath, JSON.stringify(rows));
}

function spawnChild(role: "hfe" | "flair", outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        FLAIR_PARITY_ROLE: role,
        FLAIR_PARITY_OUT: outPath,
      },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: CHILD_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${role} parity child exited code=${code} signal=${signal ?? "none"}`));
    });
  });
}

function readRows(path: string): Embedded[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path} is not an embedding array`);
  return parsed as Embedded[];
}

function top3(query: Embedded, docs: readonly Embedded[]): string[] {
  return docs
    .map((doc) => ({ id: doc.id, score: cosine(query.vector, doc.vector) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((row) => row.id);
}

async function compare(hfePath: string, flairPath: string): Promise<void> {
  const hfe = readRows(hfePath);
  const flair = readRows(flairPath);
  const byId = new Map(flair.map((row) => [row.id, row]));
  let minCosine = 1;
  let minLong = 1;
  const tokenMismatches: string[] = [];
  const longFailures: { id: string; tokens: number; cosine: number }[] = [];
  const shortDiffs: { id: string; tokens: number; cosine: number }[] = [];

  for (const row of hfe) {
    const other = byId.get(row.id);
    if (!other) {
      tokenMismatches.push(`${row.id}: missing flair row`);
      continue;
    }
    if (row.tokens !== other.tokens) tokenMismatches.push(`${row.id}: hfe ${row.tokens} flair ${other.tokens}`);
    const score = cosine(row.vector, other.vector);
    if (score < minCosine) minCosine = score;
    if (row.tokens >= LONG_TOKENS) {
      if (score < minLong) minLong = score;
      if (score < MIN_COSINE) longFailures.push({ id: row.id, tokens: row.tokens, cosine: score });
    } else if (score < MIN_COSINE) {
      shortDiffs.push({ id: row.id, tokens: row.tokens, cosine: score });
    }
  }

  const hfeDocs = hfe.filter((row) => row.kind === "document");
  const flairDocs = flair.filter((row) => row.kind === "document");
  const top3Diffs: { id: string; hfe: string[]; flair: string[] }[] = [];
  for (const query of hfe.filter((row) => row.kind === "query")) {
    const other = byId.get(query.id);
    if (!other) continue;
    const a = top3(query, hfeDocs);
    const b = top3(other, flairDocs);
    if (a.join("|") !== b.join("|")) top3Diffs.push({ id: query.id, hfe: a, flair: b });
  }

  const report = {
    records: CORPUS.length,
    queries: QUERIES.length,
    inputs: inputs().length,
    threads: THREADS,
    minCosine,
    minCosineAtLeast64Tokens: minLong,
    tokenMismatches: tokenMismatches.length,
    tokenMismatchSample: tokenMismatches.slice(0, 8),
    longFailures: longFailures.length,
    longFailureSample: longFailures.slice(0, 8),
    shortDifferences: shortDiffs.length,
    shortDifferenceSample: shortDiffs.slice(0, 12),
    top3Diffs: top3Diffs.length,
    top3DiffSample: top3Diffs.slice(0, 8),
  };

  const outPath = process.env.FLAIR_PARITY_REPORT ?? "/tmp/embeddings-flair-parity.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`[parity] wrote ${outPath}`);

  if (tokenMismatches.length || longFailures.length || top3Diffs.length) process.exit(1);
}

const role = process.env.FLAIR_PARITY_ROLE;
if (role === "hfe" || role === "flair") {
  const out = process.env.FLAIR_PARITY_OUT;
  if (!out) throw new Error("FLAIR_PARITY_OUT is required for a parity child");
  await runChild(role, out);
} else {
  const dir = mkdtempSync(join(tmpdir(), "flair-parity-"));
  console.log(`[parity] scratch ${dir}`);
  const hfePath = join(dir, "hfe.json");
  const flairPath = join(dir, "flair.json");
  console.log(`[parity] corpus records=${CORPUS.length} queries=${QUERIES.length} inputs=${inputs().length}`);
  console.log("[parity] embedding with HFE");
  await spawnChild("hfe", hfePath);
  console.log("[parity] embedding with flair");
  await spawnChild("flair", flairPath);
  await compare(hfePath, flairPath);
}
