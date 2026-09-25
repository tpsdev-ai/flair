import {
  decideSweepMode,
  INSTANCE_ROW_PRUNE_REMEDY,
  readableInstanceRows,
  writeConfirmed,
  type InstanceIdentityRow,
  type SweepMode,
} from "../src/lib/instance-identity-row.js";

const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

/** Prefix of the throwaway Basic users minted by `flair federation token`. */
export const BOOTSTRAP_USER_PREFIX = "pair-bootstrap-";

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** What the sweep last decided, so a steady state is logged once, not per tick. */
export interface SweepLogState {
  last: SweepMode | null;
}

/**
 * Initialise the federation cleanup sweep.
 *
 * The sweep is INSTALLED on every instance and re-reads the identity row's role
 * on EVERY tick (flair#1883). It used to read the role once, at module init,
 * before the server had started: on a fresh hub no `Instance` row existed yet,
 * so the check saw "not a hub", disabled the sweep permanently, and later ticks
 * never re-read. Nothing about that is a property of a hub — it is a property of
 * when a row happened to appear.
 *
 * A role of `hub` is what runs the sweep; two or more `Instance` rows is a
 * logged error with its remedy, never "first row wins"; an `Instance` read that
 * failed is its own state, not a spoke.
 *
 * In test environments, callers pass mock serverOp/db via `opts` so this
 * module never imports harper at the top level (which would
 * crash when STORAGE_PATH isn't set). `instanceRole` overrides the per-tick
 * read (tests); `intervalMs` shortens the cadence (tests).
 */
export async function initFederationCleanup(
  opts?: {
    instanceRole?: string | null;
    serverOp?: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
    db?: any;
    immediateTick?: boolean;
    intervalMs?: number;
  },
): Promise<void> {
  const immediate = opts?.immediateTick ?? true;
  const intervalMs = opts?.intervalMs ?? CLEANUP_INTERVAL_MS;

  // Resolve server / databases: use caller-supplied mocks when available,
  // otherwise lazy-import harper at call time.
  let svr: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
  let db: any;
  if (opts?.serverOp && opts?.db) {
    svr = opts.serverOp;
    db  = opts.db;
  } else {
    try {
      const harper = await import("harper");
      svr = opts?.serverOp ?? harper.server.operation;
      db  = opts?.db ?? harper.databases;
    } catch (err: any) {
      console.error(
        "[federation-cleanup] failed to load harper:",
        err?.message ?? err,
      );
      return;
    }
  }

  console.log(
    `[federation-cleanup] sweep installed (${Math.round(intervalMs / 1000)}s cadence); the identity role is re-read on every tick`,
  );
  if (cleanupTimer) clearInterval(cleanupTimer);

  const state: SweepLogState = { last: null };
  const tick = () =>
    runSweepTick({
      serverOp: svr,
      db,
      instanceRole: opts?.instanceRole,
      state,
    }).catch((err: any) => {
      console.error("[federation-cleanup] tick error:", err?.message ?? err);
    });

  cleanupTimer = setInterval(tick, intervalMs);

  if (immediate) {
    // Run an immediate first tick after installing the sweep
    await tick();
  }
}

/** Stop the sweep. Tests install a short cadence and must be able to end it. */
export function stopFederationCleanup(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}

/**
 * One sweep tick: decide from the CURRENT identity rows, then sweep if hub.
 *
 * Exported so the decision can be driven directly (and so a test can watch a
 * hub row appear after startup start the sweep without a restart).
 */
export async function runSweepTick(opts: {
  serverOp?: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
  db?: any;
  instanceRole?: string | null;
  now?: Date;
  state?: SweepLogState;
  log?: Pick<Console, "log" | "error">;
}): Promise<SweepMode> {
  let db: any = opts.db;
  if (opts.instanceRole === undefined && db === undefined) {
    const harper = await import("harper");
    db = harper.databases;
  }

  const rows: InstanceIdentityRow[] | null =
    opts.instanceRole !== undefined
      ? [{ id: "(explicit role)", role: opts.instanceRole }]
      : await readInstanceRowsOrNull(db);

  const mode = decideSweepMode(rows);
  noteSweepMode(mode, opts.state, opts.log);

  if (mode !== "hub") return mode;

  let svr: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
  if (opts.serverOp) {
    svr = opts.serverOp;
  } else {
    const harper = await import("harper");
    svr = harper.server.operation;
  }

  const users = await listUsernamesOrNull(svr, opts.log);
  await runCleanupTick({ serverOp: svr, db, now: opts.now, users });
  return mode;
}

