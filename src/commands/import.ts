/**
 * import.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * `flair import`: restore an agent from an export file, writing its Soul and
 * Memory rows and reporting each refused, failed or unknown row.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import {
  ApiHttpError,
  ApiRequestOutcomeUnknown,
  apiErrorRawBody,
  defaultKeysDir,
  isLocalBase,
  resolveAdminUser,
  sendJsonRequest,
} from "../lib/auth-resolve.js";
import { encodeRecordId } from "../lib/record-id-path.js";
import { SOUL_SCOPE_FIELDS_REFUSAL } from "../lib/soul-scope-fields.js";
import * as render from "../render.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nacl from "tweetnacl";

/** The `error` name a response body carries, when it carries one. */
function responseErrorName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const body = JSON.parse(raw) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

type RowWrite =
  | { kind: "imported" }
  | { kind: "failed"; status: number | undefined; error: string | undefined }
  | { kind: "unknown"; status: number | undefined; message: string };

/** Write one imported row. Only a 2xx response counts as imported. */
async function writeRow(
  baseUrl: string,
  table: "Soul" | "Memory",
  row: { id: string },
  auth: string,
): Promise<RowWrite> {
  try {
    await sendJsonRequest(
      new URL(`${baseUrl}/${table}/${encodeRecordId(row.id)}`),
      "PUT",
      row,
      auth,
      isLocalBase(baseUrl),
    );
    return { kind: "imported" };
  } catch (err) {
    if (err instanceof ApiRequestOutcomeUnknown) {
      return { kind: "unknown", status: err.status, message: err.message };
    }
    if (err instanceof ApiHttpError) {
      return { kind: "failed", status: err.status, error: responseErrorName(apiErrorRawBody(err)) };
    }
    // The shared sender parses a 2xx body as JSON; a 2xx body that is not JSON
    // still arrived as a successful write.
    if (err instanceof SyntaxError) return { kind: "imported" };
    return { kind: "failed", status: undefined, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The per-row failure text: an HTTP status and the server's error name, or
 *  the thrown error. Never the row's content. */
function failureText(row: { status: number | undefined; error: string | undefined }): string {
  if (row.status === undefined) return row.error ?? "no response";
  return `HTTP ${row.status}${row.error ? ` ${row.error}` : ""}`;
}

export type ImportCli = {
  b64url: (...args: any[]) => any;
  privKeyPath: (...args: any[]) => any;
  resolveEffectiveOpsUrl: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
  resolveOpsPort: (...args: any[]) => any;
  seedAgentViaOpsApi: (...args: any[]) => any;
  seedAgentWithLocalHome: (...args: any[]) => any;
};

let cli: ImportCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: ImportCli): void {
  cli = fns;
}

function b64url(...args: any[]): any {
  return cli.b64url(...args);
}

function privKeyPath(...args: any[]): any {
  return cli.privKeyPath(...args);
}

function resolveEffectiveOpsUrl(...args: any[]): any {
  return cli.resolveEffectiveOpsUrl(...args);
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

function resolveOpsPort(...args: any[]): any {
  return cli.resolveOpsPort(...args);
}

function seedAgentViaOpsApi(...args: any[]): any {
  return cli.seedAgentViaOpsApi(...args);
}

function seedAgentWithLocalHome(...args: any[]): any {
  return cli.seedAgentWithLocalHome(...args);
}

export function register(program: Command): void {
// ─── flair import ────────────────────────────────────────────────────────────


program
  .command("import <path>")
  .description("Import an agent from an export file into this Flair instance")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--ops-target <url>", "Explicit ops API URL for the Agent seed (env: FLAIR_OPS_TARGET; bypasses port derivation). Use when --url is remote and the ops port isn't HTTP-1.")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
  .option("--keys-dir <dir>", "Keys directory", defaultKeysDir())
  .action(async (importPath, opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const opsPort = resolveOpsPort(opts);
    // Resolve where the Agent record is seeded. The Agent goes through the ops
    // API (the REST surface has no Agent POST handler), so a remote --url import
    // must NOT silently seed on localhost (#514 — split import). Precedence:
    //   1. --ops-target / FLAIR_OPS_TARGET → use directly
    //   2. --url given → derive ops URL from it (port-1 convention)
    //   3. neither → localhost opsPort (preserves local default)
    // The remote REST base (--url) is mapped to `target` for derivation.
    const seedOpsTarget: number | string =
      resolveEffectiveOpsUrl({ target: opts.url, opsTarget: opts.opsTarget }) ?? opsPort;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) { console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required"); process.exit(1); }

    if (!existsSync(importPath)) { console.error(`File not found: ${importPath}`); process.exit(1); }
    const data = JSON.parse(readFileSync(importPath, "utf-8"));

    if (data.type !== "agent-export") {
      console.error("Error: not an agent export file. Use 'flair restore' for full backups.");
      process.exit(1);
    }

    const agentId = data.agent?.id;
    if (!agentId) { console.error("Error: no agent ID in export"); process.exit(1); }

    console.log(`Importing agent '${agentId}'...`);

    // Register agent (generates new key if export doesn't include one)
    const keysDir = opts.keysDir ?? defaultKeysDir();
    mkdirSync(keysDir, { recursive: true });
    const privPath = privKeyPath(agentId, keysDir);

    if (data.privateKey && !existsSync(privPath)) {
      // Restore exported key
      writeFileSync(privPath, data.privateKey);
      chmodSync(privPath, 0o600);
      console.log(`  Key restored: ${privPath}`);
    } else if (!existsSync(privPath)) {
      // Generate new key
      const kp = nacl.sign.keyPair();
      writeFileSync(privPath, Buffer.from(kp.secretKey.slice(0, 32)));
      chmodSync(privPath, 0o600);
      console.log(`  New key generated: ${privPath}`);
    } else {
      console.log(`  Using existing key: ${privPath}`);
    }

    // Read public key for registration
    const seed = readFileSync(privPath);
    const decodedSeed = seed.length === 32 ? seed : Buffer.from(seed.toString("utf-8").trim(), "base64");
    const pubKey = decodedSeed.length === 32
      ? nacl.sign.keyPair.fromSeed(new Uint8Array(decodedSeed)).publicKey
      : nacl.sign.keyPair.fromSeed(new Uint8Array(decodedSeed.subarray(0, 32))).publicKey;
    const pubKeyB64url = b64url(pubKey);

    // Register agent via ops API (remote when --url/--ops-target points off-box)
    await seedAgentWithLocalHome(seedOpsTarget, agentId, pubKeyB64url, resolveAdminUser(opts.adminUser), adminPass);
    console.log(
      typeof seedOpsTarget === "string"
        ? `  Agent registered (ops: ${seedOpsTarget})`
        : `  Agent registered`,
    );

    // Restore souls before memories: refuseLearnedSoulWrite matches Memory text.
    const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
    let soulCount = 0;
    let memCount = 0;
    let failedCount = 0;
    let unknownCount = 0;

    for (const soul of data.souls ?? []) {
      const outcome = await writeRow(baseUrl, "Soul", soul, auth);
      if (outcome.kind === "imported") {
        soulCount++;
        continue;
      }
      // A row the server refuses by name for supplying a non-empty `scopeTag`
      // or a non-empty `tags` array is reported with its id and left out of
      // the count; the rest of the export is imported as before (flair#1540).
      if (outcome.kind === "failed" && outcome.error === SOUL_SCOPE_FIELDS_REFUSAL) {
        console.log(`${render.icons.warn} Soul ${soul.id} refused: ${outcome.error}`);
        continue;
      }
      if (outcome.kind === "unknown") {
        unknownCount++;
        console.error(`${render.icons.warn} Soul ${soul.id} unknown: ${outcome.message}`);
        continue;
      }
      failedCount++;
      console.error(`${render.icons.error} Soul ${soul.id} failed: ${failureText(outcome)}`);
    }

    for (const mem of data.memories ?? []) {
      const outcome = await writeRow(baseUrl, "Memory", mem, auth);
      if (outcome.kind === "imported") {
        memCount++;
        continue;
      }
      if (outcome.kind === "unknown") {
        unknownCount++;
        console.error(`${render.icons.warn} Memory ${mem.id} unknown: ${outcome.message}`);
        continue;
      }
      failedCount++;
      console.error(`${render.icons.error} Memory ${mem.id} failed: ${failureText(outcome)}`);
    }

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, `Agent '${agentId}' imported`)}`);
    console.log(render.kv("Memories", `${render.wrap(render.c.bold, String(memCount))}${render.wrap(render.c.dim, `/${(data.memories ?? []).length}`)}`));
    console.log(render.kv("Souls", `${render.wrap(render.c.bold, String(soulCount))}${render.wrap(render.c.dim, `/${(data.souls ?? []).length}`)}`));
    if (failedCount > 0) console.log(render.kv("Failed", String(failedCount)));
    if (unknownCount > 0) console.log(render.kv("Unknown", String(unknownCount)));
    console.log(render.kv("Key", render.wrap(render.c.dim, privPath)));

    // An unknown write outcome exits 3, as the REM runner and `flair memory
    // verify` use it, distinct from the 1 a definite failure exits with.
    if (unknownCount > 0) process.exit(3);
    if (failedCount > 0) process.exit(1);
  });

}
