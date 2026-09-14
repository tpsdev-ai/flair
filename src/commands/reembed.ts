/**
 * reembed.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair reembed`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { authFetch, defaultKeysDir, resolveAdminUser } from "../lib/auth-resolve.js";
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

export function register(program: Command): void {
// ─── flair reembed ────────────────────────────────────────────────────────────
//
// ROOT-CAUSE GUARD — recall graph correctness (recall-hnsw-graph-heal).
// `flair reembed` replaces the stored embedding of many rows IN PLACE (it
// clears embedding/embeddingModel, then re-PUTs through Memory.put()'s regen
// branch — the same bulk in-place re-embed path resources/migrations/
// embedding-stamp.ts uses). Historically, an OLDER (pre-fix) Harper's
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
      const adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
      if (!adminPass) {
        console.error("❌ Admin password required when --agent is not specified (set FLAIR_ADMIN_PASS or HDB_ADMIN_PASSWORD)");
        process.exit(1);
      }

      // Fetch every memory via the Harper ops API (search_by_conditions on the
      // Memory table) rather than POST /SemanticSearch. SemanticSearch goes
      // through the HNSW cosine index, which throws "Cosine distance comparison
      // requires an array" against rows whose stored embedding shape is
      // incompatible with the running Harper version (e.g. data written under
      // harper@5.0.1 read under 5.0.9). The ops API bypasses the
      // vector index — exactly what we need when the goal is to replace every
      // embedding with a freshly-computed one. Without this path, `flair
      // reembed` could not recover from the very condition it exists to fix.
      const opsPort = resolveOpsPort(opts);
      const opsAuth = `Basic ${Buffer.from(`${resolveAdminUser(undefined)}:${adminPass}`).toString("base64")}`;
      // Harper rejects empty-value conditions ("not indexed for nulls"). Use
      // `createdAt > 1970-01-01` as the "select all" pattern: every Memory row
      // has a createdAt, the index is built, and the comparison is total.
      const searchRes = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: opsAuth },
        body: JSON.stringify({
          operation: "search_by_conditions",
          database: "flair",
          table: "Memory",
          operator: "and",
          conditions: [{ search_attribute: "createdAt", search_type: "greater_than", search_value: "1970-01-01" }],
          get_attributes: ["*"],
          limit: 100000,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!searchRes.ok) {
        console.error(`❌ Failed to fetch memories via ops API: ${searchRes.status}`);
        process.exit(1);
      }
      const raw = await searchRes.json() as unknown;
      const allMemories: any[] = Array.isArray(raw) ? raw : ((raw as { results?: any[] })?.results ?? []);

      // Group by agentId
      const byAgent = new Map<string, any[]>();
      for (const m of allMemories) {
        if (!m.content) continue;
        if (staleOnly && isCurrentSpace(m.embeddingModel)) continue;
        const agent = m.agentId || "unknown";
        if (!byAgent.has(agent)) byAgent.set(agent, []);
        byAgent.get(agent)!.push(m);
      }

      // Process each agent
      let totalProcessed = 0;
      let totalErrors = 0;
      const agentCount = byAgent.size;
      let agentIndex = 0;

      for (const [agent, memories] of byAgent) {
        agentIndex++;
        console.log(`\nAgent ${agentIndex}/${agentCount}: ${agent}`);
        console.log(`  Memories to re-embed: ${memories.length}`);

        const keysDir = defaultKeysDir();
        const privPath = privKeyPath(agent, keysDir);
        if (!existsSync(privPath)) {
          console.error(`  ❌ Key not found: ${privPath} — skipping`);
          continue;
        }

        if (dryRun) continue;

        let processed = 0;
        let errors = 0;
        for (let i = 0; i < memories.length; i += batchSize) {
          const batch = memories.slice(i, i + batchSize);
          for (const memory of batch) {
            try {
              const updateRes = await authFetch(baseUrl, agent, privPath, "PUT", `/Memory/${memory.id}`, {
                id: memory.id, content: memory.content, embedding: undefined, embeddingModel: undefined, agentId: memory.agentId || agent,
              });
              if (updateRes.ok) processed++;
              else errors++;
            } catch { errors++; }
          }
          const pct = Math.round(((i + batch.length) / memories.length) * 100);
          process.stdout.write(`  \r  Re-embedded ${processed}/${memories.length} (${pct}%)${errors > 0 ? ` [${errors} errors]` : ""}`);
          if (i + batchSize < memories.length) await new Promise(r => setTimeout(r, delayMs));
        }
        console.log(`\n  ✅ Agent ${agent}: ${processed} updated, ${errors} errors`);
        totalProcessed += processed;
        totalErrors += errors;
      }

      console.log(`\n\n✅ Re-embedding complete: ${totalProcessed} updated, ${totalErrors} errors`);
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
    if (adminPassSingle) {
      const opsPort = resolveOpsPort(opts);
      const opsAuth = `Basic ${Buffer.from(`${resolveAdminUser(undefined)}:${adminPassSingle}`).toString("base64")}`;
      const searchRes = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: opsAuth },
        body: JSON.stringify({
          operation: "search_by_value",
          database: "flair",
          table: "Memory",
          search_attribute: "agentId",
          search_value: agentId,
          get_attributes: ["*"],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!searchRes.ok) {
        console.error(`❌ Failed to fetch memories via ops API: ${searchRes.status}`);
        process.exit(1);
      }
      const raw = await searchRes.json() as unknown;
      allMemories = Array.isArray(raw) ? raw : ((raw as { results?: any[] })?.results ?? []);
    } else {
      const searchRes = await authFetch(baseUrl, agentId, privPath, "POST", "/SemanticSearch", {
        agentId, limit: 10000,
      });
      if (!searchRes.ok) {
        console.error(`❌ Failed to fetch memories: ${searchRes.status}`);
        process.exit(1);
      }
      const data = await searchRes.json() as { results?: any[] };
      allMemories = data.results ?? [];
    }

    const candidates = allMemories.filter((m: any) => {
      if (!m.content) return false;
      if (staleOnly) return !m.embeddingModel || !isCurrentSpace(m.embeddingModel);
      return true;
    });

    const total = candidates.length;
    const skipped = allMemories.length - total;

    console.log(`Total memories: ${allMemories.length}`);
    console.log(`Candidates for re-embedding: ${total}`);
    if (skipped > 0) console.log(`Skipped (up-to-date): ${skipped}`);

    if (dryRun || total === 0) {
      if (total === 0) console.log("\n✅ All memories are up-to-date!");
      return;
    }

    console.log("");
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      for (const memory of batch) {
        try {
          const updateRes = await authFetch(baseUrl, agentId, privPath, "PUT", `/Memory/${memory.id}`, {
            id: memory.id, content: memory.content, embedding: undefined, embeddingModel: undefined, agentId: memory.agentId || opts.agent,
          });
          if (updateRes.ok) processed++;
          else errors++;
        } catch { errors++; }
      }
      const pct = Math.round(((i + batch.length) / total) * 100);
      process.stdout.write(`\rRe-embedded ${processed}/${total} (${pct}%)${errors > 0 ? ` [${errors} errors]` : ""}`);
      if (i + batchSize < candidates.length) await new Promise(r => setTimeout(r, delayMs));
    }

    console.log(`\n\n✅ Re-embedding complete: ${processed} updated, ${errors} errors`);
  });

}
