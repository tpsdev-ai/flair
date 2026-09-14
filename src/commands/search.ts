/**
 * search.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair search` top-level shortcut plus the `--explain` score-breakdown helpers (flair#992).
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { buildEd25519Auth, resolveKeyPath } from "../lib/auth-resolve.js";
import * as render from "../render.js";
import { join } from "node:path";

export type SearchCli = {
  resolveBaseUrl: (...args: any[]) => any;
  resolveSigningAgentId: (...args: any[]) => any;
};

let cli: SearchCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: SearchCli): void {
  cli = fns;
}

function resolveBaseUrl(...args: any[]): any {
  return cli.resolveBaseUrl(...args);
}

function resolveSigningAgentId(...args: any[]): any {
  return cli.resolveSigningAgentId(...args);
}

function parseRelativeOrIso(input: string | undefined): string | null {
  if (!input) return null;
  const m = input.match(/^(\d+)([smhdw])$/);
  if (!m) return input;
  const n = Number.parseInt(m[1], 10);
  const unit = m[2];
  const multMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return new Date(Date.now() - n * (multMs[unit] ?? 0)).toISOString();
}

// ─── --explain score breakdown (flair#992) ───────────────────────────────────
//
// One builder feeds BOTH output modes. Before #992 the breakdown was assembled
// inline inside the human-rendering branch, which sits after an early `return`
// on json mode — and non-TTY stdout resolves to json mode (render.ts
// resolveOutputMode). So `--explain` was inert for every script, agent, CI job
// and pipe, with no error. Sharing one builder is what keeps the two modes from
// drifting apart again.
//
// What this can and cannot report:
//
//   - It reports what the SERVER sent. `--explain` is client-side: the
//     /SemanticSearch request carries no `explain` key and the resource has no
//     such parameter, so the durability WEIGHT, recency DECAY and usage BOOST
//     that compositeScore() multiplies are not available here.
//   - It deliberately does NOT recompute those weights client-side. They depend
//     on floors read from the SERVER's environment
//     (FLAIR_COMPOSITE_RELEVANCE_FLOOR / FLAIR_COMPOSITE_DISCOUNT_FLOOR), so a
//     client-side recomputation would print confident numbers the ranking never
//     used. Reporting the ranking INPUTS the server returned on the record is
//     honest; inventing the weights is not.
//   - Under `--scoring raw` the server puts the raw score in `_score` and omits
//     `_rawScore`. Labelling `_score` "composite" in that mode — as the pre-#992
//     block did — mislabels a raw score.
//   - retrievalCount is NOT reported. flair#683 replaced retrievalBoost with
//     usageBoost outright; retrievalCount no longer participates in the score,
//     and a breakdown must not name a term the ranking stopped using.

export type SearchScoringMode = "raw" | "composite";


export type SearchExplain = {
  scoring: SearchScoringMode;
  formula: string;
  raw?: number;
  composite?: number;
  durability: string;
  ageDays?: number;
  usageCount: number;
};


export function searchScoringFormula(scoring: SearchScoringMode): string {
  return scoring === "composite"
    ? "semantic × durability-weight × recency-decay × usage-boost"
    : "cosine similarity only";
}


export function buildSearchExplain(record: any, scoring: SearchScoringMode, now: number = Date.now()): SearchExplain {
  const score = typeof record?._score === "number" ? record._score : undefined;
  const rawScore = typeof record?._rawScore === "number" ? record._rawScore : undefined;

  // composite mode: server sends both (_rawScore = pre-composite semantic).
  // raw mode: server sends only _score, and that IS the raw score.
  const raw = scoring === "composite" ? rawScore : score;
  const composite = scoring === "composite" ? score : undefined;

  let ageDays: number | undefined;
  if (record?.createdAt) {
    const created = new Date(String(record.createdAt)).getTime();
    if (Number.isFinite(created)) ageDays = Math.max(0, Math.floor((now - created) / 86_400_000));
  }

  const explain: SearchExplain = {
    scoring,
    formula: searchScoringFormula(scoring),
    durability: record?.durability ?? "standard",
    usageCount: typeof record?.usageCount === "number" ? record.usageCount : 0,
  };
  if (typeof raw === "number") explain.raw = raw;
  if (typeof composite === "number") explain.composite = composite;
  if (typeof ageDays === "number") explain.ageDays = ageDays;
  return explain;
}

// Human one-liner for a hit's breakdown. Scoring terms come from the shared
// builder; the trailing tags/subject/supersedes are record context that json
// mode already carries at top level, so they're appended here only.

export function formatSearchExplain(explain: SearchExplain, record: any): string {
  const parts: string[] = [];
  if (typeof explain.raw === "number") parts.push(`raw=${explain.raw.toFixed(3)}`);
  if (typeof explain.composite === "number") parts.push(`composite=${explain.composite.toFixed(3)}`);
  parts.push(`durability=${explain.durability}`);
  if (typeof explain.ageDays === "number") parts.push(`age=${explain.ageDays}d`);
  parts.push(`usage=${explain.usageCount}`);
  if (Array.isArray(record?.tags) && record.tags.length > 0) parts.push(`tags=[${record.tags.join(",")}]`);
  if (record?.subject) parts.push(`subject=${record.subject}`);
  if (record?.supersedes) parts.push(`supersedes=${record.supersedes}`);
  return parts.join(" · ");
}


export function register(program: Command): void {
// ─── flair search (top-level shortcut) ───────────────────────────────────────

// Parse --since / --as-of: accept ISO 8601 OR relative expressions
// ("1h", "7d", "30m"). Returns ISO 8601 string or null if input is empty.
// Returns the original string unchanged if it looks like a date (caller
// passes through to server, which validates).

program
  .command("search <query>")
  .description("Search memories by meaning (shortcut for memory search) — filterable, with --explain ranking")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--limit <n>", "Max results", "5")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
  .option("--key <path>", "Ed25519 private key path")
  // Server-side filters (forwarded to /SemanticSearch payload)
  .option("--tag <tag>", "Filter to memories carrying this tag")
  .option("--subject <subject>", "Filter to memories carrying this subject (case-insensitive)")
  .option("--subjects <list>", "Comma-separated list of subjects to OR-filter (case-insensitive)")
  .option("--since <iso-or-relative>", "Only memories created after this point (ISO 8601 or '7d'/'24h'/'30m')")
  .option("--as-of <iso>", "Temporal validity: only memories valid at this point (ISO 8601)")
  .option("--include-superseded", "Include memories that have been superseded")
  .option("--scoring <mode>", "Scoring mode: raw (default) uses cosine similarity/BM25 only; composite re-ranks by durability/recency/retrieval (measurably hurts precision as of flair#623 — opt-in only)", "raw")
  .option("--min-score <n>", "Drop results below this score (0..1)", "0")
  // Client-side filters (applied after server response)
  .option("--durability <level>", "Filter to permanent|persistent|standard|ephemeral (client-side)")
  .option("--source <name>", "Filter by source/agentId (client-side)")
  // Output modes
  .option("--explain", "Show score breakdown (raw, composite, durability, age, usage) per hit — also added to --json output as _explain")
  .option("--json", "Output raw JSON array")
  .action(async (query, opts) => {
    try {
      const { agentId } = resolveSigningAgentId(opts, "search");
      if (!agentId) {
        console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
        process.exit(2);
      }
      const baseUrl = resolveBaseUrl(opts);
      const headers: Record<string, string> = { "content-type": "application/json" };
      const keyPath = opts.key || resolveKeyPath(agentId);
      if (keyPath) {
        headers["authorization"] = buildEd25519Auth(agentId, "POST", "/SemanticSearch", keyPath);
      }

      // Build payload from CLI options. Server validates types.
      const payload: Record<string, any> = {
        agentId,
        q: query,
        limit: Number.parseInt(opts.limit, 10) || 5,
        scoring: opts.scoring === "composite" ? "composite" : "raw",
      };
      if (opts.tag) payload.tag = opts.tag;
      if (opts.subject) payload.subject = opts.subject;
      if (opts.subjects) payload.subjects = String(opts.subjects).split(",").map((s) => s.trim()).filter(Boolean);
      const since = parseRelativeOrIso(opts.since);
      if (since) payload.since = since;
      if (opts.asOf) payload.asOf = opts.asOf;
      if (opts.includeSuperseded) payload.includeSuperseded = true;
      const minScore = Number.parseFloat(opts.minScore ?? "0");
      if (Number.isFinite(minScore) && minScore > 0) payload.minScore = minScore;

      const res = await fetch(`${baseUrl}/SemanticSearch`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const result = (await res.json()) as any;
      let results: any[] = result.results || result || [];
      if (!Array.isArray(results)) results = [];

      // Client-side filters: durability + source. Server doesn't expose these
      // as conditions, so we filter after fetch.
      if (opts.durability) {
        const allowed = new Set(String(opts.durability).split(",").map((d) => d.trim()));
        results = results.filter((r) => allowed.has(r.durability ?? "standard"));
      }
      if (opts.source) {
        const allowed = new Set(String(opts.source).split(",").map((s) => s.trim()));
        results = results.filter((r) => allowed.has(r._source ?? r.agentId ?? ""));
      }

      const mode = render.resolveOutputMode(opts);
      const scoringMode: SearchScoringMode = payload.scoring === "composite" ? "composite" : "raw";
      if (mode === "json") {
        // flair#992: --explain must be honoured here, not silently dropped.
        // This branch is what every non-TTY caller lands in. The breakdown
        // rides ALONG the json contract as an opt-in `_explain` key — present
        // only when the caller typed --explain, so default output is unchanged
        // — rather than switching output mode behind the caller's back.
        const out = opts.explain
          ? results.map((r) => ({ ...r, _explain: buildSearchExplain(r, scoringMode) }))
          : results;
        console.log(render.asJSON(out));
        return;
      }

      if (results.length === 0) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "No results found.")}`);
        const filters: string[] = [];
        if (opts.tag) filters.push(`tag=${opts.tag}`);
        if (opts.subject) filters.push(`subject=${opts.subject}`);
        if (opts.subjects) filters.push(`subjects=${opts.subjects}`);
        if (opts.since) filters.push(`since=${opts.since}`);
        if (opts.durability) filters.push(`durability=${opts.durability}`);
        if (opts.source) filters.push(`source=${opts.source}`);
        if (filters.length > 0) {
          console.log(`  ${render.wrap(render.c.dim, "Filters:")} ${filters.join(render.wrap(render.c.dim, " · "))}`);
          console.log(
            `  ${render.icons.arrow} ${render.wrap(render.c.dim, "Try removing a filter or:")} flair search "${query}" --agent ${agentId}`,
          );
        }
        return;
      }

      const durabilityColor = (d: string): string => {
        if (d === "permanent") return render.c.magenta;
        if (d === "persistent") return render.c.blue;
        if (d === "ephemeral") return render.c.gray;
        return render.c.cyan;
      };

      for (const r of results) {
        const date = r.createdAt ? String(r.createdAt).slice(0, 10) : "";
        const scoreVal = typeof r._score === "number" ? r._score : 0;
        const scorePct = typeof r._score === "number" ? `${(scoreVal * 100).toFixed(0)}%` : "";
        const scoreColor = scoreVal >= 0.7 ? render.c.green : scoreVal >= 0.4 ? render.c.yellow : render.c.dim;
        const durability = r.durability ?? "standard";
        const metaParts: string[] = [];
        if (date) metaParts.push(render.wrap(render.c.dim, date));
        metaParts.push(render.wrap(durabilityColor(durability), durability));
        if (scorePct) metaParts.push(render.wrap(scoreColor, scorePct));
        if (r._source) metaParts.push(render.wrap(render.c.cyan, `from:${r._source}`));
        const meta = metaParts.join(render.wrap(render.c.dim, " · "));
        console.log(`  ${r.content}`);
        if (meta) console.log(`  ${render.wrap(render.c.dim, "(")} ${meta} ${render.wrap(render.c.dim, ")")}`);
        if (opts.explain) {
          const line = formatSearchExplain(buildSearchExplain(r, scoringMode), r);
          if (line) {
            console.log(`    ${render.wrap(render.c.gray, "└─")} ${render.wrap(render.c.dim, line)}`);
          }
        }
        console.log();
      }

      if (opts.explain) {
        console.log(
          `${render.wrap(render.c.dim, "Scoring:")} ${render.wrap(render.c.bold, scoringMode)}  ${render.wrap(render.c.dim, `(${searchScoringFormula(scoringMode)})`)}`,
        );
      }
    } catch (err: any) {
      console.error(`${render.icons.error} Search failed: ${err.message}`);
      process.exit(1);
    }
  });

}
