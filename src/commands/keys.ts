import { Command } from "commander";
import { existsSync, lstatSync, mkdirSync, renameSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import * as render from "../render.js";
import { loadEd25519PrivateKeyFromFile } from "../mcp-client-assertion.js";
import { defaultAdminPassPath, defaultKeysDir, isLocalBase, resolveAdminUser, resolveLocalAdminPass } from "../lib/auth-resolve.js";
import { probeInstanceIds, type OpsEndpoint } from "../lib/instance-identity-row.js";
import { SEED_OWNER_SUFFIX, readSeedOwnerAt } from "../keystore.js";
import {
  describeAgentGateFinding,
  classifyKeyFile,
  classifyOwnedNodeSeed,
  isNodeKeyId,
  partitionKeyIds,
  resolveCollisionSafeName,
  pruneDateStamp,
  PRUNED_DIR_NAME,
  type AgentGateState,
  type KeyPruneClass,
} from "../doctor-client.js";

export type KeysCli = {
  checkAgentRegistered: (
    baseUrl: string,
    agentId: string,
    keysDir: string,
  ) => Promise<{ state: AgentGateState; detail?: string }>;
  probeFlairReachable: (url: string, timeoutMs?: number) => Promise<boolean>;
  resolveBaseUrl: (opts: { target?: string; url?: string; port?: string | number }) => string;
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
  resolveHttpPort: (opts: { port?: string | number; dataDir?: string }) => number;
  readPortFromHarperConfig: (dataDir: string) => number | null;
};

let cli: KeysCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: KeysCli): void {
  cli = fns;
}

const checkAgentRegistered = (
  baseUrl: string,
  agentId: string,
  keysDir: string,
): Promise<{ state: AgentGateState; detail?: string }> => cli.checkAgentRegistered(baseUrl, agentId, keysDir);

const probeFlairReachable = (url: string, timeoutMs?: number): Promise<boolean> =>
  cli.probeFlairReachable(url, timeoutMs);

const resolveBaseUrl = (opts: { target?: string; url?: string; port?: string | number }): string =>
  cli.resolveBaseUrl(opts);

const resolveOpsPort = (opts: { opsPort?: string | number; port?: string | number }): number =>
  cli.resolveOpsPort(opts);

const resolveHttpPort = (opts: { port?: string | number; dataDir?: string }): number =>
  cli.resolveHttpPort(opts);

// ─── flair keys ────────────────────────────────────────────────────────────────
// flair#734 — recoverable cleanup of stale/unregistered/invalid key files in
// the key dir. Follow-up to #731's doctor agent-iteration, which made this
// state visible (every stale key renders as a "not registered" gate finding,
// src/doctor-client.ts describeAgentGateFinding) but shipped no way to act on
// it — every doctor run just re-reported the same noise, and the dir kept
// accreting e2e-test leftovers. `agent remove <id>` already handles the
// REGISTERED case (agent + key together); this fills the gap for keys with no
// agent behind them at all: test leftovers, renamed-agent leftovers, and
// files that were never valid Ed25519 seeds to begin with.
//
// classifyKeysDir/applyKeyPrune are exported (not inlined in the action) so
// they're directly unit-testable with a mocked fetch + a temp keys dir, same
// pattern as checkAgentRegistered/probeFlairReachable above (see
// test/unit/doctor-client-network.test.ts) — no subprocess, no real ~/.flair.

export interface KeysPruneEntry {
  name: string;
  class: KeyPruneClass;
  reason: string;
  agentId?: string;
}

/** What the Instance-table read established for the orphan check. */
export type InstanceIdsRead =
  | { state: "read"; ids: string[]; agentIds?: string[] | null; agentReadReason?: string; dataDir?: string }
  | { state: "unreadable"; reason: string; bindingRefused?: boolean };

export interface KeysPruneResult {
  /** Refused runs return no entries. */
  aborted: boolean;
  abortReason?: string;
  entries: KeysPruneEntry[];
  /** Null when no node-shaped seed needed a reference check. */
  orphanRead: InstanceIdsRead | null;
}

/** Best-effort seed-validity check for a `.key` file: does it parse via any
 *  of the formats loadEd25519PrivateKeyFromFile (src/mcp-client-assertion.ts
 *  — the same loader `flair mcp token` uses) accepts? Never throws — used
 *  only to decide "unidentified" vs. "worth a registration check", not to
 *  actually sign anything. An unparseable file is not junk: the keys dir is
 *  also where FileKeyStore writes AES-256-GCM blobs (flair#1026). */
