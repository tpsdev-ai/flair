/**
 * orgevent.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair orgevent` (Kris #510 signed OrgEvent publisher) plus the shared publishOrgEvent() write shape reused by `flair quality --emit`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { buildEd25519Auth, resolveKeyPath } from "../lib/auth-resolve.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type OrgeventCli = {
  parseEntitiesOptionOrExit: (...args: any[]) => any;
  resolveBaseUrl: (...args: any[]) => any;
  resolveSigningAgentId: (...args: any[]) => any;
  ENTITIES_OPTION_DESCRIPTION: any;
};

let cli: OrgeventCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: OrgeventCli): void {
  cli = fns;
}

function parseEntitiesOptionOrExit(...args: any[]): any {
  return cli.parseEntitiesOptionOrExit(...args);
}

function resolveBaseUrl(...args: any[]): any {
  return cli.resolveBaseUrl(...args);
}

function resolveSigningAgentId(...args: any[]): any {
  return cli.resolveSigningAgentId(...args);
}

export const MAX_ORGEVENT_SUMMARY_LENGTH = 500;

export const MAX_ORGEVENT_DETAIL_LENGTH = 8000;


interface PublishOrgEventParams {
  agentId: string;
  baseUrl: string;
  kind: string;
  summary: string;
  detail?: string;
  scope?: string;
  targetIds?: string[];
  /** Validated entity vocabulary strings (flair#1288) — callers validate before passing. */
  entities?: string[];
}
// Flat `{ ok: boolean; ...optional }` shape — same convention
// RecallSpotCheckFetchResult uses above, deliberately NOT a `{ok:true}|
// {ok:false}` literal union: this file's tsconfig.cli.json runs with
// `strict: false` (no strictNullChecks), under which TS's control-flow
// narrowing on a boolean-literal discriminant doesn't reliably eliminate
// the other union member (confirmed against this exact tsconfig — a real
// TS behavior, not a hypothetical). `id`/`error` are optional instead;
// callers branch on `ok` and read whichever field the contract guarantees
// is set for that branch.

interface PublishOrgEventResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * The ONE write shape behind `flair orgevent` — signed PUT /OrgEvent/{id} —
 * extracted so `flair quality --emit` (flair-quality Slice 2) reuses the
 * exact same call, rather than hand-rolling a second one. Everything below
 * mirrors what the `orgevent` command's action used to do inline: id
 * convention (`${agentId}-${randomUUID()}`, matching flair-client's
 * Memory.write()), the same Ed25519 signing (buildEd25519Auth), the same
 * length guards (MAX_ORGEVENT_SUMMARY_LENGTH/MAX_ORGEVENT_DETAIL_LENGTH) so
 * every caller — CLI flag or programmatic — gets them, and the same
 * authorId self-declaration OrgEvent.put() verifies server-side against the
 * signature (see the module doc above `orgevent`). Never throws — every
 * failure mode (missing key, oversized field, non-2xx response) returns
 * `{ ok: false, error }` for the caller to surface however fits its own UX.
 */

