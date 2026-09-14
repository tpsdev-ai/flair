/**
 * restore.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair restore`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { resolveAdminUser } from "../lib/auth-resolve.js";
import * as render from "../render.js";
import { existsSync, readFileSync } from "node:fs";

export type RestoreCli = {
  resolveHttpPort: (...args: any[]) => any;
};

let cli: RestoreCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: RestoreCli): void {
  cli = fns;
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

export function register(program: Command): void {
// ─── flair restore ────────────────────────────────────────────────────────────


program
  .command("restore <path>")
  .description("Import a Flair backup archive")
  .option("--merge", "Add/update records without deleting existing (default)")
  .option("--replace", "Delete all existing data for backed-up agents first, then import")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
  .option("--dry-run", "Show what would be imported without making changes")
  .action(async (backupPath: string, opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const adminUser = resolveAdminUser(opts.adminUser);
    const dryRun: boolean = Boolean(opts.dryRun);
    const mode: "merge" | "replace" = opts.replace ? "replace" : "merge";

    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for restore");
      process.exit(1);
    }

    if (!existsSync(backupPath)) {
      console.error(`Error: backup file not found: ${backupPath}`);
      process.exit(1);
    }

    const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
    if (backup.version !== 1) {
      console.error(`Error: unsupported backup version: ${backup.version}`);
      process.exit(1);
    }

    const { agents = [], memories = [], souls = [] } = backup;
    const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

    console.log(`Restoring from: ${backupPath}`);
    console.log(`Mode: ${mode}${dryRun ? " (dry run)" : ""}`);
    console.log(`  Agents:   ${agents.length}`);
    console.log(`  Memories: ${memories.length}`);
    console.log(`  Souls:    ${souls.length}`);

    if (dryRun) {
      console.log("\n✅ Dry run complete — no changes made");
      return;
    }

    async function adminPut(path: string, body: unknown): Promise<void> {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`PUT ${path} failed (${res.status}): ${text}`);
      }
    }

    async function adminDelete(path: string): Promise<void> {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "DELETE",
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(10_000),
      });
      // 404 is fine — already gone
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
      }
    }

    // Replace mode: delete existing data for these agents first
    if (mode === "replace") {
      console.log("\nDeleting existing data (replace mode)...");
      for (const memory of memories) {
        if (memory.id) await adminDelete(`/Memory/${memory.id}`).catch((e) => console.warn(`  warn: ${e.message}`));
      }
      for (const soul of souls) {
        if (soul.id) await adminDelete(`/Soul/${soul.id}`).catch((e) => console.warn(`  warn: ${e.message}`));
      }
    }

    // Restore agents
    console.log("\nRestoring agents...");
    let agentCount = 0;
    for (const agent of agents) {
      try {
        await adminPut(`/Agent/${agent.id}`, agent);
        agentCount++;
      } catch (err: any) {
        console.warn(`  warn: agent ${agent.id}: ${err.message}`);
      }
    }

    // Restore souls before memories: refuseLearnedSoulWrite matches Memory text.
    console.log("Restoring souls...");
    let soulCount = 0;
    for (const soul of souls) {
      try {
        await adminPut(`/Soul/${soul.id}`, soul);
        soulCount++;
      } catch (err: any) {
        console.warn(`  warn: soul ${soul.id}: ${err.message}`);
      }
    }

    console.log("Restoring memories...");
    let memoryCount = 0;
    for (const memory of memories) {
      try {
        await adminPut(`/Memory/${memory.id}`, memory);
        memoryCount++;
      } catch (err: any) {
        console.warn(`  warn: memory ${memory.id}: ${err.message}`);
      }
    }

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, "Restore complete")}`);
    console.log(render.kv("Agents restored", `${render.wrap(render.c.bold, String(agentCount))}${render.wrap(render.c.dim, `/${agents.length}`)}`));
    console.log(render.kv("Memories restored", `${render.wrap(render.c.bold, String(memoryCount))}${render.wrap(render.c.dim, `/${memories.length}`)}`));
    console.log(render.kv("Souls restored", `${render.wrap(render.c.bold, String(soulCount))}${render.wrap(render.c.dim, `/${souls.length}`)}`));
  });

}