/** Log the sweep's state; only on change, so a steady state is not a log flood. */
export function noteSweepMode(
  mode: SweepMode,
  state?: SweepLogState,
  log: Pick<Console, "log" | "error"> = console,
): void {
  if (state) {
    if (state.last === mode) return;
    state.last = mode;
  }
  switch (mode) {
    case "hub":
      log.log("[federation-cleanup] this instance is the hub — cleanup sweep active");
      return;
    case "not-hub":
      log.log("[federation-cleanup] not a hub instance — nothing to sweep");
      return;
    case "multiple":
      log.error(
        "[federation-cleanup] ERROR: this instance has more than one Instance row, so it has no canonical identity " +
          "and the sweep cannot know whether it is a hub. No cleanup will run.",
      );
      log.error(
        `[federation-cleanup] Fix: keep one row and delete the rest — ${INSTANCE_ROW_PRUNE_REMEDY} ` +
          `(see \`flair doctor\`, which lists the rows)`,
      );
      return;
    case "unreadable":
      log.log("[federation-cleanup] could not read the Instance table this tick — sweep paused, not disabled");
      return;
  }
}

/**
 * All Instance rows, or null when the read failed. Null is its own answer: a
 * failed read is not a spoke, and must not be reported as one. An entry with no
 * usable id makes the whole read unreadable (the same strict reader init and the
 * server use): a row the sweep cannot name may be a second identity, so the
 * sweep pauses rather than treating the rest as the whole table.
 */
async function readInstanceRowsOrNull(db: any): Promise<InstanceIdentityRow[] | null> {
  try {
    const entries: unknown[] = [];
    for await (const inst of (db as any).flair.Instance.search()) {
      entries.push(inst);
    }
    return readableInstanceRows(entries);
  } catch {
    /* table may not exist yet */
    return null;
  }
}

/**
 * The usernames of the `pair-bootstrap-*` users on this instance, or null when
 * the list could not be read. Only the usernames — never a credential.
 */
export async function listUsernamesOrNull(
  svr: (op: any, ctx?: any, authorize?: boolean) => Promise<any>,
  log: Pick<Console, "log" | "error"> = console,
): Promise<string[] | null> {
  try {
    const result = await svr({ operation: "list_users" }, { user: null }, false);
    const users = Array.isArray(result) ? result : Array.isArray((result as any)?.users) ? (result as any).users : null;
    if (users === null) return null;
    return users
      .map((u: any) => (typeof u === "string" ? u : u?.username ?? u?.user?.username))
      .filter((name: unknown): name is string => typeof name === "string" && name.startsWith(BOOTSTRAP_USER_PREFIX));
  } catch (err: any) {
    log.error("[federation-cleanup] failed to list users:", err?.message ?? err);
    return null;
  }
}

/** `message` with every occurrence of `tokenId` cut to its 8-character prefix. */
export function redactTokenId(message: string, tokenId: string): string {
  return tokenId ? message.split(tokenId).join(`${tokenId.slice(0, 8)}…`) : message;
}

/** `value` with `secret` cut to its prefix in every string, at any depth. */
function redactDeep(value: unknown, secret: string): unknown {
  if (typeof value === "string") return redactTokenId(value, secret);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secret)]));
  }
  return value;
}

/**
 * Log one line about one pairing token, or about the bootstrap user named for
 * it: `secret` is cut to its 8-character prefix in the message and in every
 * STRING value of the fields, at any depth. Object keys and non-string values
 * pass through unchanged; the callers here use literal keys and string or boolean values.
 * Hygiene, not a boundary: this log is the operator's, and the sweep touches
 * only expired or consumed tokens, which cannot pair.
 */
