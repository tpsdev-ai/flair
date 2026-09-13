/**
 * relationship.ts — `flair relationship` command group (flair#1634 /
 * epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. Owns the `relationship`
 * commander registration and its `add` handler: an ergonomic agent-directed
 * write surface for the Relationship graph (explicit subject/predicate/object
 * triples), distinct from free-text Memory.
 *
 * canonicalRelationshipId (and its header comment) moved verbatim. It is a
 * deliberate LOCAL copy of flair-client's RelationshipApi.write() id algorithm
 * — the CLI can't import that workspace package into the published bundle.
 * test/unit/cli-relationship-add.test.ts pins the two to identical output by
 * spawning the real CLI, so this copy must stay byte-for-byte equivalent.
 *
 * Shared cli.ts-local helpers are injected via bindCli() so this module never
 * imports src/cli.ts (avoids the import cycle and keeps it inside the strict
 * tsconfig.check.src.json set). Top-level imports only — no require() (#1653).
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 */
import { Command } from "commander";
import { createHash } from "node:crypto";

export type RelationshipCli = {
  api: (method: string, path: string, body?: any, options?: any) => Promise<any>;
  resolveSigningAgentId: (opts: { agent?: string }, command?: string) => any;
};

let cli: RelationshipCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: RelationshipCli): void {
  cli = fns;
}

const api = (method: string, path: string, body?: any, options?: any): Promise<any> =>
  cli.api(method, path, body, options);
const resolveSigningAgentId = (opts: { agent?: string }, command?: string): any =>
  cli.resolveSigningAgentId(opts, command);

// ─── flair relationship add ──────────────────────────────────────────────────
//
// Ergonomic agent-directed write surface for the Relationship graph
// (relationship-write-path spec): an explicit subject/predicate/object triple
// ("record that <subject> <predicate> <object>"), distinct from a free-text
// Memory. Mirrors `flair memory add`'s shape (--agent required, signed via
// the shared `api()` helper — see api()'s doc above for the Ed25519
// resolution order) rather than hand-rolling a signer, per this repo's
// existing convention (flair orgevent does hand-roll one because OrgEvent.put()
// self-verifies authorId against the signature; Relationship doesn't need that
// — the server stamps agentId from the verdict regardless of what's sent).
//
// PUTs to the CANONICAL id (see canonicalRelationshipId below), not a random
// one — re-running this command with the SAME subject/predicate/object
// UPSERTS the existing row (confidence/validTo/source refresh) instead of
// creating a duplicate. This mirrors flair-client's RelationshipApi.write()
// (packages/flair-client/src/client.ts) BYTE FOR BYTE — the CLI can't import
// that workspace package into the published @tpsdev-ai/flair bundle (same
// reasoning as the existing Memory-id-generation mirroring a few thousand
// lines up), so the algorithm is duplicated here rather than shared. A
// cross-check test (test/unit/cli-relationship-add.test.ts) pins the two
// implementations to identical output so they can't silently drift apart —
// a drift here would mean the CLI and the MCP tool/RelationshipApi land the
// SAME triple at TWO different ids, defeating the whole dedup guarantee.
function canonicalRelationshipId(agentId: string, subject: string, predicate: string, object: string): string {
  const material = [agentId, subject, predicate, object].join("\u0000").toLowerCase();
  return createHash("sha256").update(material, "utf8").digest().subarray(0, 16).toString("base64url");
}

/** Register the `flair relationship` command group (flair#1634). */
export function register(program: Command): void {

  const relationship = program.command("relationship").description("Manage agent relationship triples (knowledge graph)");
  relationship.command("add")
    .description(
      "Record that <subject> <predicate> <object> — an explicit entity-to-entity relationship triple. " +
      "Re-asserting the SAME triple (same subject/predicate/object) UPSERTS the existing row rather than " +
      "duplicating it. Predicate is free text; recommended vocabulary: manages, works_on, reviews, depends_on, " +
      "replaces, owns, reports_to, advises. To CONTRADICT a prior relationship: changing the predicate creates " +
      "a SEPARATE row and does NOT auto-close the old one — re-assert the OLD triple with --valid-to set to now " +
      "(or delete it) before/after writing the new one.",
    )
    .requiredOption("--agent <id>")
    .requiredOption("--subject <text>", "Source entity (e.g. 'nathan')")
    .requiredOption("--predicate <text>", "Relationship type, free text (e.g. 'manages')")
    .requiredOption("--object <text>", "Target entity (e.g. 'flair')")
    .option("--confidence <n>", "0.0-1.0, how certain (default 1.0 = explicitly stated)")
    .option("--valid-from <iso>", "ISO timestamp this relationship became true (default: now)")
    .option("--valid-to <iso>", "ISO timestamp this relationship ended (leave unset for an active relationship)")
    .option("--source <text>", "Where this was learned from (a memory ID, conversation, etc.)")
    .action(async (opts) => {
      const { agentId, source } = resolveSigningAgentId(opts, "relationship add");
      const id = canonicalRelationshipId(opts.agent, opts.subject, opts.predicate, opts.object);
      const body: Record<string, unknown> = {
        id,
        agentId: opts.agent,
        subject: opts.subject,
        predicate: opts.predicate,
        object: opts.object,
      };
      if (opts.confidence !== undefined) body.confidence = Number(opts.confidence);
      if (opts.validFrom) body.validFrom = opts.validFrom;
      if (opts.validTo) body.validTo = opts.validTo;
      if (opts.source) body.source = opts.source;
      const out = await api("PUT", `/Relationship/${id}`, body, { agentId, agentIdSource: source });
      console.log(JSON.stringify(out, null, 2));
    });
}
