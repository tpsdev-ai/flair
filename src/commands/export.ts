/**
 * export.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Owns the `flair export` command.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { defaultKeysDir, resolveAdminUser, addAdminPassOptions } from "../lib/auth-resolve.js";
import * as render from "../render.js";
import { closeSync, constants as fsConstants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { writeFilesAtomically } from "../lib/atomic-write.js";
import { invalidAgentIdMessage, isValidAgentId } from "../lib/agent-id-rule.js";

import { dirname, join, resolve } from "node:path";
import { resolveHome } from "../lib/home.js";
import { encodeRecordId } from "../lib/record-id-path.js";

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

const AGENT_REQUIRED_FIELDS = ["id", "name", "publicKey", "createdAt"] as const;
const MEMORY_REQUIRED_FIELDS = ["id", "agentId", "content", "createdAt"] as const;
const SOUL_REQUIRED_FIELDS = ["id", "agentId", "key", "value", "createdAt"] as const;
const GRANT_REQUIRED_FIELDS = ["id", "ownerId", "granteeId", "scope"] as const;

export function exportFileMode(outputPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "mode bits are not enforced on Windows" : (statSync(outputPath).mode & 0o7777).toString(8);
}

/** The default export path for `agentId` inside `exportsDir`, or null when the
 *  resolved path is not a direct child of the resolved exports directory. */
export function defaultExportOutputPath(
  exportsDir: string,
  agentId: string,
  now: number = Date.now(),
): string | null {
  const dir = resolve(exportsDir);
  const candidate = resolve(dir, `${agentId}-${now}.json`);
  return dirname(candidate) === dir ? candidate : null;
}

/** The clock the default export name reads. `FLAIR_TEST_EXPORT_CLOCK_MS` fixes
 *  it so a test can plant a path at the exact default name. */
