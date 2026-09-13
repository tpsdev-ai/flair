/**
 * memory.ts — `flair memory` command group (flair#1621 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration, action handlers, and group-specific
 * inline helpers (hygiene predicates). Shared CLI helpers (api,
 * resolveSigningAgentId, credential flags, --entities parse, …) stay in
 * cli.ts and are bound before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import * as render from "../render.js";
import { resolveAdminUser } from "../lib/auth-resolve.js";
import type { ResolvedSigningIdentity } from "../lib/signing-identity.js";

export type MemoryCli = {
  api: (...args: any[]) => Promise<any>;
  resolveBaseUrl: (opts: { target?: string; url?: string; port?: string | number }) => string;
  resolveSigningAgentId: (opts: { agent?: string }, command?: string) => ResolvedSigningIdentity;
  applyAdminPassFile: (opts: { adminPass?: string; adminPassFile?: string }) => void;
  addSharedCredentialOptions: (cmd: Command) => Command;
  addSharedIdentityOption: (cmd: Command) => Command;
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
  parseEntitiesOptionOrExit: (csv: string) => string[];
  ENTITIES_OPTION_DESCRIPTION: string;
};

let cli: MemoryCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: MemoryCli): void {
  cli = fns;
}

function api(...args: any[]): Promise<any> {
  return cli.api(...args);
}
function resolveBaseUrl(opts: { target?: string; url?: string; port?: string | number }): string {
  return cli.resolveBaseUrl(opts);
}
function resolveSigningAgentId(opts: { agent?: string }, command?: string): ResolvedSigningIdentity {
  return cli.resolveSigningAgentId(opts, command);
}
function applyAdminPassFile(opts: { adminPass?: string; adminPassFile?: string }): void {
  cli.applyAdminPassFile(opts);
}
function addSharedCredentialOptions(cmd: Command): Command {
  return cli.addSharedCredentialOptions(cmd);
}
function addSharedIdentityOption(cmd: Command): Command {
  return cli.addSharedIdentityOption(cmd);
}
function resolveOpsPort(opts: { opsPort?: string | number; port?: string | number }): number {
  return cli.resolveOpsPort(opts);
}
function parseEntitiesOptionOrExit(csv: string): string[] {
  return cli.parseEntitiesOptionOrExit(csv);
}

// Exported for unit testing — keeps the predicate logic separable from
// the CLI plumbing, ops-API fetching, and confirmation flow.
export const HYGIENE_TEST_CONTENT_PATTERNS: RegExp[] = [
  /quick brown fox/i,
  /flair\s*251\s*test/i,
  /^upgrade-smoke-(pre|post)-marker$/i,
];

export interface HygieneRow { id: string; content?: string }
export type HygieneCategory = "compact-id" | "test-content" | "tiny";
export interface HygieneOptions { enabled: Set<HygieneCategory>; tinyThreshold: number }

/** Categorize a single memory row against the enabled hygiene patterns.
 *  Returns the list of categories the row matches; empty array means clean.
 *  Pure function — easy to unit test and reason about. */
export function categorizeForHygiene(row: HygieneRow, opts: HygieneOptions): HygieneCategory[] {
  const cats: HygieneCategory[] = [];
  if (opts.enabled.has("compact-id") && typeof row.id === "string" && row.id.includes("-compact-")) {
    cats.push("compact-id");
  }
  if (opts.enabled.has("test-content") && typeof row.content === "string" && HYGIENE_TEST_CONTENT_PATTERNS.some((p) => p.test(row.content!))) {
    cats.push("test-content");
  }
  if (opts.enabled.has("tiny") && typeof row.content === "string" && row.content.length < opts.tinyThreshold) {
    cats.push("tiny");
  }
  return cats;
}

