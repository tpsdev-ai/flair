/**
 * rem.ts — `flair rem` command group (flair#1623 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration, action handlers, and group-specific
 * inline helpers (candidate-line format, reflect-error classify, pause
 * sentinel). Shared CLI helpers (api, credential flags, port resolve, …)
 * stay in cli.ts and are bound before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

import { dirname, resolve } from "node:path";
import * as render from "../render.js";
import { isLocalBase, resolveAdminUser, resolveLocalAdminPass } from "../lib/auth-resolve.js";
import type { OpsSearch } from "../rem/restore.js";
import {
  validatePromoteOpts,
  validateRejectOpts,
  decideCandidateAction,
  derivePromotedTags,
  validateHumanReviewerId,
  structuralImbalance,
  hasTerminalPunctuation,
  type SourceMemoryFetch,
} from "../rem/promote-policy.js";
import { resolveHome } from "../lib/home.js";

export {
  validatePromoteOpts,
  validateRejectOpts,
  decideCandidateAction,
  derivePromotedTags,
  derivePromotedVisibility,
  validateHumanReviewerId,
  isMachineReviewerId,
  ADK_SCOPE_TAG_PREFIX,
  CONTINUITY_SCOPE_TAG_PREFIX,
  MACHINE_REVIEWER_PREFIX,
  MACHINE_REVIEWER_ADK_AUTO_PROMOTE,
} from "../rem/promote-policy.js";
export type { SourceMemoryFetch, PromotedTagsDecision } from "../rem/promote-policy.js";

export type RemCli = {
  api: (...args: any[]) => Promise<any>;
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
  applyAdminPassFile: (opts: { adminPass?: string; adminPassFile?: string }) => void;
  addSharedCredentialOptions: (cmd: Command) => Command;
  readPortFromConfig: () => number | null;
  resolveHttpPort: (opts: { port?: string | number; dataDir?: string }, mode?: "address" | "create") => number;
  humanBytes: (n: number) => string;
  relativeTime: (iso: string | null | undefined) => string;
  DEFAULT_PORT: number;
  pkgVersion: string;
};

let cli: RemCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: RemCli): void {
  cli = fns;
}

function api(...args: any[]): Promise<any> {
  return cli.api(...args);
}
function resolveOpsPort(opts: { opsPort?: string | number; port?: string | number }): number {
  return cli.resolveOpsPort(opts);
}
function applyAdminPassFile(opts: { adminPass?: string; adminPassFile?: string }): void {
  cli.applyAdminPassFile(opts);
}
function addSharedCredentialOptions(cmd: Command): Command {
  return cli.addSharedCredentialOptions(cmd);
}
function readPortFromConfig(): number | null {
  return cli.readPortFromConfig();
}
function resolveHttpPort(opts: { port?: string | number; dataDir?: string }, mode: "address" | "create" = "address"): number {
  return cli.resolveHttpPort(opts, mode);
}
function humanBytes(n: number): string {
  return cli.humanBytes(n);
}
function relativeTime(iso: string | null | undefined): string {
  return cli.relativeTime(iso);
}

/**
 * Build the admin-authed ops-API `search_by_conditions` helper shared by the
 * rem commands. `search_by_conditions` is an ops-API operation, not a Harper
 * REST route — Harper's REST dispatcher maps `POST /<table>` to
 * `resource.post()` and never routes a URL suffix, so `/MemoryCandidate/
 * search_by_conditions` 405s. Both the nightly pending-candidate count and
 * the restore-time candidate cleanup must reach the ops port this way.
 * `fetchImpl` is injectable for tests.
 */
