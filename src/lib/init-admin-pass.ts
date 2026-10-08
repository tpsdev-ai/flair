/**
 * init-admin-pass.ts — flair#837: the missing-file + persisted-Harper-user
 * case that #827 could not close.
 *
 * #827 made `flair init` reuse `~/.flair/admin-pass` when the file is already
 * present. The remaining footgun is the file MISSING while Harper's data dir
 * already holds an admin user: `HDB_ADMIN_PASSWORD` only seeds a brand-new
 * install, so generating a fresh file there desyncs from the stored hash and
 * the next ops-API call 401s.
 *
 * This module is the single decision + the two exits that can actually be
 * right: re-persist a supplied original credential, or rotate the stored
 * hash through the ops-API domain socket (`alter_user`, no Authorization).
 * Silent regeneration is never a decision here.
 *
 * Security property the rotate path relies on (flair#837 condition 2,
 * #1704): the ops domain socket is a Harper `super_user` channel with no
 * Authorization header (`bypassLocalAuth` is an else-if on "no header
 * present"). That is safe ONLY because of the socket posture — parent dir
 * 0700, socket 0600. The rotate path refuses if the socket is not
 * owner-only. `--reset-admin-pass` is the only path that may rotate; it
 * prints the user, socket, and destination file before doing it.
 *
 * Pure decision helpers are exported for unit tests. The socket POST is a
 * thin `node:http` client against `dataDir/operations-server`.
 */
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { closeSync, existsSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Copy-pasteable recovery commands. Tests assert these strings verbatim. */
export const INIT_RESET_ADMIN_PASS_COMMAND = "flair init --reset-admin-pass";
export const INIT_ADMIN_PASS_FILE_COMMAND = "flair init --admin-pass-file <path>";
export const INIT_STOP_FOREIGN_COMMAND = "flair stop";

export type InitAdminPasswordDecision =
  | "reuse-existing"
  | "generate-new"
  | "re-persist"
  | "rotate"
  | "refuse";

export type InitAdminPasswordRefuseReason =
  | "persisted-missing-file"
  | "foreign-instance"
  | "reset-without-socket"
  | "socket-not-owner-only"
  | "socket-not-ready";

/** Short doctor remedy — names the two exits as the fix (report-only). */
export const ADMIN_PASS_DESYNC_REMEDY =
  `Fix: ${INIT_ADMIN_PASS_FILE_COMMAND} (if you have the original) or ${INIT_RESET_ADMIN_PASS_COMMAND}`;

export interface InitAdminPasswordContext {
  /** Harper already has a user record in THIS data dir (hdb_user mdb). */
  persistedAdminUser?: boolean;
  /**
   * Something is already answering on the chosen HTTP port, but THIS data
   * dir has no persisted user — a leftover process from a previous install
   * (the 2026-09-02 canary variant).
   */
  foreignInstanceOnPort?: boolean;
  /** Operator supplied --admin-pass / --admin-pass-file / FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD. */
  explicitCredential?: boolean;
  /** Operator asked to rotate (`--reset-admin-pass`). */
  resetRequested?: boolean;
  /**
   * The ops socket is reachable now, or init is about to start Harper so it
   * will be. False only when `--skip-start` and nothing is listening.
   */
  opsSocketAvailable?: boolean;
}

/**
 * Decide the admin-password action for `flair init`.
 *
 * One-arg form (`adminPassFileExists`) is the #827 contract and must keep
 * answering `reuse-existing` / `generate-new`. The optional second argument
 * is the #837 persisted-user / foreign-instance / reset context. On a call
 * that omits it, a missing file is still a fresh install.
 */
export function resolveInitAdminPasswordSource(
  adminPassFileExists: boolean,
  ctx: InitAdminPasswordContext = {},
): InitAdminPasswordDecision {
  const persisted = !!ctx.persistedAdminUser;
  const foreign = !!ctx.foreignInstanceOnPort;
  const explicit = !!ctx.explicitCredential;
  const reset = !!ctx.resetRequested;
  const socketOk = ctx.opsSocketAvailable !== false;

  if (foreign && !adminPassFileExists && !explicit) {
    return "refuse";
  }

  if (adminPassFileExists && !reset) {
    return "reuse-existing";
  }

  if (explicit && !reset) {
    return "re-persist";
  }

  if (!adminPassFileExists && !persisted && !reset) {
    return "generate-new";
  }

  // Rotate is production credential rotation. The ONLY way in is the
  // explicit `--reset-admin-pass` flag — never a missing-file guess.
  if (reset) {
    return socketOk ? "rotate" : "refuse";
  }

  if (persisted && !adminPassFileExists) {
    return "refuse";
  }

  return adminPassFileExists ? "reuse-existing" : "generate-new";
}

/** Why a `refuse` decision was reached — drives the exact recovery command. */
export function resolveInitAdminPasswordRefuseReason(
  adminPassFileExists: boolean,
  ctx: InitAdminPasswordContext = {},
): InitAdminPasswordRefuseReason | null {
  if (resolveInitAdminPasswordSource(adminPassFileExists, ctx) !== "refuse") return null;
  if (ctx.foreignInstanceOnPort && !adminPassFileExists && !ctx.explicitCredential) {
    return "foreign-instance";
  }
  if (ctx.resetRequested && ctx.opsSocketAvailable === false) {
    return "reset-without-socket";
  }
  return "persisted-missing-file";
}

/**
 * Where each storage engine keeps the system schema (and so the admin user).
 *
 * Older data directories use LMDB: one file per table, at
 * `system/hdb_user/data.mdb`, or the legacy single `system/hdb_user.mdb`.
 *
 * Harper 5 uses RocksDB: the whole `system` database is ONE column-family
 * database at `database/system`, and each table's primary store is a column
 * family named `<table>/` (Harper names a table's primary store with a
 * trailing slash).
 */
export const HARPER_SYSTEM_DB_REL = join("database", "system");
export const HDB_USER_PRIMARY_CF = "hdb_user/";

/**
 * Match `hdb_user/` or the `hdb_user/@` prefix.
 */
export function isHdbUserPrimaryColumn(column: string): boolean {
  return column === HDB_USER_PRIMARY_CF || column.startsWith(`${HDB_USER_PRIMARY_CF}@`);
}

/**
 * Count the rows in the `hdb_user` primary store of a Harper 5 system
 * database, opened READ-ONLY (RocksDB read-only needs no lock, so this works
 * while the instance is running, and writes nothing).
 *
 * Both physical layouts are accepted (see `isHdbUserPrimaryColumn`); every
 * matching family is counted.
 *
 * `@harperfast/rocksdb-js` is resolved through the installed `harper`
 * package: flair does not depend on it directly, and the reader must be the
 * same engine Harper wrote the store with.
 */
export function countRocksAdminUsers(systemDbDir: string): number {
  const requireFromHere = createRequire(import.meta.url);
  const rocksPath = createRequire(requireFromHere.resolve("harper")).resolve(
    "@harperfast/rocksdb-js",
  );
  const { RocksDatabase } = requireFromHere(rocksPath) as {
    RocksDatabase: {
      open: (path: string, options?: Record<string, unknown>) => {
        columns?: string[];
        name?: string;
        getKeysCount: () => number;
        close?: () => void;
      };
    };
  };
  const probe = RocksDatabase.open(systemDbDir, { readOnly: true });
  let userStores: string[];
  try {
    if (!Array.isArray(probe.columns) || !probe.columns.every(column => typeof column === "string")) {
      throw new Error(`Invalid RocksDB columns metadata at ${systemDbDir}`);
    }
    userStores = probe.columns.filter(isHdbUserPrimaryColumn);
  } finally {
    probe.close?.();
  }
  if (userStores.length === 0) {
    throw new Error(
      `MISSING_HDB_USER_COLUMN: existing system store at ${systemDbDir} lacks ${HDB_USER_PRIMARY_CF}. Repair the system store or select the correct --data-dir.`,
    );
  }
  let total = 0;
  for (const name of userStores) {
    const users = RocksDatabase.open(systemDbDir, { name, readOnly: true });
    try {
      total += users.getKeysCount();
    } finally {
      users.close?.();
    }
  }
  return total;
}

/** A populated user store is evidence that the install is not fresh. */
export function detectPersistedAdminUser(dataDir: string): boolean {
  for (const path of [join(dataDir, "system", "hdb_user", "data.mdb"), join(dataDir, "system", "hdb_user.mdb")]) {
    try {
      const fd = openSync(path, "r");
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const systemDbDir = join(dataDir, HARPER_SYSTEM_DB_REL);
  try {
    lstatSync(systemDbDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  return countRocksAdminUsers(systemDbDir) > 0;
}

export function initAdminPassRefusalMessage(
  reason: InitAdminPasswordRefuseReason,
  opts: {
    dataDir?: string;
    httpPort?: number;
    pid?: number;
    adminPassPath?: string;
    socketPath?: string;
    /**
     * Foreign-instance only. Default true keeps the historical `flair stop`
     * line from before the occupied-listener detail. `flair init` passes
     * false: those messages do not offer `flair stop`. `flair stop` cannot
     * be promised to act on this listener (flair#1749).
     */
    offerFlairStop?: boolean;
  } = {},
): string {
  if (reason === "foreign-instance") {
    const port = opts.httpPort ?? 19926;
    const pid = opts.pid === undefined ? "" : `, pid ${opts.pid}`;
    const head =
      `Refusing init: port ${port}${pid}: persisted admin user was not detected in this data directory.`;
    if (opts.offerFlairStop === false) return head;
    return (
      `${head} Stop that process before initializing a new instance:\n  ${INIT_STOP_FOREIGN_COMMAND}`
    );
  }
  if (reason === "reset-without-socket") {
    return (
      `Cannot rotate the admin password: Harper is not running and --skip-start was set, so the operations socket is unreachable. ` +
      `Start the instance, then run:\n  ${INIT_RESET_ADMIN_PASS_COMMAND}`
    );
  }
  if (reason === "socket-not-owner-only") {
    const socket = opts.socketPath ?? "<data-dir>/operations-server";
    return (
      `Refusing to rotate the admin password: the operations socket at ${socket} is not owner-only ` +
      `(required: parent dir 0700 / socket 0600, flair#1704). The socket is a super_user channel ` +
      `with no Authorization header, so a group/world-accessible socket would expose credential rotation. ` +
      `Fix the posture, then run:\n  ${INIT_RESET_ADMIN_PASS_COMMAND}`
    );
  }
  if (reason === "socket-not-ready") {
    const socket = opts.socketPath ?? "<data-dir>/operations-server";
    return (
      `Cannot rotate the admin password: the operations socket at ${socket} never became ready ` +
      `to accept a connection. Harper can answer HTTP health before it binds that socket, and a ` +
      `leftover inode that does not accept connections is not ready. Refusing before any alter_user ` +
      `or pass-file write. Wait until the instance has bound the socket, then run:\n  ${INIT_RESET_ADMIN_PASS_COMMAND}`
    );
  }
  const dataDir = opts.dataDir ?? "<data-dir>";
  const passPath = opts.adminPassPath ?? "~/.flair/admin-pass";
  return (
    `Harper already has an admin user in ${dataDir}, but ${passPath} is missing. ` +
    `HDB_ADMIN_PASSWORD only seeds a brand-new install and will not rotate the stored hash, ` +
    `so generating a new file would 401 every later ops-API call.\n` +
    `If you have the original password:\n  ${INIT_ADMIN_PASS_FILE_COMMAND}\n` +
    `If you do not:\n  ${INIT_RESET_ADMIN_PASS_COMMAND}`
  );
}

/**
 * Doctor / status finding for the disk-visible half of #837: file gone,
 * user record still in the data dir. Live 401 probes (file present but
 * wrong) are a separate authenticated check the caller can layer on.
 */
export function adminPassDesyncFinding(input: {
  adminPassFileExists: boolean;
  persistedAdminUser: boolean;
  dataDir?: string;
  adminPassPath?: string;
}): { flagged: boolean; message: string; remedy: string } | null {
  if (input.adminPassFileExists || !input.persistedAdminUser) return null;
  return {
    flagged: true,
    message: "admin-pass file missing; Harper still has a persisted admin user",
    remedy: ADMIN_PASS_DESYNC_REMEDY,
  };
}

/**
 * `--reset-admin-pass` is production credential rotation. Print this
 * exactly — user, socket, destination file — before any alter_user.
 */
export function formatAdminPasswordRotatePreflight(opts: {
  username: string;
  socketPath: string;
  adminPassPath: string;
}): string {
  return (
    `About to rotate Harper admin user '${opts.username}' via operations socket ${opts.socketPath} ` +
    `(super_user channel, no Authorization header; safe only because the socket is owner-only: ` +
    `0700 dir / 0600 socket, flair#1704). After alter_user succeeds the new password will be written to ${opts.adminPassPath}.`
  );
}

/** Rotate is reachable only from `--reset-admin-pass`. */
export function assertExplicitAdminPasswordRotate(resetRequested: boolean): void {
  if (!resetRequested) {
    throw new Error(
      "Refusing to rotate the admin password: --reset-admin-pass was not given. " +
      "Bare init never rotates a persisted hash.",
    );
  }
}

/** Owner-only ops-socket posture (flair#1704): dir 0700, socket 0600. */
export function isOwnerOnlyOpsSocketPosture(dirMode: number, socketMode: number): boolean {
  return (dirMode & 0o777) === 0o700 && (socketMode & 0o777) === 0o600;
}

export interface OpsSocketStat {
  mode: number;
}

/**
 * Refuse rotation unless the socket and its parent directory are owner-only.
 * The socket is a super_user channel with no Authorization header.
 */
export function assertOwnerOnlyOpsSocket(
  socketPath: string,
  stat: (path: string) => OpsSocketStat = (p) => statSync(p),
): void {
  const socket = stat(socketPath);
  const dir = stat(dirname(socketPath));
  if (!isOwnerOnlyOpsSocketPosture(dir.mode, socket.mode)) {
    throw new Error(initAdminPassRefusalMessage("socket-not-owner-only", { socketPath }));
  }
}

export interface OpsSocketCallResult {
  status: number;
  body: string;
}

/**
 * POST an operations payload over the domain socket. Sends NO Authorization
 * header: Harper's socket `bypassLocalAuth` is an else-if on "no header
 * present", so attaching Basic/Bearer opts out of the local-admin channel
 * and 401s (harper `bin/cliOperations.ts`).
 */
export function callOpsSocket(
  socketPath: string,
  body: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<OpsSocketCallResult> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`ops socket timed out after ${timeoutMs}ms`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Gate the rotate path: explicit `--reset-admin-pass` AND owner-only socket.
 * Returns the preflight line the caller MUST print before `alter_user`.
 */
export function prepareAdminPasswordRotate(opts: {
  resetRequested: boolean;
  username: string;
  socketPath: string;
  adminPassPath: string;
  stat?: (path: string) => OpsSocketStat;
}): string {
  assertExplicitAdminPasswordRotate(opts.resetRequested);
  assertOwnerOnlyOpsSocket(opts.socketPath, opts.stat);
  return formatAdminPasswordRotatePreflight({
    username: opts.username,
    socketPath: opts.socketPath,
    adminPassPath: opts.adminPassPath,
  });
}

export async function rotateAdminPasswordViaOpsSocket(
  socketPath: string,
  username: string,
  password: string,
): Promise<void> {
  const result = await callOpsSocket(socketPath, {
    operation: "alter_user",
    username,
    password,
    role: "super_user",
    active: true,
  });
  if (result.status >= 400) {
    throw new Error(
      `Operations socket alter_user failed (${result.status}): ${result.body || "(empty)"}`,
    );
  }
}

/** How long rotate waits for Harper to bind and accept on operations-server. */
export const OPS_SOCKET_ROTATE_TIMEOUT_MS = 10_000;
const OPS_SOCKET_ROTATE_POLL_MS = 50;
const OPS_SOCKET_ROTATE_PROBE_TIMEOUT_MS = 250;

/**
 * True when something is accepting on `path`. A leftover inode that exists
 * but accepts no connection is dead — not ready. HTTP /Health is not a
 * substitute: Harper can answer HTTP before it bind()s this socket.
 */
export function probeOpsSocketAccepting(
  socketPath: string,
  timeoutMs = OPS_SOCKET_ROTATE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    const sock = createConnection(socketPath);
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
  });
}

export interface WaitForOpsSocketReadyOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** True only when a process is accepting — dead leftover inode → false. */
  isLive?: (path: string) => boolean | Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Bounded wait until the operations socket accepts a connection.
 * A missing path or a stale/dead inode is not-ready; this never unlinks
 * and never falls through to the HTTP ops path.
 */
export async function waitForOpsSocketReady(
  socketPath: string,
  opts: WaitForOpsSocketReadyOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? OPS_SOCKET_ROTATE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? OPS_SOCKET_ROTATE_POLL_MS;
  const isLive = opts.isLive ?? ((p: string) => probeOpsSocketAccepting(p));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await isLive(socketPath)) return true;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }
  return false;
}

export interface ExecuteAdminPasswordRotateOptions {
  resetRequested: boolean;
  username: string;
  password: string;
  socketPath: string;
  adminPassPath: string;
  writeAdminPassFile: (path: string, contents: string) => void;
  timeoutMs?: number;
  pollMs?: number;
  isLive?: (path: string) => boolean | Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stat?: (path: string) => OpsSocketStat;
  rotate?: (socketPath: string, username: string, password: string) => Promise<void>;
  onPreflight?: (line: string) => void;
}

/**
 * Rotate entry used by `flair init --reset-admin-pass`.
 *
 * Readiness is the operations socket accepting a connection, not HTTP
 * health. Wait (bounded, real timeout) first. A dead leftover inode is
 * not-ready. If the socket never becomes ready, refuse before any
 * alter_user and before any pass-file write — never fall through to HTTP.
 * On success: owner-only check, preflight, alter_user, then write.
 */
export async function executeAdminPasswordRotate(
  opts: ExecuteAdminPasswordRotateOptions,
): Promise<void> {
  assertExplicitAdminPasswordRotate(opts.resetRequested);
  const ready = await waitForOpsSocketReady(opts.socketPath, {
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    isLive: opts.isLive,
    now: opts.now,
    sleep: opts.sleep,
  });
  if (!ready) {
    throw new Error(initAdminPassRefusalMessage("socket-not-ready", { socketPath: opts.socketPath }));
  }
  const preflight = prepareAdminPasswordRotate({
    resetRequested: opts.resetRequested,
    username: opts.username,
    socketPath: opts.socketPath,
    adminPassPath: opts.adminPassPath,
    stat: opts.stat,
  });
  opts.onPreflight?.(preflight);
  const rotate = opts.rotate ?? rotateAdminPasswordViaOpsSocket;
  await rotate(opts.socketPath, opts.username, opts.password);
  opts.writeAdminPassFile(opts.adminPassPath, opts.password + "\n");
}