function tokenLog(
  level: "log" | "error",
  message: string,
  fields: Record<string, unknown>,
  secret: string,
): void {
  console[level](redactTokenId(message, secret), redactDeep(fields, secret));
}

/**
 * Core cleanup logic — exposed for unit testing.
 *
 * - Finds PairingToken records that are:
 *   - consumedBy is non-null (pair succeeded, bootstrap user no longer needed)
 *   - OR expiresAt < now (token expired without successful pair)
 * - Drops the bootstrap user via the Harper ops API (idempotent: 404 is
 *   swallowed).
 * - Deletes the PairingToken record if expired AND not consumed
 *   (housekeeping). Consumed records are kept for audit.
 * - THEN walks the `pair-bootstrap-*` users the caller listed (`users`) and
 *   drops every one whose token is missing, consumed or expired (flair#1883).
 *   Iterating tokens alone cannot see those users: a bootstrap user whose token
 *   record is gone is invisible to every token-shaped query, which is exactly
 *   the debris this sweep exists to collect.
 *
 * Logging emits token-id prefix only (NEVER the full username, NEVER a
 * password).
 */
export async function runCleanupTick(
  opts: {
    serverOp?: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
    db?: any;
    now?: Date;
    /**
     * `pair-bootstrap-*` usernames present on the instance, from list_users.
     * undefined skips the user-driven pass; null means the list did not read.
     */
    users?: readonly string[] | null;
  } = {},
): Promise<void> {
  let svr: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
  let db: any;

  if (opts.serverOp && opts.db) {
    svr = opts.serverOp;
    db = opts.db;
  } else {
    const harper = await import("harper");
    svr = opts.serverOp ?? harper.server.operation;
    db = opts.db ?? harper.databases;
  }

  const now = opts.now ?? new Date();

  // ── Query candidates ──────────────────────────────────────────────────
  const candidates: any[] = [];
  // Token-id prefixes that are still LIVE (unconsumed and unexpired). A live
  // token still needs its bootstrap user, so the user-driven pass (below) must
  // not collect that user. Built in the same scan: one pass over the table.
  const liveTokenPrefixes = new Set<string>();
  try {
    for await (const token of (db as any).flair.PairingToken.search()) {
      const consumed = !!token.consumedBy;
      const expired = token.expiresAt && new Date(token.expiresAt) < now;
      if (consumed || expired) {
        candidates.push(token);
      } else {
        liveTokenPrefixes.add(String(token.id).slice(0, 8));
      }
    }
  } catch (err: any) {
    console.error(
      "[federation-cleanup] failed to query PairingToken records:",
      err?.message ?? err,
    );
    return;
  }

  // ── Process each candidate ────────────────────────────────────────────
  const droppedUsers = new Set<string>();
  for (const token of candidates) {
    const tokenId: string = token.id;
    const consumed = !!token.consumedBy;
    const expired =
      token.expiresAt && new Date(token.expiresAt) < now;
    const bootstrapUsername = `${BOOTSTRAP_USER_PREFIX}${tokenId.slice(0, 8)}`;

    // Drop the bootstrap user
    await dropBootstrapUser(svr, bootstrapUsername, tokenId.slice(0, 8), droppedUsers);

    // ── Housekeeping ────────────────────────────────────────────────────
    if (expired && !consumed) {
      // Delete the expired, unconsumed token record itself
      try {
        const result = await svr(
          {
            operation: "delete",
            database: "flair",
            table: "PairingToken",
            // `hash_values` is the field Harper's delete schema REQUIRES. The
            // singular `hash_value` this used to send is refused with a 400 on
            // Harper 5.2.8, so an expired token record was never actually
            // deleted: every tick retried the same delete and logged the same
            // error. Found by the live-Harper test
            // (test/integration/init-remote-instance-identity.test.ts).
            hash_values: [tokenId],
          },
          { user: null },
          false,
        );
        // Verified against the RESULT, the way `deleteInstanceRow` and
        // `updateInstanceRole` verify their writes (flair#1898): Harper answers a
        // delete with 200 even when it removes nothing, reporting what it removed
        // in `deleted_hashes` and naming a record it did NOT remove in
        // `skipped_hashes`. Status alone would let a skipped record be logged as
        // deleted — a cleanup that did not happen. A skipped record is left in the
        // table, so the next tick sees it as a candidate again and retries it.
        if (writeConfirmed(result, "deleted_hashes", tokenId)) {
          tokenLog("log", "[federation-cleanup] deleted expired token", { tid: tokenId.slice(0, 8) }, tokenId);
        } else {
          tokenLog(
            "error",
            "[federation-cleanup] expired token delete NOT confirmed — Harper's result does not confirm the record was removed; if it is still in the table, the next tick retries it",
            // The token id IS the pairing credential, and skipped_hashes holds
            // token ids: log the prefix, as every other line in this sweep does,
            // and whether Harper named this token as skipped, never the values.
            {
              tid: tokenId.slice(0, 8),
              namedSkipped: Array.isArray((result as any)?.skipped_hashes)
                ? (result as any).skipped_hashes.map(String).includes(tokenId)
                : "no skipped_hashes in the result",
            },
            tokenId,
          );
        }
      } catch (err: any) {
        tokenLog(
          "error",
          "[federation-cleanup] delete token error",
          // A Harper error can echo the request, and the token id is the
          // pairing credential: cut every occurrence of it to its prefix.
          { tid: tokenId.slice(0, 8), err: String(err?.message ?? err) },
          tokenId,
        );
      }
    }

    // Consumed tokens: keep record for audit trail
    if (consumed) {
      tokenLog(
        "log",
        "[federation-cleanup] keeping audit record",
        { tid: tokenId.slice(0, 8), consumedBy: token.consumedBy },
        tokenId,
      );
    }
  }

  // ── User-driven pass (flair#1883) ──────────────────────────────────────
  // Every `pair-bootstrap-*` user whose token is missing, consumed or expired
  // goes, whether or not this tick saw a token row for it. A user whose token
  // is gone has no token to iterate.
  if (opts.users) {
    for (const username of opts.users) {
      // Only bootstrap users. The reader already filters by prefix; this is the
      // write-side guard: a caller that hands this function an `admin` must not
      // be able to get it dropped.
      if (!username.startsWith(BOOTSTRAP_USER_PREFIX)) continue;
      const tid = username.slice(BOOTSTRAP_USER_PREFIX.length);
      if (liveTokenPrefixes.has(tid)) continue;
      await dropBootstrapUser(svr, username, tid, droppedUsers);
    }
  }
}