function isValidPrivateKeySeedFile(keyPath: string): boolean {
  try {
    loadEd25519PrivateKeyFromFile(keyPath);
    return true;
  } catch {
    return false;
  }
}

/** Classify files without moving them; node-shaped seeds are report-only (#2200). */
export async function classifyKeysDir(
  keysDir: string,
  baseUrl: string,
  readInstanceIds: () => Promise<InstanceIdsRead>,
): Promise<KeysPruneResult> {
  if (!existsSync(keysDir)) return { aborted: false, entries: [], orphanRead: null };

  const dirents = readdirSync(keysDir, { withFileTypes: true });
  const entries: KeysPruneEntry[] = [];
  const candidates: Array<{ name: string; agentId: string }> = [];

  for (const d of dirents) {
    if (d.isDirectory()) {
      entries.push({
        name: d.name,
        class: "ignored",
        reason: d.name === PRUNED_DIR_NAME ? "prune archive directory" : "directory (not a key file)",
      });
      continue;
    }
    if (!d.name.endsWith(".key")) {
      entries.push({ name: d.name, class: "ignored", reason: "not a .key file" });
      continue;
    }
    candidates.push({ name: d.name, agentId: d.name.slice(0, -".key".length) });
  }

  const { nodeKeyIds } = partitionKeyIds(candidates.map((c) => c.agentId), keysDir);
  const orphanRead = nodeKeyIds.length > 0 ? await readInstanceIds() : null;
  if (orphanRead?.state === "unreadable" && orphanRead.bindingRefused) {
    return { aborted: true, abortReason: orphanRead.reason, entries: [], orphanRead };
  }
  const instanceIds = orphanRead?.state === "read" ? orphanRead.ids : null;
  const targetDataDir = orphanRead?.state === "read" ? orphanRead.dataDir ?? null : null;

  for (const c of candidates) {
    const keyPath = join(keysDir, c.name);

    if (isNodeKeyId(c.agentId, keysDir)) {
      const ownerPath = join(keysDir, `${c.name}${SEED_OWNER_SUFFIX}`);
      const decision = classifyOwnedNodeSeed(c.agentId, instanceIds, baseUrl,
        orphanRead?.state === "read" ? orphanRead.agentIds ?? null : null,
        { owner: readSeedOwnerAt(ownerPath), keyPath, ownerPath, targetDataDir },
        orphanRead?.state === "read" ? orphanRead.agentReadReason : orphanRead?.reason);
      entries.push({ name: c.name, class: decision.class, reason: decision.reason, agentId: c.agentId });
      continue;
    }

    if (!isValidPrivateKeySeedFile(keyPath)) {
      const decision = classifyKeyFile(c.agentId, false, null, baseUrl);
      entries.push({ name: c.name, class: decision.class, reason: decision.reason, agentId: c.agentId });
      continue;
    }

    const reg = await checkAgentRegistered(baseUrl, c.agentId, keysDir);
    if (reg.state === "unreachable") {
      return {
        aborted: true,
        abortReason:
          `could not reach ${baseUrl} to verify agent '${c.agentId}' is registered` +
          `${reg.detail ? ` (${reg.detail})` : ""} — aborting; nothing was classified or moved. ` +
          `Pass --instance <url> to target a different instance.`,
        entries: [],
        orphanRead,
      };
    }
    // flair#1023 added "key-unreadable". It cannot occur here — this key's
    // seed already parsed via isValidPrivateKeySeedFile above — but is
    // handled explicitly rather than folded into the else: a key that will
    // not load is "unidentified", not prunable "invalid" (flair#1026).
    const decision = reg.state === "key-unreadable"
      ? classifyKeyFile(c.agentId, false, null, baseUrl)
      : classifyKeyFile(c.agentId, true, { state: reg.state, detail: reg.detail }, baseUrl);
    entries.push({ name: c.name, class: decision.class, reason: decision.reason, agentId: c.agentId });
  }

  return { aborted: false, entries, orphanRead };
}

/** Sidecar path type without following symlinks (lstat). */
type SidecarPathKind =
  | { kind: "absent" }
  | { kind: "regular" }
  | { kind: "refused"; type: string }
  | { kind: "unreadable"; error: string };