export function buildOpsSearch(
  opts: { opsPort: number; adminUser?: string; adminPass: string },
  fetchImpl: typeof fetch = fetch,
): OpsSearch {
  const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${opts.adminPass}`).toString("base64")}`;
  return async (table, conditions, getAttributes) => {
    const res = await fetchImpl(`http://127.0.0.1:${opts.opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "search_by_conditions", schema: "flair", table, operator: "and", conditions, get_attributes: getAttributes }),
    });
    if (!res.ok) throw new Error(`ops API failed (${res.status})`);
    const raw = await res.json() as unknown;
    return Array.isArray(raw) ? raw : ((raw as { results?: any[] })?.results ?? []);
  };
}

// ─── flair rem rapid — pure helpers ──────────────────────────────────────────
// Extracted for testability, same pattern as validatePromoteOpts /
// decideCandidateAction above: the action callback below spawns api() +
// process.exit, which makes it high-effort/low-value to drive directly;
// these two functions are the actual decision logic.

/** One staged-candidate summary line: `[id] claim, truncated to ~80 chars`. */
export function formatCandidateLine(candidate: { id?: string; claim?: string }, maxClaimLen = 80): string {
  const claim = candidate.claim ?? "";
  const truncated = claim.length > maxClaimLen ? `${claim.slice(0, maxClaimLen)}…` : claim;
  return `  [${candidate.id ?? "?"}] ${truncated}`;
}

/**
 * Flag a probable truncated claim for the HUMAN reviewer (flair#1756 slice 2,
 * issue suggestion 3). Returns null when nothing is off; otherwise a short
 * descriptor. This is advisory ONLY — the refusal for structural imbalance
 * lives server-side in decideAutoPromote (the unattended path); a human
 * promote is a legitimate place to look at a fragment and decide.
 *
 * Reports STRUCTURAL imbalance (unbalanced backtick/paren/bracket/brace) and, as
 * a weaker signal, missing terminal punctuation. Neither claims the text is
 * incomplete — a balanced claim can still be a fragment.
 */
export function candidateIncompleteFlag(claim: unknown): string | null {
  // A malformed row can carry a non-string claim; normalize rather than throw,
  // so listing one bad candidate never takes down the whole review surface.
  const text = typeof claim === "string" ? claim : "";
  const imbalance = structuralImbalance(text);
  if (imbalance !== null) return `structurally incomplete (${imbalance}); the unattended auto-promote path refuses this`;
  if (!hasTerminalPunctuation(text)) return "no terminal punctuation — possible fragment";
  return null;
}

/**
 * Classifies a thrown /ReflectMemories execute-mode error for CLI display.
 * `api()` throws `Error(responseBodyText)` for non-2xx responses (see api()
 * above) — the two execute-mode failure bodies are:
 *   503 no-backend:        { error: "No generative backend configured..." }
 *   502 distillation_failed: { error: "distillation_failed", detail: "..." }
 * Any other shape (network errors, the 400/403 actor-resolution errors
 * prompt mode shares) falls back to "other" — printed as a plain message,
 * no docs pointer or retry hint attached since neither applies.
 */
export function describeReflectError(message: string): { kind: "no-backend" | "distillation-failed" | "other"; text: string } {
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object") {
      if (parsed.error === "distillation_failed") {
        return { kind: "distillation-failed", text: String(parsed.detail ?? parsed.error) };
      }
      if (typeof parsed.error === "string" && parsed.error.startsWith("No generative backend configured")) {
        return { kind: "no-backend", text: parsed.error };
      }
      if (typeof parsed.error === "string") {
        return { kind: "other", text: parsed.error };
      }
    }
  } catch {
    // Not a JSON error body — network error, etc. Pass the raw message through.
  }
  return { kind: "other", text: message };
}

const REM_PAUSE_FLAG = resolve(resolveHome(), ".flair", "rem.paused");

function writeRemPauseSentinel(): void {
  const dir = dirname(REM_PAUSE_FLAG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(REM_PAUSE_FLAG, new Date().toISOString() + "\n", { mode: 0o600 });
}

export function register(program: Command): void {
  const DEFAULT_PORT = cli.DEFAULT_PORT;
  const __pkgVersion = cli.pkgVersion;
  // ─── flair rem ───────────────────────────────────────────────────────────────
  // Memory hygiene and reflection: light (NREM), rapid (REM), restorative (deep).

  const rem = program.command("rem").description("Memory hygiene and reflection");

  rem
    .command("light")
    .description("NREM — quick cleanup: delete expired, archive old, consolidate candidates")
    .option("--port <port>", "Harper HTTP port")
    .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
    .option("--dry-run", "Preview changes without applying them")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      const dryRun = !!opts.dryRun;

      console.log(`\n-- rem light${dryRun ? " (dry run)" : ""} --`);
      if (agentId) console.log(`Agent: ${agentId}`);

      try {
        // Step 1: Maintenance — expire + archive
        const maint = await api("POST", "/MemoryMaintenance", {
          ...(agentId ? { agentId } : {}),
          dryRun,
        });

        if (maint.error) {
          console.error(`Maintenance error: ${maint.error}`);
          process.exit(1);
        }

        const s = maint.stats ?? {};
        console.log("\nCleanup");
        console.log(`  Expired (deleted): ${s.expired ?? 0}`);
        console.log(`  Archived (soft):   ${s.archived ?? 0}`);
        console.log(`  Total scanned:     ${s.total ?? 0}`);
        if (s.errors) console.log(`  Errors:            ${s.errors}`);

        // Step 2: Consolidation candidates
        if (!agentId) {
          console.log("\nConsolidation skipped — no agent ID (pass --agent or set FLAIR_AGENT_ID)");
          return;
        }

        const consol = await api("POST", "/ConsolidateMemories", {
          agentId,
          scope: "all",
        });

        if (consol.error) {
          console.error(`Consolidation error: ${consol.error}`);
          process.exit(1);
        }

        const candidates = consol.candidates ?? [];
        const promote = candidates.filter((c: any) => c.suggestion === "promote");
        const archive = candidates.filter((c: any) => c.suggestion === "archive");

        console.log("\nConsolidation candidates");
        console.log(`  Promote: ${promote.length}`);
        console.log(`  Archive: ${archive.length}`);

        if (promote.length > 0) {
          console.log("\n  Promote:");
          for (const c of promote) {
            console.log(`    [${c.memory?.id ?? "?"}] ${c.reason}`);
          }
        }
        if (archive.length > 0) {
          console.log("\n  Archive:");
          for (const c of archive) {
            console.log(`    [${c.memory?.id ?? "?"}] ${c.reason}`);
          }
        }

        console.log(`\nDone.${dryRun ? " No changes applied (dry run)." : ""}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
  // ─── flair rem rapid ──────────────────────────────────────────────────────────
  // Executes by default (§3C, issue #707): distills server-side via /ReflectMemories execute:true and
  // stages MemoryCandidate rows, printing a staged-candidate summary. --prompt-only
  // preserves the pre-#710 handoff behavior byte-for-byte, for the bring-your-
  // own-model workflow.

  rem
    .command("rapid")
    .description("REM — reflection/learning: distill recent memories into staged candidates")
    .option("--port <port>", "Harper HTTP port")
    .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
    .option("--focus <type>", "lessons_learned | patterns | decisions | errors", "lessons_learned")
    .option("--since <date>", "ISO timestamp lower bound (default: 24h ago)")
    .option("--prompt-only", "Return the reflection prompt instead of executing (pre-#710 handoff behavior)")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("Error: --agent <id> or FLAIR_AGENT_ID env required");
        process.exit(1);
      }

      console.log(`\n-- rem rapid --`);
      console.log(`Agent: ${agentId}  Focus: ${opts.focus}`);

      const body: Record<string, any> = {
        agentId,
        focus: opts.focus,
      };
      if (opts.since) body.since = opts.since;

      if (opts.promptOnly) {
        // --prompt-only: EXACT pre-#710 behavior — prompt-return mode, unchanged.
        try {
          const result = await api("POST", "/ReflectMemories", body);

          if (result.error) {
            console.error(`Reflection error: ${result.error}`);
            process.exit(1);
          }

          console.log(`\nSource memories: ${result.count ?? 0}`);
          if (result.suggestedTags?.length) {
            console.log(`Tags: ${result.suggestedTags.join(", ")}`);
          }

          console.log("\n--- Reflection Prompt ---");
          console.log(result.prompt ?? "(no prompt returned)");
          console.log("--- End Prompt ---\n");
          console.log("Feed the prompt above to your LLM, then write insights back with:");
          console.log("  flair memory add --agent <id> --content <insight> --durability persistent --derived-from <source-ids>");
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        return;
      }

      // Default: execute mode — distill server-side, stage candidates.
      try {
        const result = await api("POST", "/ReflectMemories", { ...body, execute: true });
        const candidates: any[] = Array.isArray(result.candidates) ? result.candidates : [];

        console.log(`\nModel:      ${result.model ?? "?"}`);
        console.log(`Candidates: ${result.count ?? candidates.length}`);
        if (candidates.length > 0) {
          console.log();
          for (const c of candidates) console.log(formatCandidateLine(c));
        }
        console.log(`\nreview: flair rem candidates / flair rem promote <id>`);
      } catch (err: any) {
        const desc = describeReflectError(err.message ?? String(err));
        if (desc.kind === "no-backend") {
          console.error(`Reflection error: ${desc.text}`);
          console.error(`See docs/rem.md#configuration for how to point Flair at a models: backend.`);
        } else if (desc.kind === "distillation-failed") {
          console.error(`Reflection error: distillation failed — ${desc.text}`);
          console.error(`Retry, or run with --prompt-only for the manual handoff.`);
        } else {
          console.error(`Error: ${desc.text}`);
        }
        process.exit(1);
      }
    });

  rem
    .command("restorative")
    .description("Deep audit: full maintenance + consolidation (olderThan=7d) + reflection")
    .option("--port <port>", "Harper HTTP port")
    .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
    .option("--dry-run", "Preview maintenance changes without applying them")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      const dryRun = !!opts.dryRun;

      console.log(`\n== rem restorative${dryRun ? " (dry run)" : ""} ==`);
      if (agentId) console.log(`Agent: ${agentId}`);

      try {
        // Step 1: Maintenance
        console.log("\n[1/3] Maintenance...");
        const maint = await api("POST", "/MemoryMaintenance", {
          ...(agentId ? { agentId } : {}),
          dryRun,
        });

        if (maint.error) {
          console.error(`Maintenance error: ${maint.error}`);
          process.exit(1);
        }

        const s = maint.stats ?? {};
        console.log(`  Expired: ${s.expired ?? 0}  Archived: ${s.archived ?? 0}  Scanned: ${s.total ?? 0}${s.errors ? `  Errors: ${s.errors}` : ""}`);

        // Step 2: Consolidation (skip if no agentId)
        if (agentId) {
          console.log("\n[2/3] Consolidation (scope=all, olderThan=7d)...");
          const consol = await api("POST", "/ConsolidateMemories", {
            agentId,
            scope: "all",
            olderThan: "7d",
          });

          if (consol.error) {
            console.error(`Consolidation error: ${consol.error}`);
            process.exit(1);
          }

          const candidates = consol.candidates ?? [];
          const promote = candidates.filter((c: any) => c.suggestion === "promote");
          const archive = candidates.filter((c: any) => c.suggestion === "archive");

          console.log(`  Promote candidates: ${promote.length}  Archive candidates: ${archive.length}`);
          for (const c of promote) {
            console.log(`    promote [${c.memory?.id ?? "?"}] ${c.reason}`);
          }
          for (const c of archive) {
            console.log(`    archive [${c.memory?.id ?? "?"}] ${c.reason}`);
          }
        } else {
          console.log("\n[2/3] Consolidation skipped — no agent ID");
        }

        // Step 3: Reflection
        if (agentId) {
          console.log("\n[3/3] Reflection (scope=all)...");
          const reflect = await api("POST", "/ReflectMemories", {
            agentId,
            scope: "all",
          });

          if (reflect.error) {
            console.error(`Reflection error: ${reflect.error}`);
            process.exit(1);
          }

          console.log(`  Source memories: ${reflect.count ?? 0}`);
          if (reflect.suggestedTags?.length) {
            console.log(`  Tags: ${reflect.suggestedTags.join(", ")}`);
          }

          console.log("\n--- Reflection Prompt ---");
          console.log(reflect.prompt ?? "(no prompt returned)");
          console.log("--- End Prompt ---");
        } else {
          console.log("\n[3/3] Reflection skipped — no agent ID");
        }

        console.log(`\nRestorative cycle complete.${dryRun ? " No changes applied (dry run)." : ""}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ─── flair rem candidates ─────────────────────────────────────────────────────
  // Slice 1 of FLAIR-NIGHTLY-REM (ops-2qq). Lists staged distillations from the
  // MemoryCandidate table. Empty until the nightly cycle (later slice) starts
  // populating. Per spec § 5: candidates are NEVER auto-promoted; this command
  // is the operator's review surface.

  rem
    .command("candidates")
    .description("List staged memory candidates from the FLAIR-NIGHTLY-REM cycle (pending review)")
    .option("--port <port>", "Harper HTTP port")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
    .option("--status <s>", "Filter by status: pending | promoted | rejected (default: pending)")
    .option("--json", "Output as JSON for scripting")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      const status = opts.status ?? "pending";
      const validStatuses = new Set(["pending", "promoted", "rejected"]);
      if (!validStatuses.has(status)) {
        console.error(`Error: --status must be one of: pending, promoted, rejected (got: ${status})`);
        process.exit(1);
      }

      if (!agentId) {
        console.error(`${render.icons.error} --agent is required (or set FLAIR_AGENT_ID)`);
        process.exit(1);
      }

      const opsPort = resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      if (!adminPass) {
        console.error(`${render.icons.error} --admin-pass or FLAIR_ADMIN_PASS required`);
        process.exit(1);
      }
      const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;

      try {
        const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({
            operation: "search_by_conditions",
            schema: "flair",
            table: "MemoryCandidate",
            operator: "and",
            conditions: [
              { search_attribute: "agentId", search_type: "equals", search_value: agentId },
              { search_attribute: "status", search_type: "equals", search_value: status },
            ],
            get_attributes: ["id", "claim", "generatedBy", "generatedAt", "status", "target", "reviewerId", "decidedAt", "supersedes"],
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(`${render.icons.error} ${res.status} ${text}`);
          process.exit(1);
        }
        const candidates = await res.json() as any[];
        const mode = render.resolveOutputMode(opts);

        if (mode === "json") {
          const annotated = candidates.map((c: any) => ({ ...c, incompleteFlag: candidateIncompleteFlag(c.claim) }));
          console.log(render.asJSON({ agentId, status, count: candidates.length, candidates: annotated }));
          return;
        }

        const statusColor = status === "promoted" ? render.c.green : status === "rejected" ? render.c.red : render.c.yellow;
        console.log(
          `${render.wrap(render.c.bold, "REM candidates")}  ${render.wrap(render.c.dim, "—")} agent ${render.wrap(render.c.bold, agentId)} ${render.wrap(render.c.dim, "·")} ${render.wrap(statusColor, status)}`,
        );

        if (candidates.length === 0) {
          console.log(`\n${render.icons.info} ${render.wrap(render.c.dim, `No ${status} candidates.`)}`);
          if (status === "pending") {
            console.log(
              `${render.wrap(render.c.dim, "  Run")} flair rem nightly enable ${render.wrap(render.c.dim, "to start the nightly distillation cycle that populates this table.")}`,
            );
          }
          return;
        }

        candidates.sort((a, b) => String(b.generatedAt ?? "").localeCompare(String(a.generatedAt ?? "")));

        console.log();
        for (const c of candidates) {
          let tag: string;
          if (c.status === "promoted") {
            tag = `${render.wrap(render.c.green, "✓ promoted")} ${render.wrap(render.c.dim, "→")} ${render.wrap(render.c.bold, c.target ?? "?")} ${render.wrap(render.c.dim, `by ${c.reviewerId ?? "?"} ${render.relativeTime(c.decidedAt)}`)}`;
          } else if (c.status === "rejected") {
            tag = `${render.wrap(render.c.red, "✗ rejected")} ${render.wrap(render.c.dim, `by ${c.reviewerId ?? "?"} ${render.relativeTime(c.decidedAt)}`)}`;
          } else {
            tag = `${render.wrap(render.c.yellow, "○ pending")} ${render.wrap(render.c.dim, `— ${c.generatedBy ?? "?"} ${render.relativeTime(c.generatedAt)}`)}`;
          }
          console.log(`  ${render.wrap(render.c.dim, c.id)}  ${tag}`);
          console.log(`    ${c.claim}`);
          const incompleteFlag = candidateIncompleteFlag(c.claim);
          if (incompleteFlag) {
            console.log(`    ${render.wrap(render.c.yellow, "⚠ possible incomplete claim")} ${render.wrap(render.c.dim, `— ${incompleteFlag}`)}`);
          }
          if (c.supersedes) {
            console.log(`    ${render.wrap(render.c.dim, `(supersedes ${c.supersedes} — recurring proposal)`)}`);
          }
          console.log("");
        }

        console.log(
          `${render.wrap(render.c.bold, String(candidates.length))} candidate${candidates.length > 1 ? "s" : ""}.`,
        );
        if (status === "pending") {
          console.log(`${render.wrap(render.c.dim, "Promote:")} flair rem promote <id> --rationale "<why>" --to (soul|memory)`);
          console.log(`${render.wrap(render.c.dim, "Reject: ")} flair rem reject <id> --reason "<why>"`);
        }
      } catch (err: any) {
        console.error(`${render.icons.error} ${err.message}`);
        process.exit(1);
      }
    });
  // ─── flair rem promote / reject helpers ──────────────────────────────────────
  // Pure validators extracted for testability. The action callbacks below thread
  // these through process.exit on failure; the helpers themselves are
  // side-effect-free.
  // ─── flair rem promote ───────────────────────────────────────────────────────
  // Slice 2 of FLAIR-NIGHTLY-REM (ops-2qq). Promote a candidate to either Soul
  // or persistent Memory. Both --rationale and --to are required (spec § 5: no
  // rubber-stamp). When --to=soul, --key is also required so the resulting
  // Soul row has a meaningful identifier.
  //
  // Trust-tier policy is enforced by the caller's authentication today (1.0):
  // admin pass → any promote; agent key → can write to own Memory/Soul. Server-
  // side trust-tier enforcement (endorsed agents → memory only, never soul) is
  // scoped for slice 2b when agent-routed promotion lands. For now, the
  // human-operator workflow is the supported path.

  rem
    .command("promote")
    .description("Promote a memory candidate to Soul or persistent Memory (rationale required)")
    .argument("<candidate-id>", "MemoryCandidate id to promote")
    .option("--port <port>", "Harper HTTP port")
    .option("--rationale <text>", "Why this candidate is being promoted (required, no rubber-stamp)")
    .option("--to <target>", "Promotion target: 'soul' or 'memory'")
    .option("--key <key>", "Soul key (required when --to=soul; e.g. 'lessons', 'preference-X')")
    .option("--reviewer <id>", "Reviewer agent id (default: FLAIR_AGENT_ID or 'admin')")
    .action(async (candidateId: string, opts: any) => {
      const validationErr = validatePromoteOpts(opts);
      if (validationErr) {
        console.error(`Error: ${validationErr}`);
        process.exit(1);
      }
      const reviewerId = opts.reviewer || process.env.FLAIR_AGENT_ID || "admin";
      // The human promote path must not record a reserved machine reviewerId
      // (Sherlock #4): that would launder automated attribution.
      const reviewerErr = validateHumanReviewerId(reviewerId);
      if (reviewerErr) {
        console.error(`Error: ${reviewerErr}`);
        process.exit(1);
      }

      try {
        if (opts.to === "memory") {
          const promoted = await api("POST", "/PromoteMemoryCandidate", {
            candidateId, rationale: opts.rationale,
            ...(opts.reviewer ? { reviewerId: opts.reviewer } : {}),
          });
          if (promoted?.error) throw new Error(promoted.error);
          console.log(`✅ Wrote Memory ${promoted.memoryId} (durability=persistent)`);
          console.log(`✅ Candidate ${candidateId} marked promoted → memory, reviewer=${promoted.reviewerId}`);
          return;
        }
        // Fetch the candidate
        const candidate = await api("GET", `/MemoryCandidate/${encodeURIComponent(candidateId)}`);
        const candidateData = (candidate && !candidate.error) ? candidate : null;
        const decision = decideCandidateAction(candidateData, "promote");
        if (!decision.ok) {
          const msg: string = (decision as { ok: false; message: string }).message;
          console.error(`Error: candidate ${candidateId} ${msg}`);
          process.exit(1);
        }

        // ADK tag-lineage: derive the promoted-claim tag set.
        //
        // #1205b-1: if the engine stamped an authoritative `scopeTag` on the
        // candidate (scope:"tagged" distillation), consume it DIRECTLY and skip
        // the source re-read — correctness no longer depends on the source
        // memories still being readable (the #1205a seam closure). We only fall
        // back to re-reading sources when there is NO stamp (a pre-#1205b
        // candidate, or a non-tagged distillation).
        const stampedScopeTag: string | undefined =
          typeof candidate.scopeTag === "string" && candidate.scopeTag.length > 0 ? candidate.scopeTag : undefined;
        const sourceFetches: SourceMemoryFetch[] = [];
        if (!stampedScopeTag) {
          // No authoritative stamp — re-read sources to classify. Fail-closed for
          // ADK-sourced candidates whose per-user scope tag can't be confirmed;
          // unchanged for non-ADK candidates. See derivePromotedTags for rules.
          const sourceIds: string[] = Array.isArray(candidate.sourceMemoryIds) ? candidate.sourceMemoryIds : [];
          for (const sid of sourceIds) {
            try {
              const mem = await api("GET", `/Memory/${encodeURIComponent(String(sid))}`);
              if (mem && !mem.error) {
                sourceFetches.push({ ok: true, tags: Array.isArray(mem.tags) ? mem.tags : [] });
              } else {
                sourceFetches.push({ ok: false });
              }
            } catch {
              sourceFetches.push({ ok: false });
            }
          }
        }
        const tagDecision = derivePromotedTags(candidateId, sourceFetches, stampedScopeTag);
        if (!tagDecision.ok) {
          console.error(`Error: candidate ${candidateId} — ${(tagDecision as { ok: false; reason: string }).reason}`);
          process.exit(1);
        }
        // Soul entries are agentId-scoped and cannot carry a per-user scope tag,
        // so an ADK-sourced candidate promoted to Soul is a cross-user leak by
        // construction — fail closed here and again on Soul.post/put so a
        // scripted PUT /Soul cannot bypass the CLI.
        if (opts.to === "soul" && (tagDecision as { adkSourced?: boolean }).adkSourced) {
          console.error(
            `Error: candidate ${candidateId} is ADK-sourced (scope tag ${tagDecision.tags[0]}); Soul is agentId-scoped and cannot carry a per-user scope tag — refusing to promote to Soul (would leak across users). Promote ADK-sourced candidates to memory.`,
          );
          process.exit(1);
        }
        const promotedTags = tagDecision.tags;

        const decidedAt = new Date().toISOString();

        // Memory promotion is handled by the server workflow above.
        const soulId = `${candidate.agentId}-${opts.key}`;
        const soulWrite = await api("PUT", `/Soul/${encodeURIComponent(soulId)}`, {
          id: soulId,
          agentId: candidate.agentId,
          key: opts.key,
          value: candidate.claim,
          priority: "standard",
          durability: "persistent",
          createdAt: decidedAt,
          updatedAt: decidedAt,
        });
        if (soulWrite?.error) {
          console.error(`Error writing Soul: ${soulWrite.error}`);
          process.exit(1);
        }
        console.log(`✅ Wrote Soul ${soulId} (key=${opts.key})`);
        // Update the candidate row
        const upd = await api("PUT", `/MemoryCandidate/${encodeURIComponent(candidateId)}`, {
          ...candidate,
          status: "promoted",
          target: opts.to,
          reviewerId,
          reviewRationale: opts.rationale,
          decidedAt,
        });
        if (upd?.error) {
          console.error(`Warning: candidate row update returned: ${upd.error}`);
        }
        console.log(`✅ Candidate ${candidateId} marked promoted → ${opts.to}, reviewer=${reviewerId}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ─── flair rem reject ────────────────────────────────────────────────────────
  // Reject a candidate with a required --reason. Per spec § 5, rejected
  // candidates retain full decision history so recurring proposals are visible
  // via the supersedes chain.

  rem
    .command("reject")
    .description("Reject a memory candidate with a required reason")
    .argument("<candidate-id>", "MemoryCandidate id to reject")
    .option("--port <port>", "Harper HTTP port")
    .option("--reason <text>", "Why this candidate is being rejected (required)")
    .option("--reviewer <id>", "Reviewer agent id (default: FLAIR_AGENT_ID or 'admin')")
    .action(async (candidateId: string, opts: any) => {
      const validationErr = validateRejectOpts(opts);
      if (validationErr) {
        console.error(`Error: ${validationErr}`);
        process.exit(1);
      }
      const reviewerId = opts.reviewer || process.env.FLAIR_AGENT_ID || "admin";

      try {
        const candidate = await api("GET", `/MemoryCandidate/${encodeURIComponent(candidateId)}`);
        const candidateData = (candidate && !candidate.error) ? candidate : null;
        const decision = decideCandidateAction(candidateData, "reject");
        if (!decision.ok) {
          const _d = decision as { ok: false; severity: "error" | "info"; message: string };
          if (_d.severity === "info") {
            console.log(`(candidate ${candidateId} ${_d.message})`);
            return;
          }
          console.error(`Error: candidate ${candidateId} ${_d.message}`);
          process.exit(1);
        }

        const decidedAt = new Date().toISOString();
        const upd = await api("PUT", `/MemoryCandidate/${encodeURIComponent(candidateId)}`, {
          ...candidate,
          status: "rejected",
          reviewerId,
          reviewRationale: opts.reason,
          decidedAt,
        });
        if (upd?.error) {
          console.error(`Error: candidate row update failed: ${upd.error}`);
          process.exit(1);
        }
        console.log(`✅ Candidate ${candidateId} rejected by ${reviewerId}`);
        console.log(`   Reason: ${opts.reason}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ─── flair rem nightly run-once ──────────────────────────────────────────────
  // Slice 1 of FLAIR-NIGHTLY-REM § 3. Manually invokes the nightly cycle code
  // path — same module the scheduler will call in PR-2. Useful for:
  //   - First-time operators verifying the cycle works before turning on the
  //     scheduled timer.
  //   - The dry-run-first-run guard (spec § 10) when the scheduler isn't yet
  //     installed.
  //   - Debugging a stale snapshot or audit row.
  //
  // `nightly enable` / `disable` / `status` land in PR-2 (scheduler templates).

  const remNightly = rem.command("nightly").description("Scheduled REM nightly cycle (manual trigger + scheduler management)");

  // `enable` / `disable` / `status` — scheduler install/uninstall (slice-1 PR-2).
  // macOS: writes ~/Library/LaunchAgents/dev.flair.rem.nightly.plist and bootstraps it.
  // Linux: writes ~/.config/systemd/user/flair-rem-nightly.{timer,service} and enables the timer.
  // Snapshot data and the audit log are preserved through enable/disable cycles.

  remNightly
    .command("enable")
    .description("Install the nightly scheduler (launchd on macOS, systemd timer on Linux)")
    .option("--agent <id>", "Agent id (or FLAIR_AGENT_ID env)")
    .option("--at <HH:MM>", "Local time to run nightly (default 03:00)", "03:00")
    .option("--flair-url <url>", "Flair HTTP URL the runner will hit (default http://127.0.0.1:<port>)")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("Error: --agent or FLAIR_AGENT_ID env required");
        process.exit(1);
      }
      const match = /^(\d{1,2}):(\d{2})$/.exec(opts.at);
      if (!match) {
        console.error(`Error: --at must be HH:MM (got: ${opts.at})`);
        process.exit(1);
      }
      const hour = parseInt(match[1], 10);
      const minute = parseInt(match[2], 10);

      const port = readPortFromConfig() ?? DEFAULT_PORT;
      const flairUrl = opts.flairUrl || process.env.FLAIR_URL || `http://127.0.0.1:${port}`;

      const { enableScheduler, formatEnableReport } = await import("../rem/scheduler.js");
      try {
        const r = enableScheduler({ agentId, flairUrl, hour, minute });
        // formatEnableReport() owns the success-vs-failure decision (flair#850:
        // do not print a success headline before activation is known to have
        // succeeded) — see src/rem/scheduler.ts for the unit-tested logic.
        const { lines, ok } = formatEnableReport(r, { hour, minute, agentId, flairUrl });
        for (const line of lines) console.log(line);
        if (!ok) process.exit(1);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  remNightly
    .command("disable")
    .description("Remove the nightly scheduler (keeps snapshots + audit log)")
    .option("--remove-shim", "Also delete the ~/.flair/bin/flair-rem-nightly shim")
    .action(async (opts: any) => {
      const { disableScheduler } = await import("../rem/scheduler.js");
      try {
        const r = disableScheduler({ removeShim: !!opts.removeShim });
        if (r.removed.length === 0) {
          console.log(`(REM nightly scheduler was not installed on ${r.platform})`);
          return;
        }
        console.log(`✅ REM nightly scheduler disabled (${r.platform})`);
        console.log(`   Removed:`);
        for (const p of r.removed) console.log(`     ${p}`);
        if (r.unloadResult && r.unloadResult.code !== 0) {
          console.log(`   Unload:      ${r.unloadCommand.join(" ")} → code ${r.unloadResult.code}`);
          if (r.unloadResult.stderr) console.log(`     stderr: ${r.unloadResult.stderr.trim()}`);
        }
        console.log(`\nSnapshots at ~/.flair/snapshots/ and the audit log at`);
        console.log(`~/.flair/logs/rem-nightly.jsonl are preserved.`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  remNightly
    .command("status")
    .description("Show whether the nightly scheduler is installed and genuinely active")
    .action(async () => {
      const { schedulerStatus, formatStatusReport } = await import("../rem/scheduler.js");
      try {
        const s = schedulerStatus();
        const { lines } = formatStatusReport(s);
        for (const line of lines) console.log(line);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  remNightly
    .command("run-once")
    .description("Run one nightly cycle now (snapshot + log). Same code path the scheduler will use.")
    .option("--agent <id>", "Agent id (or FLAIR_AGENT_ID env)")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--dry-run", "Log the row but skip the snapshot write")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("Error: --agent or FLAIR_AGENT_ID env required");
        process.exit(1);
      }
      const { runNightlyCycle } = await import("../rem/runner.js");
      // The runner is agent-authed and cannot reach the ops port itself. When
      // admin credentials are available, inject an ops-API `search_by_conditions`
      // helper so the pending-candidate count can be sampled; otherwise the count
      // is best-effort 0 (the cycle still runs).
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      const opsSearch = adminPass
        ? buildOpsSearch({ opsPort: resolveOpsPort(opts), adminUser: opts.adminUser, adminPass })
        : undefined;
      try {
        const healthBase = (process.env.FLAIR_URL || `http://127.0.0.1:${resolveHttpPort({})}`).replace(/\/+$/, "");
        const result = await runNightlyCycle({
          agentId,
          flairVersion: __pkgVersion,
          apiCall: api,
          opsSearch,
          dryRun: !!opts.dryRun,
          healthProbe: async (timeoutMs) => {
            const t = Date.now();
            try {
              const res = await fetch(`${healthBase}/Health`, { signal: AbortSignal.timeout(timeoutMs) });
              if (!res.ok) {
                return { ok: false, elapsedMs: Date.now() - t, error: `GET /Health returned HTTP ${res.status}` };
              }
              return { ok: true, elapsedMs: Date.now() - t };
            } catch (err: any) {
              return { ok: false, elapsedMs: Date.now() - t, error: err?.message ?? String(err) };
            }
          },
        });
        const row = result.logRow;
        console.log(`-- rem nightly run-once${opts.dryRun ? " (dry-run)" : ""} --`);
        console.log(`Agent:      ${agentId}`);
        console.log(`Status:     ${result.status}`);
        if (result.snapshotPath) {
          console.log(`Snapshot:   ${result.snapshotPath}`);
        }
        console.log(`Memories:   ${row.memoryCount ?? "—"}`);
        console.log(`Souls:      ${row.soulCount ?? "—"}`);
        console.log(`Pending:    ${row.pendingCandidates ?? "—"}`);
        if (typeof row.archived === "number" || typeof row.expired === "number") {
          console.log(`Archived:   ${row.archived ?? "—"}`);
          console.log(`Expired:    ${row.expired ?? "—"}`);
        }
        // row.candidates populates when step 5 (distillation) was attempted
        // this cycle — see src/rem/runner.ts. Absent when dry-run skipped it.
        if (row.candidates) {
          console.log(`Staged:     ${row.candidates.length} candidate${row.candidates.length === 1 ? "" : "s"}`);
        }
        if (row.distill) {
          const remaining = Math.max(0, row.distill.unreflected - row.distill.gathered);
          console.log(`Distilled:  ${row.distill.gathered} memor${row.distill.gathered === 1 ? "y" : "ies"} (cap ${row.distill.maxMemories}; ${remaining} unreflected remaining)`);
          if (row.distill.aborted) console.log(`Aborted:    yes — in-flight distillation stopped (flair rem pause)`);
        }
        // row.autoPromoted populates when step 5b (#1205b-2 ADK auto-promote) ran
        // this cycle — i.e. a non-dry-run cycle for an ADK agentId.
        if (row.autoPromoted) {
          console.log(`Auto-promoted: ${row.autoPromoted.promoted} to own memory (${row.autoPromoted.skipped} left pending)`);
        }
        // row.dedup populates when step 6 (instance-wide dedup-cluster stat,
        // flair-quality Slice 1c) succeeded this cycle. Absent on dry-run skip
        // or a non-fatal failure (see Errors below — e.g. non-admin caller).
        if (row.dedup) {
          console.log(`Dedup:      ${row.dedup.clusterCount} cluster${row.dedup.clusterCount === 1 ? "" : "s"} (${row.dedup.totalMemoriesInClusters} memories, largest ${row.dedup.largestClusterSize})`);
        }
        console.log(`Duration:   ${row.durationMs}ms`);
        if (result.status === "refused") {
          console.log(`\nNote: REM refused to start because /Health could not be served.`);
          console.log(`Restore /Health before retrying, or \`flair rem pause\` to stop the scheduler.`);
        }
        if (row.errors.length > 0) {
          console.log(`Errors:`);
          for (const e of row.errors) console.log(`  - ${e}`);
          process.exit(1);
        }
        if (result.status === "paused") {
          console.log(`\nNote: REM is paused (sentinel ~/.flair/rem.paused or FLAIR_REM_PAUSE env).`);
          console.log(`Resume with: flair rem resume`);
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ─── flair rem snapshot list ─────────────────────────────────────────────────
  // Slice 1 of FLAIR-NIGHTLY-REM (ops-2qq). Lists snapshot tarballs under
  // ~/.flair/snapshots/<agent>/. Snapshot creation lives inside the nightly
  // runner (and exposed via `flair rem nightly run-once`) — there is no
  // user-facing `rem snapshot create` because that would invite operators to
  // create snapshots out of sync with the audit log. The list is the surface.

  const remSnapshot = rem.command("snapshot").description("REM nightly snapshots (tar.gz archives of agent memory + soul)");

  remSnapshot
    .command("list")
    .description("List REM snapshots for an agent (or all agents)")
    .option("--agent <id>", "Filter to a single agent")
    .option("--json", "Output as JSON")
    .action(async (opts: any) => {
      const { listSnapshots } = await import("../rem/snapshot.js");
      const rows = listSnapshots(opts.agent);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("(no REM snapshots — ~/.flair/snapshots/ is empty or absent)");
        console.log("\nSnapshots are produced by the nightly cycle. Run `flair rem nightly run-once`");
        console.log("to generate one manually (slice 1).");
        return;
      }
      const agentW = Math.max(5, ...rows.map((r) => r.agent.length));
      const fileW = Math.max(20, ...rows.map((r) => r.file.length));
      console.log(`  ${"agent".padEnd(agentW)}  ${"file".padEnd(fileW)}  size      age`);
      for (const r of rows) {
        console.log(`  ${r.agent.padEnd(agentW)}  ${r.file.padEnd(fileW)}  ${humanBytes(r.size).padEnd(8)}  ${relativeTime(r.mtime)}`);
      }
      console.log(`\n${rows.length} snapshot${rows.length > 1 ? "s" : ""}.`);
    });

  // ─── flair rem restore <date> ────────────────────────────────────────────────
  // Slice 1 + 2 of FLAIR-NIGHTLY-REM § 9.
  //
  // Default (no --apply): filesystem-only extract for inspection. Writes
  //   memories.jsonl / soul.json / metadata.json to a target directory.
  //   Harper state is unchanged.
  //
  // --apply: live replay. Reads the snapshot contents, takes a pre-restore
  //   snapshot of the agent's CURRENT state (so this restore is itself
  //   reversible), then DELETEs current memories/souls for the agent and PUTs
  //   the snapshot's rows back. Per-row failures are captured per-row; the
  //   pre-restore snapshot's path is reported so operator can roll back if
  //   something goes wrong mid-flight.
  //
  // The <date> argument is an ISO-timestamp prefix or date-only prefix; the
  // command picks the latest snapshot matching that prefix.

  addSharedCredentialOptions(rem.command("restore <date>"))
    .description("Restore from a REM snapshot (inspect by default; --apply rewinds Harper state)")
    .option("--agent <id>", "Agent id (or FLAIR_AGENT_ID env)")
    .option("--target <dir>", "Directory to extract into (default: <snapshot>.restored, only used without --apply)")
    .option("--dry-run", "Plan-only — list contents or planned counts without writing")
    .option("--apply", "Live replay: rewind Harper state to the snapshot (irreversible without the pre-restore snapshot)")
    .action(async (date: string, opts: any) => {
      const { listSnapshots, extractSnapshot } = await import("../rem/snapshot.js");
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("Error: --agent or FLAIR_AGENT_ID env required");
        process.exit(1);
      }
      let rows;
      try {
        rows = listSnapshots(agentId);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      const matches = rows.filter((r) => r.file.startsWith(date));
      if (matches.length === 0) {
        console.error(`Error: no snapshot found for agent '${agentId}' matching date '${date}'`);
        if (rows.length > 0) {
          console.error(`  Available: ${rows.slice(0, 5).map((r) => r.file.replace(/\.tar\.gz$/, "")).join(", ")}`);
        } else {
          console.error(`  No snapshots exist for ${agentId}. Run \`flair rem nightly run-once\` to create one.`);
        }
        process.exit(1);
      }
      // listSnapshots returns descending by mtime, so matches[0] is the newest
      // snapshot for the date prefix.
      const match = matches[0];

      // --apply path: live replay via src/rem/restore.ts
      if (opts.apply) {
        const { applySnapshot } = await import("../rem/restore.js");
        applyAdminPassFile(opts);
        const restoreBase = process.env.FLAIR_URL || `http://127.0.0.1:${resolveHttpPort({})}`;
        // Candidates are only reachable through the ops port (Harper has no
        // REST search_by_conditions route), so the dry-run candidate count
        // needs admin creds too. Dry-run treats credential resolution as
        // best-effort — a plan-only command must not fail on a bad credential
        // file — while --apply requires creds (Soul rewrite) and fails loudly.
        let adminPass: string | undefined;
        try {
          adminPass = resolveLocalAdminPass(opts.adminPass, !isLocalBase(restoreBase));
        } catch (err: any) {
          if (!opts.dryRun) throw err;
          adminPass = undefined;
        }
        if (!opts.dryRun && !adminPass) {
          console.error(
            "Error: --admin-pass, --admin-pass-file, or FLAIR_ADMIN_PASS required for rem restore --apply " +
              "(Soul rewrite is operator-only; an agent key is refused).",
          );
          process.exit(1);
        }
        const opsSearch = adminPass
          ? buildOpsSearch({ opsPort: resolveOpsPort(opts), adminUser: opts.adminUser, adminPass })
          : undefined;
        const soulApiCall = adminPass
          ? (method: string, path: string, body?: unknown) =>
              api(method, path, body, { explicitAdminPass: adminPass, adminUser: opts.adminUser, agentId: null })
          : undefined;
        try {
          const result = await applySnapshot({
            agentId,
            snapshotPath: match.path,
            flairVersion: __pkgVersion,
            apiCall: api,
            opsSearch,
            soulApiCall,
            dryRun: !!opts.dryRun,
          });
          const verb = opts.dryRun ? "(dry-run) would" : "";
          console.log(`${opts.dryRun ? "(dry-run) " : ""}flair rem restore --apply${opts.dryRun ? "" : ""}`);
          console.log(`  Status:       ${result.status}`);
          console.log(`  Snapshot:     ${match.path}`);
          if (result.preRestoreSnapshotPath) {
            console.log(`  Pre-restore:  ${result.preRestoreSnapshotPath}`);
            console.log(`                (rollback: flair rem restore <pre-restore-date> --agent ${agentId} --apply)`);
          }
          console.log(`  Deleted:      ${result.deleted.memories} memories, ${result.deleted.souls} souls, ${result.deleted.candidates} candidates`);
          console.log(`  Restored:     ${result.restored.memories} memories, ${result.restored.souls} souls`);
          if (result.errors.length > 0) {
            console.log(`  Errors:`);
            for (const e of result.errors) console.log(`    - ${e}`);
          }
          if (result.status === "failed") process.exit(1);
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        return;
      }

      // Default: filesystem extract.
      try {
        const result = await extractSnapshot({
          snapshotPath: match.path,
          targetDir: opts.target,
          dryRun: !!opts.dryRun,
        });
        if (opts.dryRun) {
          console.log(`(dry-run) snapshot: ${match.path}`);
          for (const e of result.entries) {
            console.log(`  ${e.path}  (${humanBytes(e.size)})`);
          }
          return;
        }
        console.log(`✅ Extracted: ${match.path}`);
        console.log(`   To:        ${result.targetDir}`);
        for (const e of result.entries) {
          console.log(`     ${e.path}  (${humanBytes(e.size)})`);
        }
        console.log(`\nNote: this is a filesystem extract — Harper state is unchanged.`);
        console.log(`To actually rewind state, re-run with --apply.`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
  // ─── flair rem pause / resume ────────────────────────────────────────────────
  // Slice 1 of FLAIR-NIGHTLY-REM § 9. The pause sentinel is checked by the
  // nightly runner before any side effects. Env-var FLAIR_REM_PAUSE=1 is also
  // honored — lets ops pause fleet-wide without writing a file.
  // #1515: the same sentinel aborts an in-flight /ReflectMemories gather on
  // the Harper host (checked between yield points) so an operator can stop a
  // runaway run without restarting Harper.
  rem
    .command("pause")
    .description("Pause nightly REM runs and abort an in-flight distillation gather")
    .action(() => {
      writeRemPauseSentinel();
      console.log(`✅ REM nightly runs paused (sentinel: ${REM_PAUSE_FLAG})`);
      console.log(`   In-flight distillation will abort at the next yield.`);
      console.log(`   Resume with: flair rem resume`);
    });

  rem
    .command("abort")
    .description("Abort an in-flight REM distillation (same sentinel as pause)")
    .action(() => {
      writeRemPauseSentinel();
      console.log(`✅ REM abort requested (sentinel: ${REM_PAUSE_FLAG})`);
      console.log(`   In-flight distillation will stop at the next yield; the scheduler stays paused.`);
      console.log(`   Resume with: flair rem resume`);
    });

  rem
    .command("resume")
    .description("Resume nightly REM runs — removes the pause sentinel")
    .action(() => {
      if (existsSync(REM_PAUSE_FLAG)) {
        rmSync(REM_PAUSE_FLAG);
        console.log(`✅ REM nightly runs resumed (removed ${REM_PAUSE_FLAG})`);
      } else {
        console.log(`(REM was not paused — no sentinel at ${REM_PAUSE_FLAG})`);
      }
      if (process.env.FLAIR_REM_PAUSE === "1") {
        console.log(`\n⚠ FLAIR_REM_PAUSE=1 env var is also set; unset it to fully resume.`);
      }
    });
}
