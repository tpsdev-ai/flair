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
  resolveOpsPort: (...args: any[]) => any;
  resolveOpsUrlFromTarget: (...args: any[]) => any;
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

function resolveOpsPort(...args: any[]): any {
  return cli.resolveOpsPort(...args);
}

function resolveOpsUrlFromTarget(...args: any[]): any {
  return cli.resolveOpsUrlFromTarget(...args);
}

export function register(program: Command): void {
// ─── flair backup ────────────────────────────────────────────────────────────


addSharedCredentialOptions(
  program
    .command("backup")
    .description("Export agents, memories, and souls to a JSON archive")
    .addHelpText("after", "Collections are read separately and can reflect different moments.")
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

    const opsTarget = process.env.FLAIR_OPS_TARGET;
    const opsUrl: string = opsTarget
      ? opsTarget.replace(/\/$/, "")
      : opts.url
        ? resolveOpsUrlFromTarget(opts.url)
        : `http://127.0.0.1:${opts.port !== undefined ? resolveHttpPort(opts) - 1 : resolveOpsPort(opts)}`;

    type Row = Record<string, unknown> & { id: string };
    const ids = { Agent: new Set<string>(), Memory: new Set<string>(), Soul: new Set<string>() };

    async function adminGet(table: keyof typeof ids, agentId?: string): Promise<Row[]> {
      const path = `/${table}/${agentId === undefined ? "" : `?agentId=${encodeURIComponent(agentId)}`}`;
      const context = agentId === undefined ? table : `${table} for agent ${agentId}`;
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => { throw new Error("request failed"); });
        if (!res.ok) {
          throw new Error(`GET ${path} failed (${res.status})`);
        }
        const rows: unknown = await res.json().catch(() => { throw new Error("invalid JSON response"); });
        if (!Array.isArray(rows)) throw new Error("expected an array response");
        for (const [index, row] of rows.entries()) {
          if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id.trim()) {
            throw new Error(`row ${index}: missing or invalid id`);
          }
          if (ids[table].has(row.id)) throw new Error(`row ${index}: duplicate id`);
          if (agentId !== undefined && row.agentId !== agentId) {
            throw new Error(`row ${index}: agentId does not match ${agentId}`);
          }
          ids[table].add(row.id);
        }
        return rows;
      } catch (error) {
        throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    async function opsPost(body: Record<string, unknown>, context: string): Promise<unknown> {
      try {
        const res = await fetch(opsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => { throw new Error("request failed"); });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return await res.json().catch(() => { throw new Error("invalid JSON response"); });
      } catch (error) {
        throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    type Table = keyof typeof ids;
    type Inventory = Map<string, unknown>;

    async function rowCount(table: Table): Promise<number> {
      const parsed: any = await opsPost(
        { operation: "describe_table", database: "flair", table, exact_count: true },
        `${table} row count`,
      );
      const n = parsed?.record_count;
      if (!Number.isSafeInteger(n) || n < 0) {
        throw new Error(`${table} row count via the operations API: response carried no record_count`);
      }
      return n;
    }

    async function inventory(table: Table): Promise<Inventory> {
      const expected = await rowCount(table);
      const parsed: any = await opsPost({
        operation: "search_by_value", database: "flair", table,
        search_attribute: "id", search_value: "*", get_attributes: table === "Agent" ? ["id"] : ["id", "agentId"],
      }, `${table} inventory`);
      const rows = Array.isArray(parsed) ? parsed : parsed?.results;
      if (!Array.isArray(rows)) throw new Error(`${table} inventory: expected a row array`);
      const result: Inventory = new Map();
      for (const row of rows) {
        if (!row || typeof row.id !== "string" || !row.id.trim() || result.has(row.id)) {
          throw new Error(`${table} inventory: invalid or duplicate id`);
        }
        result.set(row.id, row.agentId);
      }
      if (result.size !== expected) {
        throw new Error(`${table}: server reports ${expected} rows, inventory read ${result.size}`);
      }
      const after = await rowCount(table);
      if (after !== expected) throw new Error(`${table}: source count changed; retry backup when writes are paused`);
      return result;
    }

    function verifyRows(table: Table, rows: Row[], expected: Inventory, agentId?: string): void {
      const selected = new Set([...expected].filter(([, owner]) => agentId === undefined || owner === agentId).map(([id]) => id));
      const context = agentId === undefined ? table : `${table} for agent ${agentId}`;
      if (rows.length !== selected.size) {
        throw new Error(`${context}: server reports ${selected.size} rows, backup read ${rows.length}`);
      }
      if (rows.some(row => !selected.has(row.id))) throw new Error(`${context}: backup ids differ from inventory`);
    }

    const inventories = { Agent: await inventory("Agent"), Memory: await inventory("Memory"), Soul: await inventory("Soul") };

    log("Fetching agents...");
    const allAgents = await adminGet("Agent");
    verifyRows("Agent", allAgents, inventories.Agent);
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
      const rows = await adminGet("Memory", agent.id);
      verifyRows("Memory", rows, inventories.Memory, agent.id);
      memories.push(...rows);
    }

    log("Fetching souls...");
    const souls: Row[] = [];
    for (const agent of agents) {
      const rows = await adminGet("Soul", agent.id);
      verifyRows("Soul", rows, inventories.Soul, agent.id);
      souls.push(...rows);
    }

    for (const table of ["Agent", "Memory", "Soul"] as const) {
      const after = await inventory(table);
      const before = inventories[table];
      if (after.size !== before.size || [...before].some(([id, owner]) => !after.has(id) || after.get(id) !== owner)) {
        throw new Error(`${table}: source ids changed; retry backup when writes are paused`);
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
    log("Collections are read separately and can reflect different moments.");
    log(render.kv("Agents", render.wrap(render.c.bold, String(agents.length))));
    log(render.kv("Memories", render.wrap(render.c.bold, String(memories.length))));
    log(render.kv("Souls", render.wrap(render.c.bold, String(souls.length))));
    log(render.kv("Output", render.wrap(render.c.dim, outputPath)));
  });

}
