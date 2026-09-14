/**
 * import.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair import`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { defaultKeysDir, resolveAdminUser } from "../lib/auth-resolve.js";
import * as render from "../render.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nacl from "tweetnacl";

export type ImportCli = {
  b64url: (...args: any[]) => any;
  privKeyPath: (...args: any[]) => any;
  resolveEffectiveOpsUrl: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
  resolveOpsPort: (...args: any[]) => any;
  seedAgentViaOpsApi: (...args: any[]) => any;
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
    await seedAgentViaOpsApi(seedOpsTarget, agentId, pubKeyB64url, resolveAdminUser(opts.adminUser), adminPass);
    console.log(
      typeof seedOpsTarget === "string"
        ? `  Agent registered (ops: ${seedOpsTarget})`
        : `  Agent registered`,
    );

    // Restore souls before memories: refuseLearnedSoulWrite matches Memory text.
    const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
    let soulCount = 0;
    for (const soul of data.souls ?? []) {
      try {
        await fetch(`${baseUrl}/Soul/${encodeURIComponent(soul.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(soul),
        });
        soulCount++;
      } catch { /* skip failures */ }
    }

    let memCount = 0;
    for (const mem of data.memories ?? []) {
      try {
        await fetch(`${baseUrl}/Memory/${mem.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(mem),
        });
        memCount++;
      } catch { /* skip failures */ }
    }

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, `Agent '${agentId}' imported`)}`);
    console.log(render.kv("Memories", `${render.wrap(render.c.bold, String(memCount))}${render.wrap(render.c.dim, `/${(data.memories ?? []).length}`)}`));
    console.log(render.kv("Souls", `${render.wrap(render.c.bold, String(soulCount))}${render.wrap(render.c.dim, `/${(data.souls ?? []).length}`)}`));
    console.log(render.kv("Key", render.wrap(render.c.dim, privPath)));
  });

}