function defaultExportClockMs(): number {
  const raw = process.env.FLAIR_TEST_EXPORT_CLOCK_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Create `outputPath` exclusively at `mode`, write `content`, fsync and close.
 *  An existing path — file, symlink or anything else — is refused and nothing
 *  is written. */
function writeDefaultExport(outputPath: string, content: string, mode: number): void {
  let fd: number;
  try {
    fd = openSync(outputPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") {
      console.error(`Error: refusing to write to existing path ${outputPath}`);
      process.exit(1);
    }
    throw err;
  }
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function hasRequiredStringFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && fields.every((field) => typeof (value as Record<string, unknown>)[field] === "string");
}

export function register(program: Command): void {
// ─── flair export ────────────────────────────────────────────────────────────


addAdminPassOptions(
  program
    .command("export <agent-id>")
    .description("Export a single agent's identity (soul + memories) to a portable file")
    .option("--output <path>", "Output file path")
    .option("--include-key", "Include private key in export (UNENCRYPTED — keep the output file secure)")
    .option("--port <port>", "Harper HTTP port")
    .option("--url <url>", "Flair base URL (overrides --port)"),
  "Admin password (or set FLAIR_ADMIN_PASS env)",
)
  .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
  .option("--keys-dir <dir>", "Keys directory", defaultKeysDir())
  .action(async (agentId, opts) => {
    // flair#3136 — the ONE agent-ID rule, before any request, key read or file write.
    if (!isValidAgentId(agentId)) {
      console.error(`Error: ${invalidAgentIdMessage(agentId)}`);
      process.exit(1);
    }
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) { console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required"); process.exit(1); }

    const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
    class HttpError extends Error {
      constructor(message: string, readonly status: number) { super(message); }
    }
    async function adminGet(path: string): Promise<any> {
      const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new HttpError(`GET ${path} failed (${res.status})`, res.status);
      return res.json();
    }

    console.log(`Exporting agent '${agentId}'...`);

    // Fetch agent record
    let agent: any;
    try {
      agent = await adminGet(`/Agent/${encodeRecordId(agentId)}`);
    } catch (err) {
      // flair#1970 acceptance: a read that FAILS is not "not found". Only a
      // definite 404 is; a transport failure, a 5xx, or an unreadable body is a
      // refusal that names what happened rather than an absent agent.
      if (err instanceof HttpError && err.status === 404) {
        console.error(`Agent '${agentId}' not found`);
        process.exit(1);
      }
      console.error(`Error: could not read agent '${agentId}': ${err instanceof Error ? err.message : String(err)}. Check instance access and retry.`);
      process.exit(1);
    }
    if (!hasRequiredStringFields(agent, AGENT_REQUIRED_FIELDS) || agent.id !== agentId) {
      console.error(`Error: could not read agent '${agentId}': response did not contain a complete requested agent. Check the instance and retry.`);
      process.exit(1);
    }

    async function readCollection(path: string, name: string, requiredFields: readonly string[]): Promise<any[]> {
      try {
        const rows = await adminGet(path);
        if (!Array.isArray(rows)) throw new Error(`GET ${path} returned a non-array body`);
        const malformedIndex = rows.findIndex((row) => !hasRequiredStringFields(row, requiredFields));
        if (malformedIndex !== -1) throw new Error(`GET ${path} returned a malformed item at index ${malformedIndex}`);
        return rows;
      } catch (err) {
        console.error(`Error: could not read ${name}: ${err instanceof Error ? err.message : String(err)}. Check instance access and retry.`);
        process.exit(1);
      }
    }

    const allMemories = await readCollection("/Memory/", "memories", MEMORY_REQUIRED_FIELDS);
    const memories = allMemories.filter((m: any) => m.agentId === agentId);

    const allSouls = await readCollection("/Soul/", "souls", SOUL_REQUIRED_FIELDS);
    const souls = allSouls.filter((s: any) => s.agentId === agentId);

    const allGrants = await readCollection("/MemoryGrant/", "grants", GRANT_REQUIRED_FIELDS);
    const grants = allGrants.filter((g: any) => g.ownerId === agentId || g.granteeId === agentId);

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

    let rawOutputPath: string;
    if (opts.output !== undefined) {
      rawOutputPath = opts.output;
    } else {
      const exportsDir = join(resolveHome(), ".flair", "exports");
      const defaultPath = defaultExportOutputPath(exportsDir, agentId, defaultExportClockMs());
      if (defaultPath === null) {
        console.error(`Error: refusing to write agent '${agentId}' outside the exports directory ${resolve(exportsDir)}`);
        process.exit(1);
      }
      rawOutputPath = defaultPath;
    }
    // Canonicalize to prevent path traversal (e.g. ../../etc/passwd)
    const outputPath = resolve(rawOutputPath);
    mkdirSync(join(outputPath, ".."), { recursive: true });
    const fileMode = opts.includeKey ? 0o600 : 0o644;
    const content = JSON.stringify(exportData, null, 2);
    if (opts.output !== undefined) {
      if (opts.includeKey) {
        // Stage at 0600 to avoid retaining an existing output file's wider mode.
        writeFilesAtomically([{ path: outputPath, content, mode: 0o600 }]);
      } else {
        writeFileSync(outputPath, content, { mode: fileMode });
      }
    } else {
      writeDefaultExport(outputPath, content, fileMode);
    }

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, `Agent '${agentId}' exported`)}`);
    console.log(render.kv("Memories", render.wrap(render.c.bold, String(memories.length))));
    console.log(render.kv("Souls", render.wrap(render.c.bold, String(souls.length))));
    console.log(render.kv("Grants", render.wrap(render.c.bold, String(grants.length))));
    const keyText = privateKey
      ? `${render.wrap(render.c.magenta, "included")} ${render.wrap(render.c.red, "(UNENCRYPTED — protect this file)")}`
      : render.wrap(render.c.dim, "not included");
    console.log(render.kv("Key", keyText));
    console.log(render.kv("Mode", exportFileMode(outputPath)));
    console.log(render.kv("Output", render.wrap(render.c.dim, outputPath)));
  });

}