export async function publishOrgEvent(params: PublishOrgEventParams): Promise<PublishOrgEventResult> {
  if (params.summary.length > MAX_ORGEVENT_SUMMARY_LENGTH) {
    return { ok: false, error: `summary exceeds ${MAX_ORGEVENT_SUMMARY_LENGTH} character limit (got ${params.summary.length})` };
  }
  if (params.detail && params.detail.length > MAX_ORGEVENT_DETAIL_LENGTH) {
    return { ok: false, error: `detail exceeds ${MAX_ORGEVENT_DETAIL_LENGTH} character limit (got ${params.detail.length})` };
  }

  const keyPath = resolveKeyPath(params.agentId);
  if (!keyPath) {
    return { ok: false, error: `private key not found for agent '${params.agentId}'. Check ~/.flair/keys/ or set FLAIR_KEY_DIR.` };
  }

  const id = `${params.agentId}-${randomUUID()}`;
  const auth = buildEd25519Auth(params.agentId, "PUT", `/OrgEvent/${id}`, keyPath);

  const body: Record<string, unknown> = {
    id,
    authorId: params.agentId,
    kind: params.kind,
    summary: params.summary,
    createdAt: new Date().toISOString(),
  };
  if (params.detail) body.detail = params.detail;
  if (params.scope) body.scope = params.scope;
  if (params.targetIds && params.targetIds.length > 0) body.targetIds = params.targetIds;
  if (params.entities && params.entities.length > 0) body.entities = params.entities;

  const res = await fetch(`${params.baseUrl}/OrgEvent/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `PUT /OrgEvent/${id} failed (${res.status}): ${text}` };
  }

  const data = await res.json().catch(() => null);
  return { ok: true, id: data?.id ?? id };
}


export function register(program: Command): void {
  const ENTITIES_OPTION_DESCRIPTION = cli.ENTITIES_OPTION_DESCRIPTION;

// ─── flair orgevent ──────────────────────────────────────────────────────────
//
// Coordination write surface (Kris #510). `orgevent` publishes an
// OrgEvent ATTRIBUTED to the authenticated agent via a signed PUT
// /OrgEvent/{id}. authorId is asserted in the body but self-verified server
// side: OrgEvent.put() (resources/OrgEvent.ts) 403s any authorId that doesn't
// match the Ed25519 signature's agentId, so an agent still cannot forge
// another agent's events — the difference from post() is that put() checks-
// and-rejects a mismatch rather than silently overwriting it.
//
// (flair#679, measured against a real spawned Harper): table-backed resources
// only accept writes via PUT /<Table>/<id> — a bare POST /OrgEvent 405s
// ("does not have a post method implemented to handle HTTP method POST"),
// same restriction documented in resources/Memory.ts and already fixed for
// `soul set` (#498). OrgEvent.ts DOES define a post() method that
// auto-generates id/createdAt, but Harper's REST layer never routes a real
// HTTP POST to it — post() is only reachable via in-process resource
// instantiation, never the wire. put() does NOT default id/createdAt, so the
// CLI generates and supplies them itself (id convention mirrors flair-client's
// Memory.write(): `${agentId}-${randomUUID()}`).


program
  .command("orgevent")
  .description("Publish an org-wide coordination event attributed to your agent (PUT /OrgEvent/{id})")
  .requiredOption("--kind <kind>", "Event kind (e.g. coord.claim, coord.release, status)")
  .requiredOption("--summary <text>", "Short summary of the event")
  .option("--detail <text>", "Longer detail payload")
  .option("--scope <scope>", "Scope of the event (e.g. an agent id, repo, or 'org')")
  .option("--target <agentId>", "Recipient agent id (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  .option("--entities <csv>", ENTITIES_OPTION_DESCRIPTION)
  .option("--agent <id>", "Agent ID (env: FLAIR_AGENT_ID)")
  .option("--port <port>", "Harper HTTP port")
  .option("--target-url <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .action(async (opts) => {
    const { agentId } = resolveSigningAgentId(opts, "orgevent");
    if (!agentId) {
      console.error("Error: agent ID required. Pass --agent <id> or set FLAIR_AGENT_ID environment variable.");
      process.exit(1);
    }

    // orgevent reuses --target for recipients, so the remote-URL override is
    // --target-url here (env FLAIR_TARGET still honored via resolveBaseUrl).
    const baseUrl = resolveBaseUrl({ target: opts.targetUrl, port: opts.port }).replace(/\/$/, "");
    const targetIds = Array.isArray(opts.target) && opts.target.length > 0 ? (opts.target as string[]) : undefined;

    // flair#1288: validate --entities before any key/network work; exits 1
    // with the canonical format-and-type-set message on any malformed value.
    const entities = opts.entities ? parseEntitiesOptionOrExit(String(opts.entities)) : undefined;

    const result = await publishOrgEvent({
      agentId,
      baseUrl,
      kind: opts.kind,
      summary: opts.summary,
      detail: opts.detail,
      scope: opts.scope,
      targetIds,
      entities,
    });

    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    const targets = targetIds ? ` → ${targetIds.join(", ")}` : "";
    console.log(`✓ OrgEvent published as '${agentId}': kind=${opts.kind}${targets}`);
    console.log(`  id: ${result.id}`);
  });

}
