/**
 * bootstrap.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair bootstrap`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { authedRequest } from "../lib/auth-resolve.js";
import * as render from "../render.js";

export type BootstrapCli = {
  resolveBaseUrl: (...args: any[]) => any;
  resolveSigningAgentId: (...args: any[]) => any;
};

let cli: BootstrapCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: BootstrapCli): void {
  cli = fns;
}

function resolveBaseUrl(...args: any[]): any {
  return cli.resolveBaseUrl(...args);
}

function resolveSigningAgentId(...args: any[]): any {
  return cli.resolveSigningAgentId(...args);
}

export function register(program: Command): void {
// ─── flair bootstrap ─────────────────────────────────────────────────────────
//
// `flair bootstrap` prints agent context (soul, memories) and a structured budget
// footer summarizing token usage and memory inclusion/truncation. The footer is
// parseable for downstream agents to react to budget pressure.
//
// Budget footer format (printed to stderr):
//   [budget: <used>/<max> tokens, <included> included, <truncated> truncated]
//
// Fields:
//   - tokens: estimated tokens used / max budget
//   - included: number of memories/soul entries included in context
//   - truncated: number of memories excluded due to token budget
//
// When truncated &gt; 0, the agent should consider asking for more context or reducing scope.


program
  .command("bootstrap")
  .description("Cold-start context: get soul + recent memories as formatted text")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--max-tokens <n>", "Maximum tokens in output", "4000")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
  .option("--key <path>", "Ed25519 private key path")
  .option("--json", "Emit JSON {context, tokenEstimate, memoriesIncluded, ...} (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (opts) => {
    const { agentId, source } = resolveSigningAgentId(opts, "bootstrap");
    if (!agentId) {
      console.error(`${render.icons.error} --agent <id> required (or set FLAIR_AGENT_ID)`);
      process.exit(2);
    }
    const baseUrl = resolveBaseUrl(opts);
    const mode = render.resolveOutputMode(opts);
    try {
      // flair#747: routed through the shared resolver — --key is an
      // explicit tier-1 override (as before), now additionally backstopped
      // by env admin-pass / ~/.flair/admin-pass / the Ed25519 floor if
      // neither --key nor the agent's own resolveKeyPath(agentId) lookup
      // finds a usable key. Previously this only ever tried Ed25519 (no
      // admin fallback at all) and sent NO Authorization header when no key
      // was found, relying on Harper's local passthrough.
      const result = (await authedRequest("POST", "/BootstrapMemories",
        { agentId, maxTokens: parseInt(opts.maxTokens, 10) },
        { baseUrl, agentId, agentIdSource: source, explicitKeyPath: opts.key },
      )) as any;

      if (mode === "json") {
        // Agent-first: emit the full server response, augmented with the cap
        // that was requested. Includes context, sections, tokenEstimate, etc.
        console.log(render.asJSON({ ...result, maxTokens: parseInt(opts.maxTokens, 10) }));
        return;
      }

      // Human mode: print context to stdout, budget footer to stderr (parseable).
      if (result.context) {
        console.log(result.context);
      } else {
        console.error(`${render.icons.error} No context available.`);
        process.exit(1);
      }
      // flair#1199 — the budget footer reflects the PROSE the human injects
      // (stdout = result.context), not the full serialized payload. tokenEstimate
      // now measures the whole response (structured containers + prose), which
      // the CLI's structured fields the human doesn't read would inflate.
      const tokensUsed = typeof result.context === "string" && result.context.length > 0
        ? Math.ceil(result.context.length / 4)
        : (result.tokenEstimate ?? 0);
      const maxTokens = parseInt(opts.maxTokens, 10);
      const included = result.memoriesIncluded ?? 0;
      const truncated = result.memoriesTruncated ?? 0;
      const tokenPct = maxTokens > 0 ? (tokensUsed / maxTokens) * 100 : 0;
      const tokenIcon = tokenPct >= 90 ? render.icons.warn : tokenPct >= 70 ? render.icons.info : render.icons.ok;
      const truncIcon = truncated > 0 ? render.icons.warn : render.icons.ok;
      console.error(
        `${tokenIcon} budget ${tokensUsed}/${maxTokens} tokens (${tokenPct.toFixed(0)}%) ${render.icons.bullet} ${render.icons.ok} ${included} included ${render.icons.bullet} ${truncIcon} ${truncated} truncated`,
      );
    } catch (err: any) {
      console.error(`${render.icons.error} Bootstrap failed: ${err.message}`);
      process.exit(1);
    }
  });

}
