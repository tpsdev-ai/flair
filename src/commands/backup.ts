/**
 * backup.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair backup`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { resolveAdminUser } from "../lib/auth-resolve.js";
import { flairBackupOutputPath } from "../lib/flair-paths.js";
import * as render from "../render.js";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BackupCli = {
  addSharedCredentialOptions: (...args: any[]) => any;
  applyAdminPassFile: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
};

let cli: BackupCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: BackupCli): void {
  cli = fns;
}

function addSharedCredentialOptions(...args: any[]): any {
  return cli.addSharedCredentialOptions(...args);
}

function applyAdminPassFile(...args: any[]): any {
  return cli.applyAdminPassFile(...args);
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

export function register(program: Command): void {
// ─── flair backup ────────────────────────────────────────────────────────────


addSharedCredentialOptions(
  program
    .command("backup")
    .description("Export agents, memories, and souls to a JSON archive")
    .option("--output <path>", "Output file path (default: ~/.flair/backups/flair-backup-<timestamp>.json)")
    .option("--agents <ids>", "Comma-separated agent IDs to include (default: all)")
    .option("--port <port>", "Harper HTTP port")
    .option("--url <url>", "Flair base URL (overrides --port)"),
).action(async (opts: any) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    applyAdminPassFile(opts);
    // Env is a second-class fallback after the explicit flags (same order
    // backup used before the shared helper). FLAIR_ADMIN_PASS is still
    // accepted so existing scripts keep working.
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const adminUser = resolveAdminUser(opts.adminUser);

    if (!adminPass) {
      console.error("Error: --admin-pass, --admin-pass-file, or FLAIR_ADMIN_PASS required for backup");
      process.exit(1);
    }

    // flair#968: `flair backup > file.json` captures the progress report, not
    // the archive (which goes to --output, defaulting to ~/.flair/backups/...).
    // The result was exit 0 and a plausible-looking file of a few hundred bytes —
    // a false success immediately before a destructive upgrade.
    //
    // When stdout is not a TTY, route progress output to stderr. The archive
    // still goes to --output / the default path. This makes `flair backup >
    // file.json` produce an EMPTY file — unmistakably not a valid archive —
    // while leaving default-path callers (schedulers, cron) completely
    // unaffected.
    const log = process.stdout.isTTY
      ? console.log.bind(console)
      : console.error.bind(console);

    const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

    async function adminGet(path: string): Promise<any> {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GET ${path} failed (${res.status}): ${text}`);
      }
      return res.json();
    }

    log("Fetching agents...");
    const allAgents: any[] = await adminGet("/Agent/");
    const filterIds = opts.agents ? opts.agents.split(",").map((s: string) => s.trim()) : null;
    const agents: any[] = filterIds ? allAgents.filter((a: any) => filterIds.includes(a.id)) : allAgents;

    log(`Fetching memories for ${agents.length} agent(s)...`);
    const memories: any[] = [];
    for (const agent of agents) {
      try {
        const agentMemories = await adminGet(`/Memory/?agentId=${encodeURIComponent(agent.id)}`);
        if (Array.isArray(agentMemories)) memories.push(...agentMemories);
      } catch (err: any) {
        console.warn(`  Warning: could not fetch memories for ${agent.id}: ${err.message}`);
      }
    }

    log("Fetching souls...");
    const souls: any[] = [];
    for (const agent of agents) {
      try {
        const agentSouls = await adminGet(`/Soul/?agentId=${encodeURIComponent(agent.id)}`);
        if (Array.isArray(agentSouls)) souls.push(...agentSouls);
      } catch (err: any) {
        console.warn(`  Warning: could not fetch souls for ${agent.id}: ${err.message}`);
      }
    }

    const backup = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: baseUrl,
      agents,
      memories,
      souls,
    };

    // Determine output path
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultOutput = flairBackupOutputPath(timestamp);
    const outputPath: string = opts.output ?? defaultOutput;
    mkdirSync(join(outputPath, ".."), { recursive: true });

    const tmp = outputPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(backup, null, 2) + "\n", "utf-8");
    renameSync(tmp, outputPath);

    log(`\n${render.icons.ok} ${render.wrap(render.c.green, "Backup complete")}`);
    log(render.kv("Agents", render.wrap(render.c.bold, String(agents.length))));
    log(render.kv("Memories", render.wrap(render.c.bold, String(memories.length))));
    log(render.kv("Souls", render.wrap(render.c.bold, String(souls.length))));
    log(render.kv("Output", render.wrap(render.c.dim, outputPath)));
  });

}
