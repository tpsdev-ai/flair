/**
 * backup-approval.ts — `flair backup-approval`: the target host's operator
 * approves backup archives for restore (flair#2664 slice 1c).
 *
 * The approvals live in a local, operator-owned store
 * (src/lib/backup-approval-store.ts); no REST route can approve, revoke,
 * list or read them. `approve`, `legacy-admit` and `revoke` change the store
 * and need operator credentials: Basic admin credentials (`--admin-pass-file`,
 * `--admin-pass`, or FLAIR_ADMIN_PASS), which the command verifies against
 * this host's operations API on loopback with `user_info` and requires to be
 * a super_user before it writes anything, the same preflight `flair
 * federation pair` uses. The verified user name is recorded as the operator.
 * `list` only reads the store.
 *
 * `approve` takes an archive with its `.sha256` sidecar, verifies the pair as
 * restore does, and stores the exact bytes it verified. `legacy-admit` takes
 * an archive with no sidecar: it hashes and parses one read of the archive,
 * prints the digest, and approves only when the operator repeats that digest
 * with `--confirm-digest`. Both refuse an archive path whose last component
 * is a symbolic link, anything but a regular file, and a file inside the
 * store.
 *
 * Shared cli-locals are injected via bindCli() before register(); this
 * module never imports src/cli.ts.
 */
import { Command } from "commander";
import { basename } from "node:path";
import { resolveAdminUser } from "../lib/auth-resolve.js";
import { backupDigestPath, readBackupArtifact } from "../lib/backup-artifact.js";
import {
  approveArchive,
  ApprovalStoreError,
  defaultApprovalStoreRoot,
  listApprovals,
  readImportFile,
  revokeApproval,
  type ApprovalRecord,
} from "../lib/backup-approval-store.js";
import { parseRestoreArchive } from "../lib/restore-archive.js";
import * as render from "../render.js";

export type BackupApprovalCli = {
  addSharedCredentialOptions: (...args: any[]) => any;
  applyAdminPassFile: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
  resolveOpsPort: (...args: any[]) => any;
};

let cli: BackupApprovalCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: BackupApprovalCli): void {
  cli = fns;
}

const NOTHING_APPROVED = "nothing was approved";
const NOTHING_REVOKED = "nothing was revoked";

/** A refusal: print it and set a non-zero exit code. */
class Refusal extends Error {}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : "error";
}

/**
 * Verify the operator credentials against this host's operations API and
 * return the operator name to record. Throws a Refusal naming what did not
 * hold; never prints the password.
 */