/** Classify the path where `key`'s ownership sidecar would be (lstat — a symlink
 *  is reported as itself, never followed). A failed lstat that is not ENOENT
 *  is `unreadable`, not `absent`: prune must not move the key on unknown
 *  evidence. */
function sidecarPathKind(ownerPath: string): SidecarPathKind {
  let st: Stats;
  try {
    st = lstatSync(ownerPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", error: code ?? String(err) };
  }
  if (st.isFile()) return { kind: "regular" };
  if (st.isSymbolicLink()) return { kind: "refused", type: "symbolic link" };
  if (st.isDirectory()) return { kind: "refused", type: "directory" };
  if (st.isFIFO()) return { kind: "refused", type: "FIFO" };
  if (st.isSocket()) return { kind: "refused", type: "socket" };
  return { kind: "refused", type: "not a regular file" };
}

/** A key moved into the archive, with its destination path. */
export interface KeysPruneMove {
  name: string;
  movedTo: string;
}

/** A prunable key left where it was, with why. */
export interface KeysPruneSkip {
  name: string;
  ownerPath: string;
  reason: string;
}

/** The outcome of an --apply run: what moved and what was left in place. */
export interface KeysPruneOutcome {
  moved: KeysPruneMove[];
  skipped: KeysPruneSkip[];
}

/** Archive prunable agent keys; node-shaped files without .pub stay in place.
 *  The post-move check tests the archive path's type, not object identity.
 *  The source path can change after pre-move/absence checks; the archive path
 *  can change between move and check or after the check, before the key moves. */
export function applyKeyPrune(
  keysDir: string,
  entries: KeysPruneEntry[],
  dateStamp: string,
  move: typeof renameSync = renameSync,
): KeysPruneOutcome {
  const prunable = entries.filter((e) => {
    const nodeShaped = isNodeKeyId(e.name.replace(/\.key$/, ""), keysDir);
    return !nodeShaped && (e.class === "stale" || e.class === "invalid");
  });
  const moved: KeysPruneMove[] = [];
  const skipped: KeysPruneSkip[] = [];
  if (prunable.length === 0) return { moved, skipped };

  const destDir = join(keysDir, PRUNED_DIR_NAME, dateStamp);
  // Created before the first attempted move.
  let existing: Set<string> | undefined;
  const archiveNames = (): Set<string> => {
    if (!existing) {
      mkdirSync(destDir, { recursive: true });
      existing = new Set(readdirSync(destDir));
    }
    return existing;
  };

  for (const e of prunable) {
    const fromOwner = join(keysDir, `${e.name}${SEED_OWNER_SUFFIX}`);
    const ownerKind = sidecarPathKind(fromOwner);
    if (ownerKind.kind === "refused" || ownerKind.kind === "unreadable") {
      const why = ownerKind.kind === "refused"
        ? `${fromOwner} is a ${ownerKind.type}, not a regular file`
        : `${fromOwner} could not be checked (${ownerKind.error})`;
      skipped.push({
        name: e.name,
        ownerPath: fromOwner,
        reason: `${why}; the key and the sidecar path are left in place`,
      });
      continue;
    }

    const names = archiveNames();
    const destName = resolveCollisionSafeName(names, e.name);
    names.add(destName);
    const from = join(keysDir, e.name);
    const to = join(destDir, destName);
    const destOwnerName = resolveCollisionSafeName(names, `${destName}${SEED_OWNER_SUFFIX}`);
    const toOwner = join(destDir, destOwnerName);
    let ownerMoved = false;
    try {
      move(fromOwner, toOwner);
      ownerMoved = true;
      names.add(destOwnerName);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (sidecarPathKind(fromOwner).kind !== "absent") {
        skipped.push({
          name: e.name,
          ownerPath: fromOwner,
          reason: `${fromOwner} changed during the move attempt; the key is left in place`,
        });
        continue;
      }
    }
    if (ownerMoved) {
      const movedKind = sidecarPathKind(toOwner);
      if (movedKind.kind !== "regular") {
        move(toOwner, fromOwner);
        names.delete(destOwnerName);
        const why = movedKind.kind === "refused"
          ? `is a ${movedKind.type}, not a regular file`
          : movedKind.kind === "unreadable"
            ? `could not be checked (${movedKind.error})`
            : "was absent at its destination";
        skipped.push({
          name: e.name,
          ownerPath: fromOwner,
          reason: `${toOwner} ${why}; the archive-path entry was moved back and the key stayed active`,
        });
        continue;
      }
    }
    try {
      move(from, to);
    } catch (err) {
      if (ownerMoved) move(toOwner, fromOwner);
      throw err;
    }
    moved.push({ name: e.name, movedTo: to });
  }
  return { moved, skipped };
}

/** Require the HTTP target's Instance id to match the sole ops Instance id. */
export function makeReadInstanceIds(deps: {
  baseUrl: string;
  port?: string | number;
  dataDir?: string;
  resolveHttpPort: (opts: { port?: string | number }) => number;
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
  resolveAdminPass?: () => string | undefined;
  probe?: (endpoint: OpsEndpoint) => Promise<InstanceIdsRead>;
}): () => Promise<InstanceIdsRead> {
  const { baseUrl, port, dataDir } = deps;
  const resolveAdminPass = deps.resolveAdminPass ?? (() => resolveLocalAdminPass(undefined));
  const probe = deps.probe ?? probeInstanceIds;
  return async () => {
    if (dataDir !== undefined) {
      return {
        state: "unreadable",
        bindingRefused: true,
        reason: `Data directory ${dataDir} refused: its identity cannot be verified against the running target ${baseUrl}; nothing moved`,
      };
    }
    let target: URL;
    try { target = new URL(baseUrl); } catch {
      return { state: "unreadable", reason: "invalid target URL" };
    }
    if (!isLocalBase(baseUrl)) {
      return {
        state: "unreadable",
        reason: `the Instance rows are read through the local ops API, and ${baseUrl} is not on this host`,
      };
    }
    if (target.protocol !== "http:" || target.username || target.password ||
        target.pathname !== "/" || target.search || target.hash) {
      return { state: "unreadable", reason: "target is not a direct local HTTP endpoint" };
    }
    const httpPort = Number(target.port || 80);
    if (httpPort !== deps.resolveHttpPort({ port })) {
      return { state: "unreadable", reason: `the ops port for ${baseUrl} is not known on this host` };
    }
    const opsPort = deps.resolveOpsPort({ port });
    if (opsPort !== httpPort - 1) {
      return { state: "unreadable", reason: `selected ops port ${opsPort} differs from target-derived ops port ${httpPort - 1}` };
    }
    let pass: string | undefined;
    try {
      pass = resolveAdminPass();
    } catch (err: unknown) {
      return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
    }
    if (!pass?.trim()) {
      return { state: "unreadable", reason: `no local admin credential at ${defaultAdminPassPath()} to read the Instance rows with` };
    }
    const credentials = { user: resolveAdminUser(undefined), pass };
    let targetId: string;
    try {
      const response = await fetch(new URL("/HealthDetail", target).href, {
        method: "GET",
        headers: { Authorization: `Basic ${Buffer.from(`${credentials.user}:${pass}`).toString("base64")}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const instance = (await response.json())?.federation?.instance;
      if (instance?.multiple || instance?.unreadable || typeof instance?.id !== "string" || !instance.id.trim()) {
        throw new Error("HealthDetail returned no single Instance id");
      }
      targetId = instance.id;
    } catch (err: unknown) {
      return { state: "unreadable", reason: `target identity unreadable (${err instanceof Error ? err.message : String(err)})` };
    }
    const read = await probe({
      opsUrl: `http://127.0.0.1:${opsPort}`,
      credentials,
    });
    if (read.state === "unreadable") return read;
    if (read.ids.length !== 1) {
      return { state: "unreadable", reason: "ops identity unreadable: expected a single Instance id" };
    }
    if (read.ids[0] !== targetId) {
      return { state: "unreadable", reason: "target/ops Instance id mismatch" };
    }
    return { ...read, dataDir };
  };
}

/** Register the `flair keys` command group (flair#1629). */
export function register(program: Command): void {
  const keys = program.command("keys").description("Manage Ed25519 key files in the key directory");

  keys
    .command("prune")
    .description("Move stale/unregistered agent keys to <keysDir>/.pruned/<date>/; node-shaped files without .pub stay report-only — dry-run by default")
    .option("--apply", "Actually move prunable keys (default: dry-run, prints what would move and why)")
    .option("--keys-dir <dir>", "Directory to scan for key files (else FLAIR_KEY_DIR, ~/.flair/keys)")
    .option("--instance <url>", "Flair instance to check registration against (else FLAIR_TARGET/FLAIR_URL/config)")
    .option("--port <port>", "Harper HTTP port (used when --instance/FLAIR_URL/FLAIR_TARGET are not set)")
    .action(async (opts) => {
      const keysDir: string = opts.keysDir ?? process.env.FLAIR_KEY_DIR ?? defaultKeysDir();
      const apply = !!opts.apply;
      const baseUrl = resolveBaseUrl({ target: opts.instance, port: opts.port });
      const readInstanceIds = makeReadInstanceIds({
        baseUrl, port: opts.port, resolveHttpPort, resolveOpsPort,
      });

      console.log(`\n${render.wrap(render.c.bold, "🔑 Flair Keys Prune")}${apply ? "" : render.wrap(render.c.dim, " (dry run)")}\n`);
      console.log(`  Keys directory: ${render.wrap(render.c.dim, keysDir)}`);
      console.log(`  Instance:       ${render.wrap(render.c.dim, baseUrl)}`);
      console.log("");

      const result = await classifyKeysDir(keysDir, baseUrl, readInstanceIds);
      if (result.aborted) {
        console.error(`  ${render.icons.error} ${result.abortReason}`);
        console.log("");
        process.exit(1);
      }

      const stale = result.entries.filter((e) => e.class === "stale");
      const invalid = result.entries.filter((e) => e.class === "invalid");
      const orphanSeeds = result.entries.filter((e) => e.class === "orphan-seed");
      const orphan = result.entries.filter((e) => e.class === "orphan-candidate");
      const unidentified = result.entries.filter((e) => e.class === "unidentified");
      const kept = result.entries.filter((e) => e.class === "keep");
      const ignored = result.entries.filter((e) => e.class === "ignored");
      const prunable = [...stale, ...invalid, ...orphanSeeds];

      if (stale.length + invalid.length + orphanSeeds.length + orphan.length + unidentified.length + kept.length === 0) {
        console.log(`  ${render.icons.ok} No key files found in ${render.wrap(render.c.dim, keysDir)} — nothing to prune.`);
        console.log("");
        return;
      }

      for (const e of prunable) {
        const icon = e.class === "invalid" ? render.icons.error : render.icons.warn;
        const label = e.class === "orphan-seed" ? "orphan instance seed" : e.class;
        console.log(`  ${icon} ${render.wrap(render.c.bold, e.name)} — ${label}: ${e.reason}`);
      }
      for (const e of orphan) {
        console.log(`  ${render.icons.info} ${render.wrap(render.c.bold, e.name)} — orphan candidate: ${e.reason}`);
      }
      for (const e of unidentified) {
        console.log(`  ${render.icons.warn} ${render.wrap(render.c.bold, e.name)} — unidentified: ${e.reason}`);
      }
      for (const e of kept) {
        console.log(`  ${render.icons.ok} ${render.wrap(render.c.bold, e.name)} — ${e.reason}`);
      }
      if (result.orphanRead?.state === "unreadable") {
        console.log(
          `  ${render.icons.warn} ${render.wrap(render.c.yellow, `Instance reference check unavailable (${result.orphanRead.reason}) — no orphan candidates determined.`)}`,
        );
      }

      if (!apply) {
        console.log("");
        console.log(
          `  ${render.wrap(render.c.dim, `${prunable.length} prunable (${stale.length} stale, ${invalid.length} invalid, ${orphanSeeds.length} orphan instance seed(s)), ${orphan.length} orphan candidate(s) (left in place), ${kept.length} kept, ${unidentified.length} unidentified (left in place), ${ignored.length} ignored`)}`,
        );
        if (prunable.length > 0) {
          console.log(`  ${render.wrap(render.c.dim, "Run with --apply to move prunable keys (keys with refused sidecars stay in place) to")} ${join(keysDir, PRUNED_DIR_NAME, pruneDateStamp())}`);
        }
        console.log("");
        return;
      }

      const { moved, skipped } = applyKeyPrune(keysDir, result.entries, pruneDateStamp());
      console.log("");
      for (const m of moved) {
        console.log(`  ${render.icons.ok} moved ${m.name} -> ${m.movedTo}`);
      }
      for (const s of skipped) {
        console.log(`  ${render.icons.warn} ${render.wrap(render.c.bold, s.name)} — not moved: ${s.reason}`);
      }
      console.log(`\n  ${render.wrap(render.c.bold, String(moved.length))} moved, ${skipped.length} left in place, ${orphan.length} orphan candidate(s) (left in place), ${kept.length} kept, ${unidentified.length} unidentified (left in place), ${ignored.length} ignored\n`);
    });
}
