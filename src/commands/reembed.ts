/**
 * reembed.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { authFetch, defaultKeysDir, resolveAdminUser } from "../lib/auth-resolve.js";
import { encodeRecordId } from "../lib/record-id-path.js";
import {
  MEMORY_REEMBED_PATCH_CAPABILITY,
  healthVersion,
  parseHealthCapabilities,
  reembedUnsupportedMessage,
  reembedUnverifiedMessage,
} from "../lib/reembed-server-support.js";
import { existsSync } from "node:fs";

export type ReembedCli = {
  privKeyPath: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
  resolveOpsPort: (...args: any[]) => any;
};

let cli: ReembedCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: ReembedCli): void {
  cli = fns;
}

function privKeyPath(...args: any[]): any {
  return cli.privKeyPath(...args);
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

function resolveOpsPort(...args: any[]): any {
  return cli.resolveOpsPort(...args);
}

/**
 * flair#2561: reads the `embeddingModel` stored on Memory row `id`, resolving
 * undefined when the response carries no stamp for that row, and throwing when
 * the read request or its JSON fails, so a failed read is not reported as a
 * missing stamp. `flair reembed` reads the stamp from the stored row after each
 * re-embed PATCH, because the PATCH response carries no embedding field.
 */
export type StoredModelReader = (id: string) => Promise<unknown>;

/**
 * A StoredModelReader over the Harper operations API with the administrator
 * credentials `flair reembed` lists the rows with: `search_by_id` for the row's
 * `id` and `embeddingModel` only.
 */
