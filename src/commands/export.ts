/**
 * export.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair export`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { defaultKeysDir, resolveAdminUser } from "../lib/auth-resolve.js";
import * as render from "../render.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { resolveHome } from "../lib/home.js";

export type ExportCli = {
  privKeyPath: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
};

let cli: ExportCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: ExportCli): void {
  cli = fns;
}

function privKeyPath(...args: any[]): any {
  return cli.privKeyPath(...args);
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

export function register(program: Command): void {
// ─── flair export ────────────────────────────────────────────────────────────


program
  .command("export <agent-id>")
  .description("Export a single agent's identity (soul + memories) to a portable file")
  .option("--output <path>", "Output file path")
  .option("--include-key", "Include private key in export (UNENCRYPTED — keep the output file secure)")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
  .option("--keys-dir <dir>", "Keys directory", defaultKeysDir())
  .action(async (agentId, opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) { console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required"); process.exit(1); }

    const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
    async function adminGet(path: string): Promise<any> {
      const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
      return res.json();
    }

    console.log(`Exporting agent '${agentId}'...`);

    // Fetch agent record
    let agent: any;
    try { agent = await adminGet(`/Agent/${agentId}`); }
    catch { console.error(`Agent '${agentId}' not found`); process.exit(1); }

    // Fetch memories
    const allMemories: any[] = await adminGet("/Memory/").catch(() => []);
    const memories = Array.isArray(allMemories)
      ? allMemories.filter((m: any) => m.agentId === agentId)
      : [];

    // Fetch souls
    const allSouls: any[] = await adminGet("/Soul/").catch(() => []);
    const souls = Array.isArray(allSouls)
      ? allSouls.filter((s: any) => s.agentId === agentId)
      : [];

    // Fetch grants
    const allGrants: any[] = await adminGet("/MemoryGrant/").catch(() => []);
    const grants = Array.isArray(allGrants)
      ? allGrants.filter((g: any) => g.ownerId === agentId || g.granteeId === agentId)
      : [];

    // Optionally include private key
    let privateKey: string | undefined;
    if (opts.includeKey) {
      const keyPath = privKeyPath(agentId, opts.keysDir);
      if (existsSync(keyPath)) {
        privateKey = readFileSync(keyPath, "utf-8").trim();
        console.log("  Including private key (base64-encoded in export)");
      } else {
        console.warn(`  Warning: key file not found at ${keyPath} — skipping key export`);
      }
    }

    const exportData = {
      version: 1,
      type: "agent-export",
      exportedAt: new Date().toISOString(),
      source: baseUrl,
      agent,
      memories,
      souls,
      grants,
      ...(privateKey ? { privateKey } : {}),
    };

    const rawOutputPath = opts.output ?? join(resolveHome(), ".flair", "exports", `${agentId}-${Date.now()}.json`);
    // Canonicalize to prevent path traversal (e.g. ../../etc/passwd)
    const outputPath = resolve(rawOutputPath);
    mkdirSync(join(outputPath, ".."), { recursive: true });
    const fileMode = privateKey ? 0o600 : 0o644;
    writeFileSync(outputPath, JSON.stringify(exportData, null, 2), { mode: fileMode });
    if (privateKey) chmodSync(outputPath, 0o600); // enforce even if umask is permissive

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, `Agent '${agentId}' exported`)}`);
    console.log(render.kv("Memories", render.wrap(render.c.bold, String(memories.length))));
    console.log(render.kv("Souls", render.wrap(render.c.bold, String(souls.length))));
    console.log(render.kv("Grants", render.wrap(render.c.bold, String(grants.length))));
    const keyText = privateKey
      ? `${render.wrap(render.c.magenta, "included")} ${render.wrap(render.c.red, "(UNENCRYPTED — protect this file)")}`
      : render.wrap(render.c.dim, "not included");
    console.log(render.kv("Key", keyText));
    console.log(render.kv("Mode", `${fileMode.toString(8)} ${render.wrap(render.c.dim, `(${privateKey ? "owner-only" : "standard"})`)}`));
    console.log(render.kv("Output", render.wrap(render.c.dim, outputPath)));
  });

}
