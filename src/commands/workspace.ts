/**
 * workspace.ts — `flair workspace` command group (flair#1635 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. Owns the `workspace`
 * commander registration and its `set` handler (The Office Space):
 * `workspace set` writes the agent's OWN WorkspaceState via a signed
 * PUT /WorkspaceState/{id} (deterministic id `agentId:ref`).
 *
 * Shared CLI helpers (resolveBaseUrl, resolveSigningAgentId, and the shared
 * `--entities <csv>` parse/description also used by `memory add` / `orgevent`)
 * stay in cli.ts and are bound via bindCli() before register(). This module
 * never imports src/cli.ts (avoids the import cycle and keeps it inside the
 * strict tsconfig.check.src.json set). Top-level imports only — no require()
 * (#1653).
 *
 * MAX_WORKSPACE_FIELD_LENGTH is exported so cli.ts can keep re-exporting it
 * from its "Exported for testing" surface unchanged.
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 */
import { Command } from "commander";
import { resolveKeyPath, buildEd25519Auth } from "../lib/auth-resolve.js";
import type { ResolvedSigningIdentity } from "../lib/signing-identity.js";

export type WorkspaceCli = {
  resolveBaseUrl: (opts: { target?: string; url?: string; port?: string | number }) => string;
  resolveSigningAgentId: (opts: { agent?: string }, command?: string) => ResolvedSigningIdentity;
  parseEntitiesOptionOrExit: (csv: string) => string[];
  ENTITIES_OPTION_DESCRIPTION: string;
};

let cli: WorkspaceCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: WorkspaceCli): void {
  cli = fns;
}

function resolveBaseUrl(opts: { target?: string; url?: string; port?: string | number }): string {
  return cli.resolveBaseUrl(opts);
}
function resolveSigningAgentId(opts: { agent?: string }, command?: string): ResolvedSigningIdentity {
  return cli.resolveSigningAgentId(opts, command);
}
function parseEntitiesOptionOrExit(csv: string): string[] {
  return cli.parseEntitiesOptionOrExit(csv);
}

// ─── flair workspace ─────────────────────────────────────────────────────────
//
// Coordination write surface (Kris #510). `workspace set` writes the
// agent's OWN WorkspaceState via a signed PUT /WorkspaceState/{id}. Identity
// is asserted by including agentId in the body — the server never trusts it
// blindly, it 403s any mismatch against the Ed25519 signature's agentId
// (WorkspaceState.put(), resources/WorkspaceState.ts), so this is a
// self-declaration the server verifies 1:1, not attribution-from-body.
//
// (flair#679, measured against a real spawned Harper): table-backed resources
// only accept writes via PUT /<Table>/<id> — a bare POST /WorkspaceState 405s
// ("does not have a post method implemented to handle HTTP method POST"),
// same restriction documented in resources/Memory.ts and already fixed for
// `soul set` (#498). WorkspaceState.ts DOES define a post() method, but
// Harper's REST layer never routes a real HTTP POST to it — post() is only
// reachable via in-process resource instantiation, never the wire. put(),
// unlike post(), does NOT default createdAt/timestamp/agentId — the CLI
// supplies them all explicitly below.

export const MAX_WORKSPACE_FIELD_LENGTH = 2000;

/** Register the `flair workspace` command group (flair#1635). */
export function register(program: Command): void {
  const ENTITIES_OPTION_DESCRIPTION = cli.ENTITIES_OPTION_DESCRIPTION;

  const workspace = program.command("workspace").description("Manage agent workspace state (The Office Space)");

  workspace
    .command("set")
    .description("Set your agent's current workspace state (PUT /WorkspaceState/{id})")
    .requiredOption("--ref <ref>", "Workspace ref (branch, worktree, or task ref)")
    .option("--label <text>", "Human-readable label for this workspace")
    .option("--provider <name>", "Provider/runtime (e.g. claude-code, openclaw)", "cli")
    .option("--task <id>", "Task/issue id this workspace is attached to")
    .option("--phase <phase>", "Current phase (e.g. design, implement, review)")
    .option("--summary <text>", "Short summary of current workspace state")
    .option("--entities <csv>", ENTITIES_OPTION_DESCRIPTION)
    .option("--agent <id>", "Agent ID (env: FLAIR_AGENT_ID)")
    .option("--port <port>", "Harper HTTP port")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
    .action(async (opts) => {
      const { agentId } = resolveSigningAgentId(opts, "workspace set");
      if (!agentId) {
        console.error("Error: agent ID required. Pass --agent <id> or set FLAIR_AGENT_ID environment variable.");
        process.exit(1);
      }

      // Validate field lengths (free text → cap to bound the write).
      for (const [name, val] of [["ref", opts.ref], ["label", opts.label], ["summary", opts.summary]] as const) {
        if (val && String(val).length > MAX_WORKSPACE_FIELD_LENGTH) {
          console.error(`Error: --${name} exceeds ${MAX_WORKSPACE_FIELD_LENGTH} character limit (got ${String(val).length}).`);
          process.exit(1);
        }
      }

      // flair#1288: validate --entities before any key/network work; exits 1
      // with the canonical format-and-type-set message on any malformed value.
      const entities = opts.entities ? parseEntitiesOptionOrExit(String(opts.entities)) : undefined;

      const keyPath = resolveKeyPath(agentId);
      if (!keyPath) {
        console.error(`Error: private key not found for agent '${agentId}'. Check ~/.flair/keys/ or set FLAIR_KEY_DIR.`);
        process.exit(1);
      }

      const baseUrl = resolveBaseUrl(opts).replace(/\/$/, "");
      // Deterministic id (agentId:ref) — re-running `workspace set` for the same
      // ref overwrites the same record, which is intentional (one row per
      // agent+ref, not an append log).
      const id = `${agentId}:${opts.ref}`;
      const auth = buildEd25519Auth(agentId, "PUT", `/WorkspaceState/${id}`, keyPath);

      // agentId IS included in the body now — WorkspaceState.put() (unlike
      // post()) does not auto-attribute from the signature, it 403s any
      // mismatch. This is a self-declaration the server verifies against the
      // signature, not a forgeable claim.
      const now = new Date().toISOString();
      const body: Record<string, unknown> = {
        id,
        agentId,
        ref: opts.ref,
        provider: opts.provider ?? "cli",
        timestamp: now,
        createdAt: now,
      };
      if (opts.label) body.label = opts.label;
      if (opts.task) body.taskId = opts.task;
      if (opts.phase) body.phase = opts.phase;
      if (opts.summary) body.summary = opts.summary;
      if (entities && entities.length > 0) body.entities = entities;

      const res = await fetch(`${baseUrl}/WorkspaceState/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: PUT /WorkspaceState/${id} failed (${res.status}): ${text}`);
        process.exit(1);
      }

      console.log(`✓ Workspace state updated for '${agentId}': ref=${opts.ref}${opts.phase ? `, phase=${opts.phase}` : ""}`);
    });
}