export function opsStoredModelReader(opsPort: string | number, opsAuth: string): StoredModelReader {
  return async (id) => {
    const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: opsAuth },
      body: JSON.stringify({
        operation: "search_by_id",
        database: "flair",
        table: "Memory",
        ids: [id],
        get_attributes: ["id", "embeddingModel"],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows: unknown = await res.json();
    const row = Array.isArray(rows) ? rows.find((r) => (r as { id?: unknown } | null)?.id === id) : undefined;
    return (row as { embeddingModel?: unknown } | undefined)?.embeddingModel;
  };
}

/**
 * Rows per `search_by_conditions` page when reading Memory for a re-embed.
 * Passed as `readAllMemoryRows`'s `pageSize` so tests can use a small page.
 */
export const REEMBED_READ_PAGE_SIZE = 1000;

/** Row limit of the single keyless `POST /SemanticSearch` listing. */
export const KEYLESS_SEARCH_LIMIT = 10_000;

/** One line naming what the keyless listing read and the remedy. */
export function keylessTruncationNotice(read: number): string {
  return `⚠️ Read ${read} memories via /SemanticSearch; more rows may exist. Set FLAIR_ADMIN_PASS so reembed reads through the operations API.`;
}

/**
 * Default and largest page cap for the keyset loop: 10,000 pages. The CLI reads
 * pages of REEMBED_READ_PAGE_SIZE (1,000) rows; a caller may pass a smaller
 * `maxPages` and any positive whole `pageSize`. The read refuses when page
 * `maxPages` holds at least `pageSize` rows, because more rows may follow; a
 * shorter page at that bound is a complete read.
 */
const MAX_MEMORY_READ_PAGES = 10_000;

export type MemoryReadCondition = {
  search_attribute: string;
  search_type: string;
  search_value: unknown;
};

export type MemoryRowPageRead = {
  rows: Record<string, unknown>[];
  pages: number;
};

/**
 * Read the Memory rows matching `conditions`, one page at a time (flair#3086).
 * Keyset paging on the primary key: from the second page on, each page asks for
 * rows whose `id` is greater than the last id seen, sorted by `id`, so a row
 * inserted or deleted between pages does not shift the rows after it or repeat
 * one already read.
 *
 * Harper's operations API forwards `limit`, `offset` and `sort` to Table.search
 * (node_modules/harper/dataLayer/harperBridge/ResourceBridge.ts:109-113); the
 * conditions search accepts `sort: { attribute, descending }`
 * (node_modules/harper/validation/searchValidator.ts:38-48); a primary-key
 * sort scans the primary store in key order
 * (node_modules/harper/resources/Table.ts:5919-5921). A page that is not an
 * array of rows with a non-empty string `id`, a non-empty string `agentId` and
 * a string `content`, or whose ids do not strictly increase, throws, so an
 * error object or a malformed page does not read as an empty result. The whole
 * read finishes before the first re-embed write, and it refuses when page
 * `maxPages` (default MAX_MEMORY_READ_PAGES) holds at least `pageSize` rows.
 */
export async function readAllMemoryRows(opts: {
  opsPort: string | number;
  opsAuth: string;
  conditions: MemoryReadCondition[];
  pageSize?: number;
  /**
   * Pages the read may request: a whole number from 1 to MAX_MEMORY_READ_PAGES,
   * which lowers the bound and never raises it (anything else throws before the
   * first request). Callers other than tests use the default.
   */
  maxPages?: number;
}): Promise<MemoryRowPageRead> {
  const pageSize = opts.pageSize ?? REEMBED_READ_PAGE_SIZE;
  const maxPages = opts.maxPages ?? MAX_MEMORY_READ_PAGES;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`invalid page size ${pageSize}`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_MEMORY_READ_PAGES) {
    throw new Error(`invalid page cap ${maxPages}: must be a whole number from 1 to ${MAX_MEMORY_READ_PAGES}`);
  }
  const rows: Record<string, unknown>[] = [];
  let lastId: string | undefined;
  let pages = 0;
  while (pages < maxPages) {
    pages++;
    const conditions: MemoryReadCondition[] = [...opts.conditions];
    if (lastId !== undefined) {
      conditions.push({ search_attribute: "id", search_type: "greater_than", search_value: lastId });
    }
    const res = await fetch(`http://127.0.0.1:${opts.opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: opts.opsAuth },
      body: JSON.stringify({
        operation: "search_by_conditions",
        database: "flair",
        table: "Memory",
        operator: "and",
        conditions,
        sort: { attribute: "id" },
        // Not "*": every page would carry every row's embedding vector.
        get_attributes: ["id", "agentId", "content", "embeddingModel"],
        limit: pageSize,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json() as unknown;
    const page = Array.isArray(raw)
      ? raw
      : raw !== null && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : null;
    if (page === null) {
      throw new Error(`page ${pages}: response is neither an array nor an object with a results array`);
    }
    const seen: Record<string, unknown>[] = [];
    for (const row of page) {
      const id = (row as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(`page ${pages}: row without a non-empty string id`);
      }
      const rowAgentId = (row as { agentId?: unknown } | null)?.agentId;
      if (typeof rowAgentId !== "string" || rowAgentId.length === 0) {
        throw new Error(`page ${pages}: row without a non-empty string agentId`);
      }
      if (typeof (row as { content?: unknown } | null)?.content !== "string") {
        throw new Error(`page ${pages}: row without a string content`);
      }
      if (lastId !== undefined && Buffer.compare(Buffer.from(id), Buffer.from(lastId)) <= 0) {
        throw new Error(`page ${pages}: ids do not strictly increase`);
      }
      lastId = id;
      seen.push(row as Record<string, unknown>);
    }
    rows.push(...seen);
    if (page.length < pageSize) return { rows, pages };
  }
  throw new Error(`stopped after ${maxPages} pages`);
}

/**
 * A StoredModelReader that reads the row with a signed `GET /Memory/<id>` as
 * the agent whose key signs the re-embed PATCH (the single-agent path without
 * administrator credentials).
 */
export function agentStoredModelReader(baseUrl: string, agentId: string, keyPath: string): StoredModelReader {
  return async (id) => {
    const res = await authFetch(baseUrl, agentId, keyPath, "GET", `/Memory/${encodeRecordId(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const row: unknown = await res.json();
    const record = row as { id?: unknown; embeddingModel?: unknown } | null;
    return record?.id === id ? record.embeddingModel : undefined;
  };
}

/**
 * flair#2296: re-embed one stored row. The PATCH body names only the two
 * embedding fields; the server embeds the stored row and writes embedding,
 * embeddingModel and updatedAt.
 *
 * flair#2561: the server answers `{ id, updatedAt }`. The row counts as
 * re-embedded when that response names this row and the stored row then
 * carries `intendedModel`, read with `readStoredModel`.
 *
 * flair#3128: `reembedRowOutcome` also returns a short reason label (HTTP
 * status or error message) that the command counts once per distinct value.
 */
export type ReembedRowOutcome = { ok: boolean; reason?: string };

export async function reembedRowOutcome(
  baseUrl: string,
  agentId: string,
  keyPath: string,
  id: string,
  intendedModel: string,
  readStoredModel: StoredModelReader,
): Promise<ReembedRowOutcome> {
  let res: Response;
  try {
    res = await authFetch(baseUrl, agentId, keyPath, "PATCH", `/Memory/${encodeRecordId(id)}`, {
      embedding: null, embeddingModel: null,
    });
  } catch (err) {
    return { ok: false, reason: `PATCH failed: ${errorText(err)}` };
  }
  return reembedOutcomeFromResponse(res, id, intendedModel, readStoredModel);
}

/**
 * flair#3128: the same re-embed PATCH and readback with the administrator
 * credential the all-agent run lists rows with. Its two-field body is
 * identical to `reembedRowOutcome`'s, so it changes only the embedding, the
 * model stamp, `updatedAt`, the embedded-text hash and a missing legacy
 * `instanceToken`; it never needs, or looks for, the owner's key.
 */
export async function adminReembedRowOutcome(
  baseUrl: string,
  opsAuth: string,
  id: string,
  intendedModel: string,
  readStoredModel: StoredModelReader,
): Promise<ReembedRowOutcome> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/Memory/${encodeRecordId(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: opsAuth },
      body: JSON.stringify({ embedding: null, embeddingModel: null }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, reason: `PATCH failed: ${errorText(err)}` };
  }
  return reembedOutcomeFromResponse(res, id, intendedModel, readStoredModel);
}

/** The readback and reason classification both re-embed paths share. */
async function reembedOutcomeFromResponse(
  res: Response,
  id: string,
  intendedModel: string,
  readStoredModel: StoredModelReader,
): Promise<ReembedRowOutcome> {
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "PATCH response was not JSON" };
  }
  if ((body as { id?: unknown } | null)?.id !== id) {
    return { ok: false, reason: "PATCH response did not name the row" };
  }
  let stored: unknown;
  try {
    stored = await readStoredModel(id);
  } catch (err) {
    return { ok: false, reason: `stored model read failed: ${errorText(err)}` };
  }
  if (stored === intendedModel) return { ok: true };
  return { ok: false, reason: `stored embeddingModel is ${typeof stored === "string" && stored.length > 0 ? stored : "missing"}` };
}

