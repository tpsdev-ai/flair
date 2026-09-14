/**
 * test.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair test` (end-to-end memory round-trip probe).
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import * as render from "../render.js";

export type TestCli = {
  api: (...args: any[]) => any;
  resolveBaseUrl: (...args: any[]) => any;
};

let cli: TestCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: TestCli): void {
  cli = fns;
}

function api(...args: any[]): any {
  return cli.api(...args);
}

function resolveBaseUrl(...args: any[]): any {
  return cli.resolveBaseUrl(...args);
}

export function register(program: Command): void {
// ─── flair test ───────────────────────────────────────────────────────────────


program
  .command("test")
  .description("Verify the full Flair stack: write, search, and delete a test memory")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const agentId = opts.agent ?? process.env.FLAIR_AGENT_ID;
    if (!agentId && !process.env.FLAIR_ADMIN_PASS) {
      console.error(`${render.icons.error} ${render.wrap(render.c.red, "set --agent / FLAIR_AGENT_ID or FLAIR_ADMIN_PASS")}`);
      process.exit(1);
    }

    // Single source of truth (flair#1351): banner prints the URL the test's
    // own client uses. resolveBaseUrl is the existing CLI resolver; pass the
    // same value through to api() so the two cannot diverge.
    const baseUrl = resolveBaseUrl(opts);
    console.log(`\n${render.wrap(render.c.bold, "Flair test")} ${render.wrap(render.c.dim, `(url: ${baseUrl})`)}\n`);

    let passed = 0;
    let failed = 0;
    let memoryId: string | null = null;

    const check = async (name: string, fn: () => Promise<boolean>) => {
      try {
        const ok = await fn();
        if (ok) {
          console.log(`  ${render.icons.ok} ${render.wrap(render.c.green, "PASS")} ${name}`);
          passed++;
        } else {
          console.log(`  ${render.icons.error} ${render.wrap(render.c.red, "FAIL")} ${name}`);
          failed++;
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`  ${render.icons.error} ${render.wrap(render.c.red, "FAIL")} ${name}: ${render.wrap(render.c.dim, message?.slice(0, 120))}`);
        failed++;
      }
    };

    // 1. Write a test memory via PUT /Memory/<id>.
    // Schema only exposes PUT — POST returns 'Memory does not have a post method implemented'.
    await check("Write test memory (PUT /Memory/<id>)", async () => {
      const id = `flair-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const body: Record<string, any> = {
        id,
        content: "flair test \u2014 this will be deleted",
        durability: "ephemeral",
        createdAt: new Date().toISOString(),
      };
      if (agentId) body.agentId = agentId;
      await api("PUT", `/Memory/${id}`, body, { baseUrl });
      memoryId = id;
      return true;
    });

    // 2. Search for the test memory via POST /SemanticSearch
    await check("Search for test memory (POST /SemanticSearch)", async () => {
      await new Promise(r => setTimeout(r, 1500)); // allow indexing
      const body: Record<string, any> = { q: "flair test", limit: 5 };
      if (agentId) body.agentId = agentId;
      const result = await api("POST", "/SemanticSearch", body, { baseUrl });
      return (result?.results?.length ?? 0) > 0;
    });

    // 3. Delete the test memory via DELETE /Memory/<id>
    await check("Delete test memory (DELETE /Memory/<id>)", async () => {
      if (!memoryId) {
        // If write returned ok without an id, skip deletion cleanly
        console.log(`       (skipped — no id returned from write step)`);
        return true;
      }
      await api("DELETE", `/Memory/${memoryId}`, agentId ? { agentId } : undefined, { baseUrl });
      return true;
    });

    const passColor = passed > 0 ? render.c.green : render.c.dim;
    const failColor = failed > 0 ? render.c.red : render.c.dim;
    console.log(`\n  ${render.wrap(passColor, `${passed} passed`)} ${render.wrap(render.c.dim, "·")} ${render.wrap(failColor, `${failed} failed`)}`);
    if (failed > 0) process.exit(1);
  });

}
