/**
 * presence.ts — `flair presence` command group (flair#1633 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. Owns the `presence`
 * commander registration and the `presence set` handler (The Office Space:
 * POST /Presence).
 *
 * VALID_PRESENCE_ACTIVITIES / MAX_TASK_LENGTH are exported so src/cli.ts can
 * keep re-exporting them from its "Exported for testing" surface unchanged.
 *
 * Shared cli.ts-local helpers are injected via bindCli() so this module never
 * imports src/cli.ts (avoids the import cycle and keeps it inside the strict
 * tsconfig.check.src.json set). No fs require() — top-level imports only
 * (flair#1653).
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 */
import { Command } from "commander";
import { resolveKeyPath, buildEd25519Auth } from "../lib/auth-resolve.js";

export type PresenceCli = {
  resolveBaseUrl: (opts: { target?: string; url?: string; port?: string | number }) => string;
  resolveSigningAgentId: (opts: { agent?: string }, command?: string) => any;
};

let cli: PresenceCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: PresenceCli): void {
  cli = fns;
}

const resolveBaseUrl = (opts: { target?: string; url?: string; port?: string | number }): string =>
  cli.resolveBaseUrl(opts);
const resolveSigningAgentId = (opts: { agent?: string }, command?: string): any =>
  cli.resolveSigningAgentId(opts, command);

// ─── flair presence ─────────────────────────────────────────────────────────

export const VALID_PRESENCE_ACTIVITIES = ["coding", "reviewing", "planning", "debugging", "idle"] as const;
export const MAX_TASK_LENGTH = 120;


/** Register the `flair presence` command group (flair#1633). */
export function register(program: Command): void {
  const presence = program.command("presence").description("Manage agent presence (The Office Space)");

  presence
    .command("set")
    .description("Set your agent's current activity and task (POST /Presence)")
    .option("--activity <activity>", `Activity type (${VALID_PRESENCE_ACTIVITIES.join("|")})`)
    .option("--task <text>", "Short description of what you're working on")
    .option("--agent <id>", "Agent ID (env: FLAIR_AGENT_ID)")
    .option("--port <port>", "Harper HTTP port")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
    .action(async (opts) => {
      const { agentId } = resolveSigningAgentId(opts, "presence set");
      if (!agentId) {
        console.error("Error: agent ID required. Pass --agent <id> or set FLAIR_AGENT_ID environment variable.");
        process.exit(1);
      }

      // Validate activity
      if (!opts.activity) {
        console.error("Error: --activity is required.");
        process.exit(1);
      }
      const activity = opts.activity as string;
      if (!VALID_PRESENCE_ACTIVITIES.includes(activity as any)) {
        console.error(`Error: invalid activity '${activity}'. Must be one of: ${VALID_PRESENCE_ACTIVITIES.join(", ")}`);
        process.exit(1);
      }

      // Validate task length
      const task = opts.task ?? undefined;
      if (task && task.length > MAX_TASK_LENGTH) {
        console.error(`Error: --task exceeds ${MAX_TASK_LENGTH} character limit (got ${task.length}).`);
        process.exit(1);
      }

      // Resolve key path
      const keyPath = resolveKeyPath(agentId);
      if (!keyPath) {
        console.error(`Error: private key not found for agent '${agentId}'. Check ~/.flair/keys/ or set FLAIR_KEY_DIR.`);
        process.exit(1);
      }

      // Build auth + POST
      const baseUrl = resolveBaseUrl(opts).replace(/\/$/, "");
      const auth = buildEd25519Auth(agentId, "POST", "/Presence", keyPath);
      const body: Record<string, string> = { activity };
      if (task) body.currentTask = task;

      const res = await fetch(`${baseUrl}/Presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: POST /Presence failed (${res.status}): ${text}`);
        process.exit(1);
      }

      const data = await res.json().catch(() => null);
      console.log(`✓ Presence updated for '${agentId}': activity=${activity}${task ? `, task="${task}"` : ""}`);
      if (data?.presenceStatus) {
        console.log(`  Status: ${data.presenceStatus}`);
      }
    });
}
