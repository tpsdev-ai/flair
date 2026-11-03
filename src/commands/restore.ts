/**
 * restore.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { isLocalBase, resolveAdminUser, sendJsonRequest } from "../lib/auth-resolve.js";
import { readBackupArtifact } from "../lib/backup-artifact.js";
import { loadApprovedArchive } from "../lib/backup-approval-store.js";
import type { RestoreArchive } from "../lib/restore-archive.js";
import { encodeRecordId } from "../lib/record-id-path.js";
import { comparePreservedFields } from "../lib/restore-verify.js";
import { suppliesSoulScopeFields } from "../lib/soul-scope-fields.js";
import { listAgentCandidates, requireLiveListing, type ApiCall } from "../rem/restore.js";
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
    // Every preflight read goes to the same target as the writes and refuses
    // redirects. It raises ApiHttpError for a non-2xx reply, which is the shape
    // the reused candidate-listing helper turns into its route guidance.
    const preflightCall: ApiCall = (method, path, body) =>
      sendJsonRequest(new URL(`${baseUrl}${path}`), method, body, auth, isLocalBase(baseUrl), { refuseRedirects: true, withholdResponseBodyDebug: true });

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

    async function adminWrite(method: "PUT" | "DELETE", path: string, body?: unknown): Promise<{ status: number | undefined; error: string | undefined }> {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        // The refusal name is read from the body, never the outcome: a body
        // that cannot be read keeps the status this write answered with.
        let error: string | undefined;
        try {
          error = errorName(await res.text());
        } catch {
          error = undefined;
        }
        return { status: res.status, error };
      } catch {
        return { status: undefined, error: undefined };
      }
    }

    /** The `error` name in a refusal body, when it carries one. */
    function errorName(text: string): string | undefined {
      try {
        const error = (JSON.parse(text) as { error?: unknown })?.error;
        return typeof error === "string" ? error : undefined;
      } catch {
        return undefined;
      }
    }

    const label = (name: string, row: any): string =>
      `${name} ${row.id} (agent ${name === "Agent" ? row.id : row.agentId})`;
    const diagnostic = (name: string, row: any, method: string, status: number | undefined): string =>
      `${label(name, row)}: ${method} failed (HTTP ${status ?? "unavailable"})`;

    if (mode === "replace") {
      // A replace replay sends every archived Soul row back whole after
      // deleting the archived ids. The server refuses a Soul write that
      // supplies a non-empty `scopeTag` or `tags` array (flair#1540) or whose
      // `value` equals a same-agent Memory content or MemoryCandidate claim
      // (resources/soul-write-policy.ts), so a row either rule would refuse
      // must stop the replay before the deletes, or the refused row may lose
      // its live copy (flair#2931, #2941). Merge mode deletes nothing and is
      // not checked here.
      //
      // The learned-content comparison runs against the state each Soul PUT
      // will meet: the archived Memory ids are deleted first and written back
      // after the Souls, so a live Memory row counts only when its id is not
      // in the archive. Every live candidate counts: replace never deletes
      // MemoryCandidate rows.
      const LEARNED_REFUSAL = "soul_value_is_learned_content";
      const writtenSouls = souls;
      const refusals: string[] = [];
      const scopeRefused = new Set<string>();
      for (const row of writtenSouls) {
        if (!suppliesSoulScopeFields(row)) continue;
        scopeRefused.add(String(row.id));
        refusals.push(
          `Error: Soul ${row.id}: supplies a non-empty scopeTag or tags array, `
            + "which the Soul scope-field rule refuses; no rows were deleted",
        );
      }

      // Soul id -> value each Soul PUT will send, per owning agent.
      const learnedCandidates = new Map<string, Map<string, string[]>>();
      for (const row of writtenSouls) {
        const id = String(row.id);
        if (scopeRefused.has(id)) continue;
        if (typeof row.value !== "string" || row.value === "") continue;
        if (typeof row.agentId !== "string" || row.agentId === "") continue;
        let byValue = learnedCandidates.get(row.agentId);
        if (byValue === undefined) {
          byValue = new Map();
          learnedCandidates.set(row.agentId, byValue);
        }
        const ids = byValue.get(row.value) ?? [];
        ids.push(id);
        byValue.set(row.value, ids);
      }

      const learnedRefusal = (soulId: string, table: "Memory" | "MemoryCandidate", row: any): string => {
        const field = table === "Memory" ? "content" : "claim";
        const subject = row?.id === undefined || row.id === null || row.id === ""
          ? `a ${table} row without an id`
          : `${table} ${row.id}`;
        return `Error: Soul ${soulId}: its value equals the ${field} of the same agent's ${subject}, `
          + `which the Soul learned-content rule refuses (${LEARNED_REFUSAL}); `
          + `remove or edit that ${table} row or the archived Soul's value, then re-run; no rows were deleted`;
      };

      // A live Memory row whose id is in the archive is deleted before the
      // Souls are written, so it does not count as a survivor.
      const archivedMemoryIds = new Set(
        memories.filter((row: any) => row?.id !== undefined && row.id !== null && row.id !== "").map((row: any) => String(row.id)),
      );

      try {
        for (const [agentId, byValue] of learnedCandidates) {
          const liveMemories = requireLiveListing(
            await preflightCall("GET", `/Memory?agentId=${encodeURIComponent(agentId)}`),
            "Memory",
            agentId,
          );
          const survivorByContent = new Map<string, any>();
          for (const memory of liveMemories) {
            if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
              throw new Error(`the Memory listing for agent ${agentId} carries a row that is not an object`);
            }
            if (memory.agentId !== agentId) continue;
            if (typeof memory.content !== "string") continue;
            const id = memory.id === undefined || memory.id === null || memory.id === "" ? undefined : String(memory.id);
            if (id !== undefined && archivedMemoryIds.has(id)) continue;
            if (!survivorByContent.has(memory.content)) survivorByContent.set(memory.content, memory);
          }

          const unmatched = new Map(byValue);
          for (const [value, soulIds] of byValue) {
            const match = survivorByContent.get(value);
            if (match === undefined) continue;
            for (const soulId of soulIds) refusals.push(learnedRefusal(soulId, "Memory", match));
            unmatched.delete(value);
          }
          if (unmatched.size === 0) continue;

          // The admin candidate route lists ids only; each row is read once to
          // compare its claim exactly, as the server does.
          const candidates = await listAgentCandidates(preflightCall, agentId);
          for (const candidate of candidates) {
            if (unmatched.size === 0) break;
            const row = await preflightCall("GET", `/MemoryCandidate/${encodeRecordId(candidate.id)}`);
            if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.claim !== "string") {
              throw new Error(`MemoryCandidate ${candidate.id} could not be read as a row with a claim`);
            }
            if (row.agentId !== agentId) continue;
            const soulIds = unmatched.get(row.claim);
            if (soulIds === undefined) continue;
            for (const soulId of soulIds) refusals.push(learnedRefusal(soulId, "MemoryCandidate", candidate));
            unmatched.delete(row.claim);
          }
        }
      } catch (err: any) {
        console.error(`Error: ${err?.message ?? String(err)}`);
        console.error(
          "Error: the replace stopped before any delete: a Soul write rule could not be checked against "
            + "the live rows; check the target's Memory listing and MemoryCandidate listing responses, "
            + "then re-run. No rows were deleted.",
        );
        process.exitCode = 1;
        return;
      }

      if (refusals.length > 0) {
        for (const refusal of refusals) console.error(refusal);
        process.exitCode = 1;
        return;
      }
      console.log("\nDeleting existing data (replace mode)...");
      for (const { name, rows } of collections.filter(({ name }) => name !== "Agent")) {
        for (const row of rows) {
          const { status } = await adminWrite("DELETE", `/${name}/${encodeRecordId(row.id)}`);
          if (status === undefined || (status !== 404 && (status < 200 || status >= 300))) {
            failures.push(diagnostic(name, row, "DELETE", status));
          }
        }
      }
    }

    for (const { name, rows } of collections) {
      console.log(`Restoring ${name} records...`);
      for (const row of rows) {
        const { status, error } = await adminWrite("PUT", `/${name}/${encodeRecordId(row.id)}`, row);
        if (status === undefined || status < 200 || status >= 300) {
          // A failed Soul write appends the refusal name the server returned,
          // so a learned-content 403 is named rather than read as an auth
          // failure (flair#2931, #2941).
          failures.push(`${diagnostic(name, row, "PUT", status)}${name === "Soul" && error ? `: ${error}` : ""}`);
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