/** `reembedRow` as a boolean: true when the row's stored stamp names `intendedModel`. */
export async function reembedRow(
  baseUrl: string,
  agentId: string,
  keyPath: string,
  id: string,
  intendedModel: string,
  readStoredModel: StoredModelReader,
): Promise<boolean> {
  return (await reembedRowOutcome(baseUrl, agentId, keyPath, id, intendedModel, readStoredModel)).ok;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 0 ? message : "unknown error";
}

/** One line per distinct failure reason, with the rows that share it (flair#3128). */
function failureReasonLines(reasons: Map<string, number>, remedy: string): string[] {
  return [...reasons].map(([reason, count]) => `  ❌ ${count} row(s) not updated: ${reason} — ${remedy}`);
}

/**
 * flair#2337: refuse before the first write when the running server does not
 * advertise the re-embed PATCH (#2298). Returns null when the token is present,
 * else the refusal message to print. Reads the public `GET /Health` — no auth,
 * so it works before any agent key is used and before the all-agents loop.
 *
 * Unreachable, non-200, non-JSON, or unparseable capability responses are refused.
 */
export async function reembedServerSupportError(baseUrl: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/Health`, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    return reembedUnverifiedMessage(`GET /Health failed (${(err as Error)?.message ?? String(err)})`);
  }
  if (res.status !== 200) {
    return reembedUnverifiedMessage(`GET /Health returned HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return reembedUnverifiedMessage("GET /Health did not return JSON");
  }
  const caps = parseHealthCapabilities(body);
  if (caps === null) {
    return reembedUnverifiedMessage("GET /Health reported capabilities in an unrecognized shape");
  }
  if (caps.includes(MEMORY_REEMBED_PATCH_CAPABILITY)) return null;
  return reembedUnsupportedMessage(healthVersion(body));
}

