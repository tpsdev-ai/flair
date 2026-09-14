/**
 * attention.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair attention` (attention queue query). The runCli() entry point deliberately stays in cli.ts.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { buildEd25519Auth, resolveKeyPath } from "../lib/auth-resolve.js";
import * as render from "../render.js";

export type AttentionCli = {
  resolveBaseUrl: (...args: any[]) => any;
  resolveSigningAgentId: (...args: any[]) => any;
};

let cli: AttentionCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: AttentionCli): void {
  cli = fns;
}

function resolveBaseUrl(...args: any[]): any {
  return cli.resolveBaseUrl(...args);
}

function resolveSigningAgentId(...args: any[]): any {
  return cli.resolveSigningAgentId(...args);
}

function describeAttentionRow(source: string, r: any): string {
  const dim = (s: string) => render.wrap(render.c.dim, s);
  const day = (iso: unknown) => (typeof iso === "string" ? iso.slice(0, 10) : "");
  switch (source) {
    case "memory":
      return `${r.content ? String(r.content).replace(/\s+/g, " ").slice(0, 100) : "(no content)"} ${dim(`[${r.agentId} · ${day(r.createdAt)}]`)}`;
    case "relationship":
      return `${r.subject} —${r.predicate}→ ${r.object} ${dim(`[${r.agentId} · ${day(r.createdAt)}]`)}`;
    case "workspaceState":
      return `${r.summary ?? r.ref} ${dim(`[${r.agentId}${r.phase ? ` · ${r.phase}` : ""} · ${String(r.timestamp ?? "").slice(0, 16).replace("T", " ")}]`)}`;
    case "presence":
      return `${r.currentTask} ${dim(`[${r.displayName ?? r.agentId}${r.activity ? ` · ${r.activity}` : ""}]`)}`;
    case "orgEvent":
      return `${r.summary} ${dim(`[${r.authorId} · ${r.kind} · ${day(r.createdAt)}]`)}`;
    default:
      return JSON.stringify(r);
  }
}


export function register(program: Command): void {
// ─── flair attention ─────────────────────────────────────────────────────────
//
// Entity-scoped attention query (flair#677). "What's touching entity E in the
// last N days?" — a unified, grouped-by-source view across Memory,
// Relationship, WorkspaceState, Presence, and OrgEvent (POST /AttentionQuery,
// resources/AttentionQuery.ts). Read-only; signed the same way `flair search`
// signs POST /SemanticSearch. Entity must be a vocabulary string (exact
// type:value match — resources/entity-vocab.ts); the server 400s anything
// malformed.

/** Render one attention-result row for its source group — human-readable mode only. */

program
  .command("attention <entity>")
  .description("What's touching entity E in the last N days? Grouped view across memory/relationship/workspace/presence/orgevent (POST /AttentionQuery)")
  .option("--days <n>", "Window size in days (default 7)")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--key <path>", "Ed25519 private key path")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
  .option("--json", "Output raw JSON")
  .action(async (entity, opts) => {
    try {
      const { agentId } = resolveSigningAgentId(opts, "attention");
      if (!agentId) {
        console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
        process.exit(2);
      }

      const payload: Record<string, unknown> = { entity };
      if (opts.days !== undefined) {
        const n = Number.parseInt(opts.days, 10);
        if (!Number.isFinite(n) || n <= 0) {
          console.error("error: --days must be a positive integer");
          process.exit(2);
        }
        payload.days = n;
      }

      const baseUrl = resolveBaseUrl(opts);
      const headers: Record<string, string> = { "content-type": "application/json" };
      const keyPath = opts.key || resolveKeyPath(agentId);
      if (keyPath) {
        headers["authorization"] = buildEd25519Auth(agentId, "POST", "/AttentionQuery", keyPath);
      }

      const res = await fetch(`${baseUrl}/AttentionQuery`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      const result = text ? JSON.parse(text) : {};

      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(result));
        return;
      }

      const groups: Record<string, any[]> = result.groups ?? {};
      const counts: Record<string, number> = result.counts ?? {};
      console.log(
        `${render.icons.info} Attention: ${render.wrap(render.c.bold, result.entity ?? entity)} ` +
        `${render.wrap(render.c.dim, `(last ${result.windowDays ?? payload.days ?? 7}d, since ${result.since ?? "?"})`)}`,
      );
      console.log(render.wrap(render.c.dim, `total: ${counts.total ?? 0}`));
      console.log();

      const sections: Array<{ key: string; label: string }> = [
        { key: "memory", label: "Memory" },
        { key: "relationship", label: "Relationship" },
        { key: "workspaceState", label: "Workspace" },
        { key: "presence", label: "Presence" },
        { key: "orgEvent", label: "OrgEvent" },
      ];

      for (const { key, label } of sections) {
        const rows: any[] = Array.isArray(groups[key]) ? groups[key] : [];
        console.log(`${render.wrap(render.c.bold, label)} ${render.wrap(render.c.dim, `(${rows.length})`)}`);
        if (rows.length === 0) {
          console.log(`  ${render.wrap(render.c.dim, "—")}`);
          console.log();
          continue;
        }
        for (const r of rows) {
          console.log(`  ${describeAttentionRow(key, r)}`);
        }
        console.log();
      }
    } catch (err: any) {
      console.error(`${render.icons.error} Attention query failed: ${err.message}`);
      process.exit(1);
    }
  });

}