export function register(program: Command): void {
  // ─── flair memory ──────────────────────────────────────────────────────────
  const ENTITIES_OPTION_DESCRIPTION = cli.ENTITIES_OPTION_DESCRIPTION;

  const memory = program.command("memory").description("Manage agent memories");
  addSharedCredentialOptions(
    addSharedIdentityOption(
      memory.command("add [content]")
        .description("Write a new memory row for an agent (content via positional arg or --content)"),
    ),
  )
    .option("--content <text>", "memory content (alias for positional arg)")
    .option("--durability <d>", "permanent|persistent|standard|ephemeral (default standard). Also decides the default visibility when --visibility is omitted: permanent/persistent -> shared, standard/ephemeral -> private").option("--tags <csv>")
    .option("--summary <text>", "agent-set multi-sentence dense compression (3-tier chain: subject → summary → content)")
    .option("--subject <text>", "one-line title / entity this memory is about")
    .option("--derived-from <csv>", "Comma-separated source Memory IDs this memory was distilled/reflected from (sets Memory.derivedFrom; used by the `rem rapid` reflection loop)")
    .option("--visibility <value>", "Writer-controlled sharing intent (sets Memory.visibility): 'private' (owner-only, never visible to any other agent) or 'shared' (visible to owner + every other agent on this instance — open within the org, not gated by a MemoryGrant). Omit to use the server's durability-keyed default: permanent/persistent -> shared, standard/ephemeral -> private (flair#509)")
    .option("--entities <csv>", ENTITIES_OPTION_DESCRIPTION)
    .action(async (contentArg: string | undefined, opts: any) => {
      const content = contentArg ?? opts.content;
      if (!content) { console.error("error: content required (positional arg or --content)"); process.exit(1); }
      applyAdminPassFile(opts);
      const { agentId, source } = resolveSigningAgentId(opts, "memory add");
      if (!agentId) {
        console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
        process.exit(2);
      }
      const memId = `${agentId}-${Date.now()}`;
      const body: any = {
        id: memId, agentId, content, durability: opts.durability || "standard",
        tags: opts.tags ? String(opts.tags).split(",").map((x: string) => x.trim()).filter(Boolean) : undefined,
        type: "memory", createdAt: new Date().toISOString(),
      };
      if (opts.summary) body.summary = opts.summary;
      if (opts.subject) body.subject = opts.subject;
      // flair#991: reject an unrecognized --visibility instead of writing it.
      // `visibility` is a free-form String server-side and the read scope asks
      // isPrivateVisibility() — an exact match on the literal "private" — so
      // ANY other string, `--visibility prvate` included, persists a row the
      // user believes is owner-only and that every agent on the instance can
      // in fact read. A typo must never widen who can read a memory.
      if (opts.visibility) {
        const visibility = String(opts.visibility).trim();
        if (visibility !== "private" && visibility !== "shared") {
          console.error(`error: --visibility must be 'private' or 'shared' (got: ${visibility})`);
          console.error("  omit it to use the durability-keyed default: permanent/persistent -> shared, standard/ephemeral -> private");
          process.exit(1);
        }
        body.visibility = visibility;
      }
      if (opts.derivedFrom) {
        body.derivedFrom = String(opts.derivedFrom).split(",").map((x: string) => x.trim()).filter(Boolean);
      }
      // flair#1288: validated client-side; exits 1 with the canonical
      // format-and-type-set message on any malformed value.
      if (opts.entities) {
        const entities = parseEntitiesOptionOrExit(String(opts.entities));
        if (entities.length > 0) body.entities = entities;
      }
      const out = await api("PUT", `/Memory/${memId}`, body, {
        agentId,
        agentIdSource: source,
        explicitAdminPass: opts.adminPass,
        adminUser: opts.adminUser,
      });
      console.log(JSON.stringify(out, null, 2));
    });
  // ─── flair memory write-task-summary ────────────────────────────────────────
  // Slice 1 of FLAIR-AGENT-CONTEXT-TIERS-B. Standalone
  // helper that any agent harness (or a manual operator) can invoke at task
  // close to capture a structured task summary as a persistent Memory row
  // before resetting the session.
  //
  // The shape of this row matters: tags=['task-summary','auto-on-reset'] +
  // subject='task:<beads-id>' + summary populated. Slice 3+4 (harness
  // integrations) will call this as part of the reset pipeline; slice 5+6
  // (operator surfaces) will surface promote/restore controls. Today, this
  // command is independently useful — operator can capture a manual summary
  // at any time.
  //
  // Returns the memory id on stdout (single line, parseable) so the harness
  // can plumb it into the next-dispatch system message.

  memory.command("write-task-summary")
    .description("Capture a structured task summary as a persistent Memory row (used by session-reset harness; standalone-callable by operators)")
    .requiredOption("--agent <id>", "Agent the summary belongs to")
    .requiredOption("--beads <ops-id>", "Bead/PR/task identifier this summary is about")
    .requiredOption("--outcome <s>", "Outcome of the task: merged | rejected | abandoned")
    .option("--summary <text>", "Multi-sentence dense compression (populates Memory.summary; will be the agent's read-time view)")
    .option("--files-touched <csv>", "Comma-separated list of files touched during the task (becomes part of content)")
    .option("--lessons <text>", "Lessons learned during the task (becomes part of content)")
    .option("--derived-from <csv>", "Comma-separated list of source Memory IDs this summary was distilled from")
    .action(async (opts: any) => {
      const validOutcomes = new Set(["merged", "rejected", "abandoned"]);
      if (!validOutcomes.has(opts.outcome)) {
        console.error(`Error: --outcome must be one of: merged, rejected, abandoned (got: ${opts.outcome})`);
        process.exit(1);
      }
      if (!opts.summary && !opts.lessons && !opts.filesTouched) {
        console.error("Error: at least one of --summary, --lessons, --files-touched is required (otherwise the summary has no content)");
        process.exit(1);
      }

      // Build the structured content block. Format chosen to be parseable + readable
      // — the agent reads it back on bootstrap of the next session.
      const lines: string[] = [];
      lines.push(`task: ${opts.beads}`);
      lines.push(`outcome: ${opts.outcome}`);
      if (opts.filesTouched) lines.push(`files: ${opts.filesTouched}`);
      if (opts.lessons) {
        lines.push("");
        lines.push("lessons:");
        lines.push(opts.lessons);
      }
      if (opts.summary) {
        lines.push("");
        lines.push("summary:");
        lines.push(opts.summary);
      }
      const content = lines.join("\n");

      const { agentId, source } = resolveSigningAgentId(opts, "memory write-task-summary");
      const memId = `${opts.agent}-task-${opts.beads}-${Date.now()}`;
      const body: any = {
        id: memId,
        agentId: opts.agent,
        content,
        durability: "persistent",
        tags: ["task-summary", "auto-on-reset"],
        subject: `task:${opts.beads}`,
        type: "task-summary",
        createdAt: new Date().toISOString(),
      };
      if (opts.summary) body.summary = opts.summary;
      if (opts.derivedFrom) {
        body.derivedFrom = String(opts.derivedFrom).split(",").map((x: string) => x.trim()).filter(Boolean);
      }

      const out = await api("PUT", `/Memory/${encodeURIComponent(memId)}`, body, { agentId, agentIdSource: source });
      if (out?.error) {
        console.error(`Error writing task summary: ${out.error}`);
        process.exit(1);
      }
      // Print just the memory id on stdout so the harness can capture it
      // without parsing a JSON blob.
      console.log(memId);
    });

  memory.command("search [query]")
    .description("Semantic search over an agent's memories (query via positional arg or --q)")
    .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
    .option("--admin-pass <pass>", "Admin password — sign as admin while --agent names whose memories to search (flair#1500: a flag-pinned agent with no key no longer falls back to FLAIR_ADMIN_PASS)")
    .option("--q <query>", "search query (alias for positional arg)")
    .option("--limit <n>", "Max results", "5")
    .option("--tag <tag>")
    .option("--include-archived", "Include basemented (archived) memories in results (default: excluded)")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
    .option("--url <url>", "Flair base URL (overrides --port)")
    .option("--port <port>", "Harper HTTP port")
    .action(async (queryArg: string | undefined, opts: any) => {
      const { agentId, source } = resolveSigningAgentId(opts, "memory search");
      if (!agentId) {
        console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
        process.exit(2);
      }
      const q = queryArg ?? opts.q;
      if (!q) { console.error("error: query required (positional arg or --q)"); process.exit(1); }
      const body: Record<string, any> = { agentId, q, limit: parseInt(opts.limit, 10) || 5 };
      if (opts.tag) body.tag = opts.tag;
      if (opts.includeArchived) body.includeArchived = true;
      const baseUrl = resolveBaseUrl(opts);
      const res = await api("POST", "/SemanticSearch", body, { baseUrl, agentId, agentIdSource: source, explicitAdminPass: opts.adminPass });
      console.log(JSON.stringify(res, null, 2));
    });
  // ─── flair memory basement / restore ────────────────────────────────────────
  // flair#1472 Deliverable A — the user-facing archive action. `basement` sends a
  // memory to the basement (archived=true + stamps archivedAt); `restore`
  // un-basements it (clears archived/archivedAt/archivedBy). Both are GLOBAL and
  // deliberate: restore un-retires the memory for EVERY session, not a
  // session-local view (per-session reuse is drawers, Deliverable B, which does
  // not exist yet). Scoped to the caller's own memories (own-lane write).
  memory.command("basement <id>")
    .description("Send a memory to the basement (archive it). Removes it from bootstrap + default search; still retrievable via `memory search --include-archived`. GLOBAL and deliberate — scoped to your own memories.")
    .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
    .option("--url <url>", "Flair base URL (overrides --port)")
    .option("--port <port>", "Harper HTTP port")
    .action(async (id: string, opts: any) => {
      const { agentId, source } = resolveSigningAgentId(opts, "memory basement");
      if (!agentId) {
        console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
        process.exit(2);
      }
      const baseUrl = resolveBaseUrl(opts);
      const res = await api("POST", "/MemoryArchive", { id, action: "basement" }, { baseUrl, agentId, agentIdSource: source });
      console.log(JSON.stringify(res, null, 2));
    });
  memory.command("restore <id>")
    .description("Restore a basemented (archived) memory. Clears archived/archivedAt/archivedBy. GLOBAL and deliberate — this un-retires the memory for EVERY session, not a session-local view (per-session reuse is drawers, which do not exist yet). Scoped to your own memories.")
    .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
    .option("--url <url>", "Flair base URL (overrides --port)")
    .option("--port <port>", "Harper HTTP port")
    .action(async (id: string, opts: any) => {
      const { agentId, source } = resolveSigningAgentId(opts, "memory restore");
      if (!agentId) {
        console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
        process.exit(2);
      }
      const baseUrl = resolveBaseUrl(opts);
      const res = await api("POST", "/MemoryArchive", { id, action: "restore" }, { baseUrl, agentId, agentIdSource: source });
      console.log(JSON.stringify(res, null, 2));
    });
  memory.command("list")
    .description("List an agent's memories (optionally filtered by --tag or embedding-backfill triage)")
    .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
    .option("--tag <tag>")
    .option("--hash-fallback", "Only memories with missing or hash-fallback embeddings (for backfill triage)")
    .option("--limit <n>", "Max rows when using --hash-fallback", "50")
    .option("--json", "Emit raw JSON array (also: pipe + FLAIR_OUTPUT=json)")
    .action(async (opts: any) => {
      const { agentId, source } = resolveSigningAgentId(opts, "memory list");
      if (!agentId) {
        console.error(`${render.icons.error} --agent <id> required (or set FLAIR_AGENT_ID)`);
        process.exit(2);
      }
      const q = new URLSearchParams({ agentId, ...(opts.tag ? { tag: opts.tag } : {}) }).toString();
      const raw = await api("GET", `/Memory?${q}`, undefined, { agentId, agentIdSource: source });
      const mode = render.resolveOutputMode(opts);

      // hashFallback flag changes the lens: instead of all memories, show
      // only those that need re-embedding. Keep that surface separate.
      if (opts.hashFallback) {
        const all: any[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.items ?? []);
        const fallback = all.filter((m: any) => !m.embeddingModel || m.embeddingModel === "hash-512d");
        if (mode === "json") {
          console.log(render.asJSON(fallback));
          return;
        }
        if (fallback.length === 0) {
          console.log(`${render.icons.ok} ${render.wrap(render.c.green, "All memories embedded")} ${render.wrap(render.c.dim, `(agent ${agentId})`)}`);
          return;
        }
        const limit = Math.max(1, parseInt(opts.limit, 10) || 50);
        const rows = fallback
          .slice()
          .sort((a: any, b: any) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return tb - ta;
          })
          .slice(0, limit);
        console.log(
          `${render.icons.warn} ${render.wrap(render.c.yellow, String(fallback.length))} hash-fallback memories for agent ${render.wrap(render.c.bold, agentId)} ${render.wrap(render.c.dim, `(showing ${rows.length})`)}\n`,
        );
        const cols: render.TableColumn[] = [
          { label: "id", key: "id" },
          {
            label: "created_at",
            key: "createdAt",
            format: (v) => (v ? String(v).slice(0, 19).replace("T", " ") : "—"),
          },
          {
            label: "preview",
            key: "content",
            format: (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 80),
          },
        ];
        console.log(render.table(cols, rows as Array<Record<string, unknown>>));
        if (fallback.length > rows.length) {
          console.log(
            `\n${render.wrap(render.c.dim, `... ${fallback.length - rows.length} more (raise with --limit). To backfill:`)} flair reembed --agent ${agentId} --stale-only`,
          );
        } else {
          console.log(`\n${render.wrap(render.c.dim, "To backfill:")} flair reembed --agent ${agentId} --stale-only`);
        }
        return;
      }

      // Default lens: all memories for the agent.
      const all: any[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.items ?? []);
      if (mode === "json") {
        console.log(render.asJSON(all));
        return;
      }
      if (all.length === 0) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, `No memories for agent ${agentId}`)}`);
        return;
      }
      console.log(
        `${render.wrap(render.c.bold, String(all.length))} memories for agent ${render.wrap(render.c.bold, agentId)}${opts.tag ? ` ${render.wrap(render.c.dim, `(tag=${opts.tag})`)}` : ""}\n`,
      );
      const sorted = all
        .slice()
        .sort((a: any, b: any) => {
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return tb - ta;
        });
      const durabilityColor = (d: string): string => {
        if (d === "permanent") return render.c.magenta;
        if (d === "persistent") return render.c.blue;
        if (d === "ephemeral") return render.c.gray;
        return render.c.cyan;
      };
      const cols: render.TableColumn[] = [
        {
          label: "created_at",
          key: "createdAt",
          format: (v) => (v ? render.wrap(render.c.dim, String(v).slice(0, 10)) : render.wrap(render.c.dim, "—")),
        },
        {
          label: "durability",
          key: "durability",
          format: (v) => {
            const d = String(v ?? "standard");
            return render.wrap(durabilityColor(d), d);
          },
        },
        {
          label: "preview",
          key: "content",
          format: (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 80),
        },
      ];
      console.log(render.table(cols, sorted as Array<Record<string, unknown>>));
    });

  // ─── flair memory hygiene ────────────────────────────────────────────────────
  // Detect + remove junk memory rows that accumulate over time. Surfaced from
  // a 2026-05-07 manual cleanup: an instance had 627 records, ~250 of
  // them were noise — `*-compact-*` ID fragments from an old pipeline, pangram
  // test content ("the quick brown fox..." / "Flair 251 test ..."), and
  // near-empty rows (<25 chars). We did the cleanup ad-hoc with raw curl + jq;
  // this command bundles those patterns + future ones as an operator tool that
  // dry-runs by default.
  //
  // Three pattern categories, each toggle-able:
  //   --pattern compact-id   : ids matching /-compact-/ (legacy pipeline output)
  //   --pattern test-content : content matching pangram / known test strings
  //   --pattern tiny         : content shorter than 25 chars
  //
  // Default is all three, dry-run. Flip --apply to actually delete. Always
  // requires admin pass to read across agent scopes (uses ops API).
  //
  // Federation note: this only deletes on the local instance. Federation
  // distributed-delete via tombstones is the systemic answer for
  // fan-out — until that lands, run `flair memory hygiene` on each peer.

  // Exported for unit testing — keeps the predicate logic separable from
  // the CLI plumbing, ops-API fetching, and confirmation flow.
  memory.command("hygiene")
    .description("Detect and (with --apply) remove junk memory rows from the local instance")
    .option("--apply", "Actually delete the matched rows (default: dry-run)")
    .option("--pattern <list>", "Comma-separated patterns to match: compact-id,test-content,tiny (default: all)")
    .option("--tiny-threshold <n>", "Char length below which content is 'tiny'", "25")
    .option("--port <port>", "Harper HTTP port")
    .option("--ops-port <port>", "Harper ops API port (default: HTTP - 1)")
    .action(async (opts: any) => {
      const opsPort = resolveOpsPort(opts);
      const adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
      if (!adminPass) {
        console.error("❌ Admin password required (set FLAIR_ADMIN_PASS or HDB_ADMIN_PASSWORD).");
        process.exit(1);
      }

      const enabled = new Set(
        (opts.pattern ?? "compact-id,test-content,tiny").split(",").map((s: string) => s.trim()).filter(Boolean),
      );
      const tinyThreshold = Math.max(0, Number(opts.tinyThreshold) || 25);
      const apply: boolean = !!opts.apply;

      const opsAuth = `Basic ${Buffer.from(`${resolveAdminUser(undefined)}:${adminPass}`).toString("base64")}`;
      async function ops(body: unknown): Promise<unknown> {
        const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: opsAuth },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          throw new Error(`ops API failed (${res.status}): ${await res.text().catch(() => "")}`);
        }
        return res.json();
      }

      // Fetch all rows via ops API. Bypasses /SemanticSearch (vector index) the
      // same way `flair reembed` does, so this command works even when the
      // cosine path is broken — exactly the conditions hygiene is most needed.
      console.log("Scanning Memory table...");
      const raw = await ops({
        operation: "search_by_conditions",
        database: "flair",
        table: "Memory",
        operator: "and",
        conditions: [{ search_attribute: "createdAt", search_type: "greater_than", search_value: "1970-01-01" }],
        get_attributes: ["id", "agentId", "content", "createdAt"],
        limit: 100000,
      });
      const rows: any[] = Array.isArray(raw) ? raw : ((raw as { results?: any[] })?.results ?? []);
      console.log(`  ${rows.length} total memories scanned.`);

      // Match each pattern. Counts by category, single id list for the delete.
      const matched = new Map<HygieneCategory, Set<string>>();
      const allIds = new Set<string>();
      const hygieneOpts: HygieneOptions = { enabled: enabled as Set<HygieneCategory>, tinyThreshold };

      for (const r of rows) {
        const categories = categorizeForHygiene(r, hygieneOpts);
        for (const c of categories) {
          if (!matched.has(c)) matched.set(c, new Set());
          matched.get(c)!.add(r.id);
          allIds.add(r.id);
        }
      }

      console.log("");
      console.log(`Match summary (${apply ? "APPLY" : "dry-run"}):`);
      const allCategories: HygieneCategory[] = ["compact-id", "test-content", "tiny"];
      for (const c of allCategories) {
        const n = matched.get(c)?.size ?? 0;
        const enabledMark = enabled.has(c) ? "✓" : "·";
        console.log(`  ${enabledMark} ${c.padEnd(13)} ${n.toString().padStart(5)} rows`);
      }
      console.log(`  ────────────────────────────`);
      console.log(`    total unique ${allIds.size.toString().padStart(5)} rows`);

      if (allIds.size === 0) {
        console.log("\n✅ Nothing to clean.");
        return;
      }

      if (!apply) {
        console.log("\n(dry-run) — re-run with --apply to delete the matched rows.");
        return;
      }

      // Delete in chunks (Harper accepts batches of hash_values).
      const ids = Array.from(allIds);
      const chunkSize = 200;
      let deleted = 0;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const batch = ids.slice(i, i + chunkSize);
        const result = await ops({
          operation: "delete",
          database: "flair",
          table: "Memory",
          hash_values: batch,
        }) as { message?: string };
        const m = /(\d+)\s*of\s*\d+\s*records/.exec(result.message ?? "");
        deleted += m ? Number(m[1]) : batch.length;
        process.stdout.write(`\r  Deleting ${deleted}/${ids.length} (${Math.round((deleted / ids.length) * 100)}%)`);
      }
      console.log(`\n\n✅ Deleted ${deleted} rows.`);
      console.log("");
      console.log("Note: this is a local-instance delete. Federated peers will keep their copies until");
      console.log("tombstone-based distributed delete lands. Until then, run `flair memory");
      console.log("hygiene --apply` on each peer to fan out.");
    });
}