export function register(program: Command): void {
// ─── flair reembed ────────────────────────────────────────────────────────────
//
// ROOT-CAUSE GUARD — recall graph correctness (recall-hnsw-graph-heal).
// `flair reembed` replaces the stored embedding of many rows IN PLACE (one
// PATCH per row, which Memory.patch() completes from the stored row; a bulk
// in-place re-embed like resources/migrations/embedding-stamp.ts's).
// Historically, an OLDER (pre-fix) Harper's
// INCREMENTAL HNSW update left stale/asymmetric reverse edges under bulk
// re-embed, which collapsed prod recall in July. That engine bug is FIXED in
// the Harper this ships against (5.1.22) — its update path reconstructs the
// prior vector and does the reverse-edge cleanup the old build skipped — so a
// bulk re-embed no longer corrupts the graph. DEFENSE-IN-DEPTH RULE (a
// prudent, version-independent default, not a workaround for a live bug): pair
// any BULK re-embed with a structural graph REBUILD trigger rather than relying
// on incremental HNSW updates to converge (today: the
// `@indexed(type:"HNSW", M:16)` descriptor bump in schemas/memory.graphql,
// which makes Harper clear + rebuild the graph cleanly from the stored vectors
// on the next boot — see resources/migrations/graph-heal.ts). Do NOT use
// resources/MemoryReindex.ts's `_reindex` for graph correctness (it re-PUTs the
// same vector through the incremental path and rebuilds nothing). If a `flair
// reembed` run ever materially changes the vector space (e.g. a model swap),
// follow it with a deploy that trips the structural reindex (bump the HNSW
// descriptor / restart after a schema change).


program
  .command("reembed")
  .description("Re-generate embeddings for memories with stale or missing model tags")
  .option("--agent <id>", "Agent ID to re-embed memories for (defaults to all agents with stale rows)")
  .option("--stale-only", "Only re-embed memories with mismatched model tag")
  .option("--dry-run", "Show count without modifying")
  .option("--port <port>", "Harper HTTP port")
  .option("--batch-size <n>", "Records per batch", "50")
  .option("--delay-ms <ms>", "Delay between batches (ms)", "100")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const baseUrl = `http://127.0.0.1:${port}`;
    const agentId = opts.agent;
    const staleOnly = opts.staleOnly ?? false;
    const dryRun = opts.dryRun ?? false;
    const batchSize = Number(opts.batchSize);
    const delayMs = Number(opts.delayMs);

    // A call with neither --agent nor an admin password is a usage error; report
    // it before the server check below so the existing message is not masked.
    const adminPassEnv = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
    if (!agentId && !adminPassEnv) {
      console.error("❌ Admin password required when --agent is not specified (set FLAIR_ADMIN_PASS or HDB_ADMIN_PASSWORD)");
      process.exit(1);
    }

    // flair#2337: require the advertised token before either PATCH loop.
    const supportError = await reembedServerSupportError(baseUrl);
    if (supportError) {
      console.error(supportError);
      process.exit(1);
    }

    // flair#504 Phase 2: MUST match resources/embeddings-provider.ts's
    // getModelId() — including THE GATE (EMBEDDING_PREFIXES_ENABLED), not
    // just the suffix. Duplicated as literals, not imported, because
    // src/cli.ts and resources/**.ts are separate build targets —
    // tsconfig.cli.json's rootDir is "src" and only includes src/cli.ts +
    // src/cli-shim.cts, and the published CLI package ships only dist/ built
    // from that config (package.json's "files"), so resources/ isn't
    // reachable from (or bundled into) the CLI binary. THE GATE is now ON
    // (flipped, re-baselined through the ratchet gate — see
    // embeddings-provider.ts's file header and PR #689 for the park history
    // this flip revisits), so `currentModel` here is `<base>+searchprefix` —
    // matching getModelId()'s gate-on return exactly. If
    // EMBEDDING_PREFIXES_ENABLED or EMBEDDING_VARIANT ever changes in
    // embeddings-provider.ts, update this block too — a drift here silently
    // breaks `--stale-only`: it would compare every row's embeddingModel
    // against the WRONG current-model string, so rows would read as already
    // "current" (or as needing re-embed) out of sync with what getModelId()
    // is actually stamping new writes with.
    const EMBEDDING_PREFIXES_ENABLED = true; // MUST mirror resources/embeddings-provider.ts's gate
    const EMBEDDING_VARIANT = "searchprefix";
    // embedding-space-guard slice 1: getModelId() now stamps the ENGINE-QUALIFIED
    // id `<engine>:<base>[+searchprefix]`. Duplicated as a literal here (separate
    // build target — see above). A row is CURRENT-SPACE iff its stamp is the
    // qualified id OR its one-time bare-name equivalent (today's corpus, stamped
    // before the qualifier). Treat BOTH as current so `--stale-only` never
    // re-embeds an already-correct bare-stamped row — that would loop forever
    // (Memory.put re-stamps it QUALIFIED, still "!= bare" under a single-value
    // check). Keep in lockstep with resources/embeddings-provider.ts's
    // getModelId()/EMBEDDING_ENGINE and resources/embedding-space-guard.ts's
    // normalizeStamp().
    const EMBEDDING_ENGINE = "gguf";
    const baseModel = process.env.FLAIR_EMBEDDING_MODEL ?? "nomic-embed-text-v1.5-Q4_K_M";
    const bareCurrentModel = EMBEDDING_PREFIXES_ENABLED ? `${baseModel}+${EMBEDDING_VARIANT}` : baseModel;
    const currentModel = `${EMBEDDING_ENGINE}:${bareCurrentModel}`;
    const isCurrentSpace = (stamp: string | undefined | null): boolean =>
      stamp === currentModel || stamp === bareCurrentModel;

    if (agentId) {
      console.log(`Re-embedding memories for agent: ${agentId}`);
    } else {
      console.log("Re-embedding memories for all agents with stale rows");
    }
    console.log(`Current model: ${currentModel}`);
    if (staleOnly) console.log("Mode: stale-only (skipping up-to-date memories)");
    if (dryRun) console.log("Mode: dry-run (no modifications)");
    console.log("");

    // When no agent specified, use admin auth to fetch all memories
    if (!agentId) {
      const adminPass = adminPassEnv!;

      // Fetch every memory via the Harper ops API (search_by_conditions on the
      // Memory table) rather than POST /SemanticSearch. SemanticSearch goes
      // through the HNSW cosine index, which throws "Cosine distance comparison
      // requires an array" against rows whose stored embedding shape is
      // incompatible with the running Harper version (e.g. data written under
      // harper@5.0.1 read under 5.0.9). The ops API bypasses the
      // vector index — exactly what we need when the goal is to replace every
      // embedding with a freshly-computed one. Without this path, `flair
      // reembed` could not recover from the very condition it exists to fix.
      // Reads the pages before the first write (flair#3086). The read refuses
      // when its last page (MAX_MEMORY_READ_PAGES) comes back full, and the
      // command exits non-zero without writing.
      const opsPort = resolveOpsPort(opts);
      const opsAuth = `Basic ${Buffer.from(`${resolveAdminUser(undefined)}:${adminPass}`).toString("base64")}`;
      const readStoredModel = opsStoredModelReader(opsPort, opsAuth);
      // The first page selects every row by id alone. An empty condition list
      // is refused (node_modules/harper/validation/searchValidator.ts:50-51), and
      // Harper's own select-all is the primary key above the bottom of its key
      // order (node_modules/harper/resources/Table.ts:5975-5976). `id > 0` is
      // that bound: the key encoding ranks strings above positive numbers (the
      // ordered-binary bundled with Harper, index.js:2-11), so every string id
      // is admitted, whatever its createdAt.
      let allMemories: any[];
      let readPages: number;
      try {
        ({ rows: allMemories, pages: readPages } = await readAllMemoryRows({
          opsPort,
          opsAuth,
          conditions: [{ search_attribute: "id", search_type: "greater_than", search_value: 0 }],
        }));
      } catch (err) {
        console.error(`❌ Failed to fetch memories via ops API: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(`Read ${allMemories.length} memories in ${readPages} page(s)`);

      // Group by agentId
      const byAgent = new Map<string, any[]>();
      for (const m of allMemories) {
        if (!m.content) continue;
        if (staleOnly && isCurrentSpace(m.embeddingModel)) continue;
        const agent = m.agentId || "unknown";
        if (!byAgent.has(agent)) byAgent.set(agent, []);
        byAgent.get(agent)!.push(m);
      }

      // Process each agent. The run already holds the administrator credential
      // that listed these rows, and the re-embed PATCH changes no owner,
      // provenance or authority field, so the same credential authorizes every
      // row's write; no agent key is needed.
      let totalProcessed = 0;
      let totalErrors = 0;
      const errorsByReason = new Map<string, number>();
      const agentCount = byAgent.size;
      let agentIndex = 0;

      for (const [agent, memories] of byAgent) {
        agentIndex++;
        console.log(`\nAgent ${agentIndex}/${agentCount}: ${agent}`);
        console.log(`  Memories to re-embed: ${memories.length}`);

        if (dryRun) continue;

        let processed = 0;
        let errors = 0;
        for (let i = 0; i < memories.length; i += batchSize) {
          const batch = memories.slice(i, i + batchSize);
          for (const memory of batch) {
            try {
              const outcome = await adminReembedRowOutcome(baseUrl, opsAuth, memory.id, currentModel, readStoredModel);
              if (outcome.ok) processed++;
              else {
                const reason = outcome.reason ?? "unknown failure";
                errors++;
                errorsByReason.set(reason, (errorsByReason.get(reason) ?? 0) + 1);
              }
            } catch (err) {
              errors++;
              const reason = `unexpected error: ${errorText(err)}`;
              errorsByReason.set(reason, (errorsByReason.get(reason) ?? 0) + 1);
            }
          }
          const pct = Math.round(((i + batch.length) / memories.length) * 100);
          process.stdout.write(`  \r  Re-embedded ${processed}/${memories.length} (${pct}%)${errors > 0 ? ` [${errors} errors]` : ""}`);
          if (i + batchSize < memories.length) await new Promise(r => setTimeout(r, delayMs));
        }
        console.log(`\n  ${errors > 0 ? "❌" : "✅"} Agent ${agent}: ${processed} updated, ${errors} errors`);
        totalProcessed += processed;
        totalErrors += errors;
      }

      const failed = totalErrors > 0;
      console.log(
        `\n\n${failed ? "❌" : "✅"} Re-embedding complete: ${totalProcessed} updated, ${totalErrors} errors`,
      );
      for (const line of failureReasonLines(errorsByReason, "re-run `flair reembed` after fixing the cause")) console.log(line);
      if (failed) process.exit(1);
      return;
    }

    // Single-agent path. Same rationale as above: fetch via the ops API
    // (search_by_value on agentId) so the vector index isn't in the read path.
    // This requires admin pass — fall back to the old SemanticSearch fetch only
    // if no admin pass is available, since that path still works on
    // version-matched data and requires only the agent's own key.
    const keysDir = defaultKeysDir();
    const privPath = privKeyPath(agentId, keysDir);
    if (!existsSync(privPath)) {
      console.error(`❌ Key not found: ${privPath}`);
      process.exit(1);
    }

    const adminPassSingle = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
    let allMemories: any[] = [];
    let readPages = 0;
    // flair#2561: the stamp of each re-embedded row is read back the way the
    // rows were listed: the operations API with administrator credentials,
    // else a signed GET as this agent.
    let readStoredModel: StoredModelReader = agentStoredModelReader(baseUrl, agentId, privPath);
    if (adminPassSingle) {
      const opsPort = resolveOpsPort(opts);
      const opsAuth = `Basic ${Buffer.from(`${resolveAdminUser(undefined)}:${adminPassSingle}`).toString("base64")}`;
      readStoredModel = opsStoredModelReader(opsPort, opsAuth);
      try {
        ({ rows: allMemories, pages: readPages } = await readAllMemoryRows({
          opsPort,
          opsAuth,
          conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: agentId }],
        }));
      } catch (err) {
        console.error(`❌ Failed to fetch memories via ops API: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(`Read ${allMemories.length} memories in ${readPages} page(s)`);
    } else {
      const searchRes = await authFetch(baseUrl, agentId, privPath, "POST", "/SemanticSearch", {
        agentId, limit: KEYLESS_SEARCH_LIMIT,
      });
      if (!searchRes.ok) {
        console.error(`❌ Failed to fetch memories: ${searchRes.status}`);
        process.exit(1);
      }
      const data = await searchRes.json() as { results?: any[] };
      allMemories = data.results ?? [];
    }
    // The keyless /SemanticSearch call has no paging parameter (see
    // resources/SemanticSearch.ts): exactly `KEYLESS_SEARCH_LIMIT` rows means
    // the listing may have been cut off, so the run must say so and fail.
    const keylessTruncated = !adminPassSingle && allMemories.length === KEYLESS_SEARCH_LIMIT;

    // flair#3129: the keyless listing's read scope includes every other agent's
    // non-private rows (resources/memory-read-scope.ts). Only this agent's rows
    // are candidates — a PATCH as this agent to another agent's row is refused
    // — so drop the others before the candidate and up-to-date counts.
    const keylessListed = allMemories.length;
    let otherAgentRows = 0;
    if (!adminPassSingle) {
      allMemories = allMemories.filter((m: any) => m.agentId === agentId);
      otherAgentRows = keylessListed - allMemories.length;
    }

    const candidates = allMemories.filter((m: any) => {
      if (!m.content) return false;
      if (staleOnly) return !m.embeddingModel || !isCurrentSpace(m.embeddingModel);
      return true;
    });

    const total = candidates.length;
    const skipped = allMemories.length - total;

    console.log(`Candidates for re-embedding: ${total}`);
    if (otherAgentRows > 0) console.log(`Skipped (other agents): ${otherAgentRows}`);
    if (skipped > 0) console.log(`Skipped (up-to-date): ${skipped}`);

    if (dryRun || total === 0) {
      if (total === 0) console.log("\n✅ All memories are up-to-date!");
      if (keylessTruncated) {
        console.log(keylessTruncationNotice(keylessListed));
        process.exit(1);
      }
      return;
    }

    console.log("");
    let processed = 0;
    let errors = 0;
    const errorsByReason = new Map<string, number>();

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      for (const memory of batch) {
        try {
          const outcome = await reembedRowOutcome(baseUrl, agentId, privPath, memory.id, currentModel, readStoredModel);
          if (outcome.ok) processed++;
          else {
            const reason = outcome.reason ?? "unknown failure";
            errors++;
            errorsByReason.set(reason, (errorsByReason.get(reason) ?? 0) + 1);
          }
        } catch (err) {
          errors++;
          const reason = `unexpected error: ${errorText(err)}`;
          errorsByReason.set(reason, (errorsByReason.get(reason) ?? 0) + 1);
        }
      }
      const pct = Math.round(((i + batch.length) / total) * 100);
      process.stdout.write(`\rRe-embedded ${processed}/${total} (${pct}%)${errors > 0 ? ` [${errors} errors]` : ""}`);
      if (i + batchSize < candidates.length) await new Promise(r => setTimeout(r, delayMs));
    }

    const failed = errors > 0;
    console.log(`\n\n${failed ? "❌" : "✅"} Re-embedding complete: ${processed} updated, ${errors} errors`);
    for (const line of failureReasonLines(errorsByReason, `re-run \`flair reembed --agent ${agentId}\` after fixing the cause`)) console.log(line);
    if (keylessTruncated) console.log(keylessTruncationNotice(keylessListed));
    if (failed || keylessTruncated) process.exit(1);
  });

}