/**
 * Drop one bootstrap user, idempotently. A 404 (or an equivalent "no such
 * user" refusal) is the desired end state, not an error; anything else is
 * logged with the token-id prefix and never aborts the sweep.
 */
async function dropBootstrapUser(
  svr: (op: any, ctx?: any, authorize?: boolean) => Promise<any>,
  username: string,
  tid: string,
  droppedUsers: Set<string>,
): Promise<void> {
  if (droppedUsers.has(username)) return;
  droppedUsers.add(username);
  try {
    await svr(
      { operation: "drop_user", username },
      { user: null },
      false, // bypass Harper permission checks
    );
    tokenLog("log", "[federation-cleanup] dropped user", { tid: tid.slice(0, 8) }, tid);
  } catch (err: any) {
    const msg = err?.message ?? "";
    const isNotFound =
      err?.statusCode === 404 ||
      msg.toLowerCase().includes("not exist") ||
      msg.toLowerCase().includes("not found");

    if (isNotFound) {
      // Idempotent — user already gone, no action needed
    } else {
      tokenLog(
        "error",
        "[federation-cleanup] drop_user error",
        // A bootstrap username is pair-bootstrap- plus the token's first 8
        // characters, but a hand-made one can carry more, and Harper's error can
        // echo it: bound the suffix and cut it out of the message.
        { tid: tid.slice(0, 8), err: String(err?.message ?? err) },
        tid,
      );
    }
  }
}