async function verifyOperator(opts: any, action: string, nothing = NOTHING_APPROVED): Promise<string> {
  cli.applyAdminPassFile(opts);
  const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
  const adminUser = resolveAdminUser(opts.adminUser);
  if (!adminPass) {
    throw new Refusal(
      `${action} needs operator credentials: pass --admin-pass-file (preferred), --admin-pass, or set FLAIR_ADMIN_PASS; ${nothing}`,
    );
  }
  const opsUrl = opts.port !== undefined
    ? `http://127.0.0.1:${cli.resolveHttpPort(opts) - 1}`
    : `http://127.0.0.1:${cli.resolveOpsPort(opts)}`;
  let res: Response;
  try {
    res = await fetch(`${opsUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}` },
      body: JSON.stringify({ operation: "user_info" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Refusal(
      `could not reach this host's operations API at ${opsUrl} to verify the operator credentials ` +
        `(${error instanceof Error ? error.name : "error"}); start Flair or pass --port; ${nothing}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Refusal(`the operator credentials were refused by this host's operations API (HTTP ${res.status}); ${nothing}`);
  }
  if (!res.ok) throw new Refusal(`this host's operations API answered HTTP ${res.status} to user_info; ${nothing}`);
  const info = (await res.json().catch(() => null)) as any;
  if (info?.role?.permission?.super_user !== true) {
    throw new Refusal(`the credentials for ${adminUser} are not a super_user on this host, so they are not operator credentials; ${nothing}`);
  }
  return typeof info.username === "string" && info.username.length > 0 ? info.username : adminUser;
}

/** Read an import file, turning a refusal or read error into a Refusal. */
function importFile(path: string, describe: string): Buffer {
  try {
    return readImportFile(path, describe);
  } catch (error) {
    if (error instanceof ApprovalStoreError) throw new Refusal(`${error.message}; ${NOTHING_APPROVED}`);
    throw new Refusal(`cannot read ${describe} ${path} (${errnoCode(error)}); ${NOTHING_APPROVED}`);
  }
}

function printRecord(heading: string, record: ApprovalRecord): void {
  console.log(`${render.icons.ok} ${render.wrap(render.c.green, heading)}`);
  console.log(render.kv("SHA-256", record.sha256));
  console.log(render.kv("Admission", record.admission));
  console.log(render.kv("Approved", `${record.approvedAt} by ${record.approvedBy}`));
  if (record.revokedAt !== null) console.log(render.kv("Revoked", `${record.revokedAt} by ${record.revokedBy}`));
  console.log(render.kv("Store", defaultApprovalStoreRoot()));
}

/** Run an action; a Refusal or store error prints one error line and exits non-zero. */
async function run(action: () => Promise<void>, nothing = NOTHING_APPROVED): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Refusal) console.error(`Error: ${error.message}`);
    else if (error instanceof ApprovalStoreError) console.error(`Error: ${error.message}; ${nothing}`);
    else console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export function register(program: Command): void {
  const group = program
    .command("backup-approval")
    .description("Approve backup archives for restore on this host (a local store no REST route can reach)");

  cli.addSharedCredentialOptions(
    group
      .command("approve <archive>")
      .description("Verify an archive against its .sha256 sidecar, store its exact bytes and record your approval")
      .option("--port <port>", "Harper HTTP port of this host's Flair (its operations API verifies the credentials)"),
  ).action((archivePath: string, opts: any) => run(async () => {
    const archiveBytes = importFile(archivePath, "archive");
    const digestPath = backupDigestPath(archivePath);
    let sidecarBytes: Buffer;
    try {
      sidecarBytes = readImportFile(digestPath, "archive digest sidecar");
    } catch (error) {
      if (!(error instanceof ApprovalStoreError) && errnoCode(error) === "ENOENT") {
        throw new Refusal(
          `archive digest sidecar ${digestPath} not found; ${NOTHING_APPROVED}. Put the .sha256 file written with this ` +
            `archive beside it, or, for an archive written before flair backup published digests, use ` +
            `flair backup-approval legacy-admit ${archivePath}`,
        );
      }
      if (error instanceof ApprovalStoreError) throw new Refusal(`${error.message}; ${NOTHING_APPROVED}`);
      throw new Refusal(`cannot read archive digest sidecar ${digestPath} (${errnoCode(error)}); ${NOTHING_APPROVED}`);
    }
    // The same verification restore runs, over the two buffers just read.
    const served = new Map([[archivePath, archiveBytes], [digestPath, sidecarBytes]]);
    const verified = readBackupArtifact(archivePath, {
      stopped: NOTHING_APPROVED,
      readFile: (path) => {
        const bytes = served.get(path);
        if (bytes === undefined) throw Object.assign(new Error("unexpected read"), { code: "EINVAL" });
        return bytes;
      },
    });
    if (verified.ok === false) throw new Refusal(verified.reason);
    const operator = await verifyOperator(opts, "approval");
    const record = approveArchive({
      bytes: archiveBytes, sha256: verified.sha256, admission: "sidecar", operator, archiveName: basename(archivePath),
    });
    printRecord(`Approved ${archivePath} on this host`, record);
  }));

  cli.addSharedCredentialOptions(
    group
      .command("legacy-admit <archive>")
      .description("Approve an archive that has no .sha256 sidecar: prints its SHA-256; repeat it with --confirm-digest to approve")
      .option("--confirm-digest <sha256>", "The archive's SHA-256, as printed by a first run, confirming you approve exactly these bytes")
      .option("--port <port>", "Harper HTTP port of this host's Flair (its operations API verifies the credentials)"),
  ).action((archivePath: string, opts: any) => run(async () => {
    const bytes = importFile(archivePath, "archive");
    const digestPath = backupDigestPath(archivePath);
    let sidecarPresent = false;
    try {
      readImportFile(digestPath, "archive digest sidecar");
      sidecarPresent = true;
    } catch (error) {
      if (error instanceof ApprovalStoreError || errnoCode(error) !== "ENOENT") sidecarPresent = true;
    }
    if (sidecarPresent) {
      throw new Refusal(
        `${archivePath} has a digest sidecar at ${digestPath}, so it is not a legacy archive; ${NOTHING_APPROVED}. ` +
          `Use flair backup-approval approve ${archivePath}`,
      );
    }
    const parsed = parseRestoreArchive(bytes);
    if (parsed.ok === false) {
      const location = parsed.location === "" ? "/" : parsed.location;
      throw new Refusal(`${archivePath} is not a restorable archive: ${parsed.reason} (${parsed.code} at ${location}); ${NOTHING_APPROVED}`);
    }
    console.log(render.kv("Archive", archivePath));
    console.log(render.kv("SHA-256", parsed.sha256));
    console.log(render.kv("Size", `${bytes.length} bytes`));
    console.log(
      "An archive without a sidecar carries no record of the digest it was written with. Approving it authorizes " +
        "these exact bytes on this host until revoked; it does not show where they came from or that they are " +
        "unchanged since the backup.",
    );
    const confirmed: unknown = opts.confirmDigest;
    if (confirmed === undefined) {
      throw new Refusal(
        `legacy admission needs you to confirm the digest above; ${NOTHING_APPROVED}. Compare it with a record you ` +
          `trust, then run flair backup-approval legacy-admit ${archivePath} --confirm-digest ${parsed.sha256}`,
      );
    }
    if (confirmed !== parsed.sha256) {
      throw new Refusal(`--confirm-digest does not match the archive's SHA-256 ${parsed.sha256}; ${NOTHING_APPROVED}`);
    }
    const operator = await verifyOperator(opts, "legacy admission");
    const record = approveArchive({ bytes, sha256: parsed.sha256, admission: "legacy", operator, archiveName: basename(archivePath) });
    printRecord(`Approved ${archivePath} on this host (legacy admission)`, record);
  }));

  group
    .command("list")
    .description("List the archive approvals on this host and check each stored copy")
    .action(() => run(async () => {
      const listed = listApprovals();
      if (listed.length === 0) {
        console.log(`No archive approvals on this host (${defaultApprovalStoreRoot()}).`);
        return;
      }
      for (const { record, stored } of listed) {
        const status = record.revokedAt === null ? "approved" : `revoked ${record.revokedAt} by ${record.revokedBy}`;
        console.log(
          `${record.sha256}  ${status}  ${record.admission}  approved ${record.approvedAt} by ${record.approvedBy}  ` +
            `${record.archiveName}  stored copy ${stored}`,
        );
      }
    }, "nothing was listed"));

  cli.addSharedCredentialOptions(
    group
      .command("revoke <sha256>")
      .description("Revoke the approval of an archive digest on this host")
      .option("--port <port>", "Harper HTTP port of this host's Flair (its operations API verifies the credentials)"),
  ).action((sha256: string, opts: any) => run(async () => {
    const operator = await verifyOperator(opts, "revocation", NOTHING_REVOKED);
    const record = revokeApproval(sha256, operator);
    printRecord(`Revoked the approval of ${sha256} on this host`, record);
  }, NOTHING_REVOKED));
}
