/**
 * restore.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { resolveAdminUser } from "../lib/auth-resolve.js";
import { readBackupArtifact } from "../lib/backup-artifact.js";
import { loadApprovedArchive } from "../lib/backup-approval-store.js";
import type { RestoreArchive } from "../lib/restore-archive.js";
import { encodeRecordId } from "../lib/record-id-path.js";
import { comparePreservedFields } from "../lib/restore-verify.js";
import * as render from "../render.js";
import { existsSync } from "node:fs";

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
  .option("--replace", "Delete archived Soul and Memory IDs first, then import")
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

    // Preflight (flair#2664), before any request in every mode, dry run
    // included: read the archive once, hash and parse that one buffer, and
    // require the hash to equal the digest flair backup wrote to
    // `<archive>.sha256`. The parse refuses ill-formed UTF-8 or JSON, a
    // repeated key or row id, an unsupported version, and rows restore cannot
    // write (src/lib/restore-archive.ts).
    //
    // An archive with no sidecar (flair#2664 slice 1c) is admitted only by an
    // unrevoked approval in this host's approval store
    // (src/lib/backup-approval-store.ts) for the digest of the bytes just
    // read, and only when the stored copy still hashes to that digest; the
    // rows restored are parsed from that rechecked copy. A sidecar-backed
    // archive needs no approval here.
    const artifact = readBackupArtifact(backupPath);
    let archive: RestoreArchive;
    let admitted: string;
    if (artifact.ok === false && (artifact.code !== "digest-missing" || artifact.sha256 === undefined)) {
      console.error(`Error: ${artifact.reason}`);
      process.exitCode = 1;
      return;
    }
    if (artifact.ok === false) {
      const approved = loadApprovedArchive(artifact.sha256!);
      if (approved.ok === false) {
        const reapprove = approved.code === "store-unsafe" || approved.code === "record-invalid"
          ? ""
          : ` Approve the archive again on this host with flair backup-approval legacy-admit ${backupPath}.`;
        const reason = approved.code === "not-approved"
          ? artifact.reason
          : `archive digest sidecar ${backupPath}.sha256 not found, and ${approved.reason}; restore stopped before any write.${reapprove}`;
        console.error(`Error: ${reason}`);
        process.exitCode = 1;
        return;
      }
      archive = approved.archive;
      admitted = `${approved.sha256} (no digest sidecar; approved on this host by ${approved.record.approvedBy} ` +
        `at ${approved.record.approvedAt}, ${approved.record.admission} admission)`;
    } else {
      archive = artifact.archive;
      admitted = `${artifact.sha256} (matches ${artifact.digestPath})`;
    }

    const { agents, memories, souls } = archive;
    const collections = [
      { name: "Agent", rows: agents },
      { name: "Soul", rows: souls },
      { name: "Memory", rows: memories },
    ];
    const failures: string[] = [];
    function fail(): void {
      for (const failure of failures) console.error(`Error: ${failure}`);
      process.exitCode = 1;
    }
    const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

    console.log(`Restoring from: ${backupPath}`);
    console.log(`Archive SHA-256: ${admitted}`);
    console.log(`Mode: ${mode}${dryRun ? " (dry run)" : ""}`);
    console.log(`  Agents:   ${agents.length}`);
    console.log(`  Memories: ${memories.length}`);
    console.log(`  Souls:    ${souls.length}`);

    if (dryRun) {
      console.log("\n✅ Dry run complete — no changes made");
      return;
    }

    async function adminWrite(method: "PUT" | "DELETE", path: string, body?: unknown): Promise<number | undefined> {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        return res.status;
      } catch {
        return undefined;
      }
    }

    const label = (name: string, row: any): string =>
      `${name} ${row.id} (agent ${name === "Agent" ? row.id : row.agentId})`;
    const diagnostic = (name: string, row: any, method: string, status: number | undefined): string =>
      `${label(name, row)}: ${method} failed (HTTP ${status ?? "unavailable"})`;

    if (mode === "replace") {
      console.log("\nDeleting existing data (replace mode)...");
      for (const { name, rows } of collections.filter(({ name }) => name !== "Agent")) {
        for (const row of rows) {
          const status = await adminWrite("DELETE", `/${name}/${encodeRecordId(row.id)}`);
          if (status === undefined || (status !== 404 && (status < 200 || status >= 300))) {
            failures.push(diagnostic(name, row, "DELETE", status));
          }
        }
      }
    }

    for (const { name, rows } of collections) {
      console.log(`Restoring ${name} records...`);
      for (const row of rows) {
        const status = await adminWrite("PUT", `/${name}/${encodeRecordId(row.id)}`, row);
        if (status === undefined || status < 200 || status >= 300) {
          failures.push(diagnostic(name, row, "PUT", status));
        }
      }
    }

    for (const { name, rows } of collections) {
      for (const row of rows) {
        const path = `/${name}/${encodeRecordId(row.id)}`;
        let status: number | undefined;
        let restored: any;
        try {
          const res = await fetch(`${baseUrl}${path}`, {
            headers: { Authorization: auth },
            signal: AbortSignal.timeout(10_000),
          });
          status = res.status;
          if (!res.ok) throw new Error();
          restored = await res.json();
          if (!restored || typeof restored !== "object" || Array.isArray(restored)
            || restored.id !== row.id
            || (name !== "Agent" && restored.agentId !== row.agentId)) {
            throw new Error();
          }
        } catch {
          failures.push(`${diagnostic(name, row, "GET", status)}: verification failed`);
          continue;
        }
        // Report mismatched field names without mismatched content values.
        const mismatched = comparePreservedFields(name, row, restored);
        if (mismatched.length > 0) {
          failures.push(`${label(name, row)}: GET verification failed (field mismatch: ${mismatched.join(", ")})`);
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
