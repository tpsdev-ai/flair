/**
 * format.ts — rendering layer. Takes structured results (index.ts's return
 * types) and produces strings; never calls process.exit or writes anywhere
 * itself. cli.ts is the only place that actually console.logs these
 * strings — keeping this module pure text-in/text-out means a library
 * consumer (see index.ts's header) can call these directly or write its
 * own renderer against the same BatchResult/RecommendResult shapes.
 */

import type { BatchResult, ModelBenchResult, RecommendResult } from "./types.js";

function fmt(n: number, d = 3): string {
  return n.toFixed(d);
}

function miB(n: number): string {
  return `${n.toFixed(1)} MiB`;
}

function modelLine(m: ModelBenchResult): string {
  return (
    `${m.model.fileName}\n` +
    `  quant=${m.model.quant} (${m.model.quantSource})  dims=${m.model.dims}  size=${(m.model.sizeBytes / (1024 * 1024)).toFixed(1)} MiB  ` +
    `bpw=${fmt(m.model.bpw, 2)}  params~${(m.model.paramsApprox / 1e6).toFixed(1)}M\n` +
    `  sha256=${m.model.sha256}\n` +
    `  load=${fmt(m.loadTimeMs, 1)}ms  embed=${fmt(m.msPerEmbedSerialWarm, 2)}ms/ea (serial, warm)  peak-rss-delta=${miB(m.peakRssDeltaMiB)}\n` +
    `  aggregate: p@3=${fmt(m.aggregate.p3)}  MRR=${fmt(m.aggregate.mrr)}  (n=${m.aggregate.n})\n` +
    `  by kind:   ` +
    (["stress", "trap", "hard", "clean"] as const)
      .map((k) => `${k}=${fmt(m.perKind[k].mrr)}(n=${m.perKind[k].n})`)
      .join("  ")
  );
}

export function formatPretty(result: BatchResult): string {
  const lines: string[] = [];
  lines.push(`flair-bench ${result.toolVersion} — ${result.timestamp}`);
  lines.push(`corpus: v2 (${result.corpus.records} records, ${result.corpus.queries} queries)`);
  const label = result.host.label ? ` [${result.host.label}]` : "";
  lines.push(
    `host${label}: ${result.host.platform}/${result.host.arch}  ${result.host.cpuModel}  ` +
      `${result.host.totalRamGiB.toFixed(1)}GiB total / ${result.host.availableRamGiB.toFixed(1)}GiB available  ` +
      `backend=${result.host.backend}${result.host.gpuDeviceNames.length ? ` gpu=${result.host.gpuDeviceNames.join(", ")}` : ""}`,
  );
  lines.push("");
  for (const m of result.models) {
    lines.push(modelLine(m));
    lines.push("");
  }

  if (result.models.length > 1) {
    lines.push("── ranked comparison (by MRR) ──");
    const ranked = [...result.models].sort((a, b) => b.aggregate.mrr - a.aggregate.mrr);
    for (const m of ranked) {
      lines.push(
        `  ${m.model.fileName.padEnd(40)} p@3=${fmt(m.aggregate.p3)}  MRR=${fmt(m.aggregate.mrr)}  ` +
          `${fmt(m.msPerEmbedSerialWarm, 1)}ms/embed  ${miB(m.peakRssDeltaMiB)}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatJson(result: BatchResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatRecommendPretty(result: RecommendResult): string {
  const lines = [formatPretty(result.batch), "── recommendation ──"];
  if (result.recommendation) {
    lines.push(result.recommendation.reason);
  } else {
    lines.push("(no recommendation — see notes below)");
  }
  lines.push("");
  for (const note of result.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}

export function formatRecommendJson(result: RecommendResult): string {
  return JSON.stringify(result, null, 2);
}
