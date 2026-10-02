/**
 * backup.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { resolveAdminUser } from "../lib/auth-resolve.js";
import { flairBackupOutputPath } from "../lib/flair-paths.js";
import * as render from "../render.js";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

    type Row = Record<string, unknown> & { id: string };
    const ids = { Agent: new Set<string>(), Memory: new Set<string>(), Soul: new Set<string>() };

    async function adminGet(table: keyof typeof ids, agentId?: string): Promise<Row[]> {
      const path = `/${table}/${agentId === undefined ? "" : `?agentId=${encodeURIComponent(agentId)}`}`;
      const context = agentId === undefined ? table : `${table} for agent ${agentId}`;
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`GET ${path} failed (${res.status}): ${text}`);
        }
        const rows: unknown = await res.json();
        if (!Array.isArray(rows)) throw new Error("expected an array response");
        for (const [index, row] of rows.entries()) {
          if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id.trim()) {
            throw new Error(`row ${index}: missing or invalid id`);
          }
          if (ids[table].has(row.id)) throw new Error(`row ${row.id}: duplicate id`);
          if (agentId !== undefined && row.agentId !== agentId) {
            throw new Error(`row ${row.id}: agentId does not match ${agentId}`);
          }
          ids[table].add(row.id);
        }
        return rows;
      } catch (error) {
        throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    log("Fetching agents...");
    const allAgents = await adminGet("Agent");
    const filterIds: string[] | null = opts.agents ? opts.agents.split(",").map((s: string) => s.trim()) : null;
    if (filterIds) {
      for (const id of filterIds) {
        if (!ids.Agent.has(id)) throw new Error(`Agent ${id || "(empty id)"}: requested agent was not returned`);
      }
    }
    const agents = filterIds ? allAgents.filter(a => filterIds.includes(a.id)) : allAgents;

    log(`Fetching memories for ${agents.length} agent(s)...`);
    const memories: Row[] = [];
    for (const agent of agents) {
      for (const row of await adminGet("Memory", agent.id)) memories.push(row);
    }

    log("Fetching souls...");
    const souls: Row[] = [];
    for (const agent of agents) {
      for (const row of await adminGet("Soul", agent.id)) souls.push(row);
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
    let stagingDir: string | undefined;
    try {
      mkdirSync(join(outputPath, ".."), { recursive: true });
      stagingDir = mkdtempSync(join(outputPath, "..", ".flair-backup-"));
      const tmp = join(stagingDir, "archive.json");
      const serialized = JSON.stringify(backup, null, 2) + "\n";
      writeFileSync(tmp, serialized, { encoding: "utf-8", flag: "wx", mode: 0o600 });
      const written = readFileSync(tmp, "utf-8");
      const archive = JSON.parse(written);
      for (const table of ["agents", "memories", "souls"] as const) {
        if (!Array.isArray(archive[table]) || archive[table].length !== backup[table].length) {
          throw new Error(`${table}: archive count does not match fetched count ${backup[table].length}`);
        }
        for (const [index, row] of backup[table].entries()) {
          if (archive[table][index]?.id !== row.id) {
            throw new Error(`${table} row ${row.id}: archive id does not match fetched id`);
          }
          if (JSON.stringify(archive[table][index]) !== JSON.stringify(row)) {
            throw new Error(`${table} row ${row.id}: archive contents do not match fetched row`);
          }
        }
      }
      if (written !== serialized) throw new Error("archive contents do not match fetched data");
      renameSync(tmp, outputPath);
    } catch (error) {
      throw new Error(`Backup archive ${outputPath}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    }

    log(`\n${render.icons.ok} ${render.wrap(render.c.green, "Backup complete")}`);
    log(render.kv("Agents", render.wrap(render.c.bold, String(agents.length))));
    log(render.kv("Memories", render.wrap(render.c.bold, String(memories.length))));
    log(render.kv("Souls", render.wrap(render.c.bold, String(souls.length))));
    log(render.kv("Output", render.wrap(render.c.dim, outputPath)));
  });

}
