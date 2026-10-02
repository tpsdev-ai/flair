/**
 * restore.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { resolveAdminUser } from "../lib/auth-resolve.js";
import { encodeRecordId } from "../lib/record-id-path.js";
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

    const { agents, memories, souls } = backup;
    const collections = [
      { name: "Agent", rows: agents },
      { name: "Soul", rows: souls },
      { name: "Memory", rows: memories },
    ];
    const failures: string[] = [];
    const message = (err: unknown): string => err instanceof Error ? err.message : String(err);
    function fail(): void {
      for (const failure of failures) console.error(`Error: ${failure}`);
      process.exitCode = 1;
    }
    for (const { name, rows } of collections) {
      if (!Array.isArray(rows)) {
        failures.push(`${name}: archive collection is not an array`);
        continue;
      }
      for (const [index, row] of rows.entries()) {
        if (!row || typeof row !== "object" || Array.isArray(row)
          || typeof row.id !== "string" || !row.id
          || (name !== "Agent" && (typeof row.agentId !== "string" || !row.agentId))) {
          failures.push(`${name} row ${index} (${row?.id ?? "missing ID"}): invalid archived row`);
          continue;
        }
        try {
          encodeRecordId(row.id);
        } catch (err) {
          failures.push(`${name} ${row.id}: ${message(err)}`);
        }
      }
    }
    if (failures.length) { fail(); return; }
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

    const label = (name: string, row: any): string =>
      `${name} ${row.id}${name === "Agent" ? "" : ` (agent ${row.agentId})`}`;

    if (mode === "replace") {
      console.log("\nDeleting existing data (replace mode)...");
      for (const { name, rows } of collections.filter(({ name }) => name !== "Agent")) {
        for (const row of rows) {
          try {
            await adminDelete(`/${name}/${encodeRecordId(row.id)}`);
          } catch (err) {
            failures.push(`${label(name, row)}: DELETE failed: ${message(err)}`);
          }
        }
      }
      if (failures.length) { fail(); return; }
    }

    for (const { name, rows } of collections) {
      console.log(`Restoring ${name} records...`);
      for (const row of rows) {
        try {
          await adminPut(`/${name}/${encodeRecordId(row.id)}`, row);
        } catch (err) {
          failures.push(`${label(name, row)}: PUT failed: ${message(err)}`);
        }
      }
    }

    for (const { name, rows } of collections) {
      for (const row of rows) {
        const path = `/${name}/${encodeRecordId(row.id)}`;
        try {
          const res = await fetch(`${baseUrl}${path}`, {
            headers: { Authorization: auth },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
          const restored = await res.json();
          if (!restored || typeof restored !== "object" || Array.isArray(restored)
            || restored.id !== row.id
            || (name !== "Agent" && restored.agentId !== row.agentId)) {
            throw new Error(`GET ${path} did not return the requested row and agent`);
          }
        } catch (err) {
          failures.push(`${label(name, row)}: verification failed: ${message(err)}`);
        }
      }
    }
    if (failures.length) { fail(); return; }
    const agentCount = agents.length;
    const memoryCount = memories.length;
    const soulCount = souls.length;

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, "Restore complete")}`);
    console.log(render.kv("Agents restored", `${render.wrap(render.c.bold, String(agentCount))}${render.wrap(render.c.dim, `/${agents.length}`)}`));
    console.log(render.kv("Memories restored", `${render.wrap(render.c.bold, String(memoryCount))}${render.wrap(render.c.dim, `/${memories.length}`)}`));
    console.log(render.kv("Souls restored", `${render.wrap(render.c.bold, String(soulCount))}${render.wrap(render.c.dim, `/${souls.length}`)}`));
  });

}
