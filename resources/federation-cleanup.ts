const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Initialise the federation cleanup sweep.
 *
 * Only active on hub instances — reads the Instance table to determine
 * role. On spokes this is a no-op.
 *
 * On hubs: ensures a 5-minute setInterval that sweeps PairingToken records
 * for consumed or expired tokens, drops the corresponding bootstrap users,
 * and performs housekeeping on expired/unconsumed token records.
 *
 * In test environments, callers pass mock serverOp/db via `opts` so this
 * module never imports @harperfast/harper at the top level (which would
 * crash when STORAGE_PATH isn't set).
 */
export async function initFederationCleanup(
  opts?: {
    instanceRole?: string | null;
    serverOp?: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
    db?: any;
    immediateTick?: boolean;
  },
): Promise<void> {
  const immediate = opts?.immediateTick ?? true;

  // Resolve server / databases: use caller-supplied mocks when available,
  // otherwise lazy-import @harperfast/harper at call time.
  let svr: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
  let db: any;
  if (opts?.serverOp && opts?.db) {
    svr = opts.serverOp;
    db  = opts.db;
  } else {
    try {
      const harper = await import("@harperfast/harper");
      svr = opts?.serverOp ?? harper.server.operation;
      db  = opts?.db ?? harper.databases;
    } catch (err: any) {
      console.error(
        "[federation-cleanup] failed to load @harperfast/harper:",
        err?.message ?? err,
      );
      return;
    }
  }

  const role: string | null =
    opts?.instanceRole !== undefined
      ? opts.instanceRole
      : await getInstanceRole(db);

  if (role !== "hub") {
    console.log(
      "[federation-cleanup] not a hub instance — cleanup disabled",
    );
    return;
  }

  console.log(
    "[federation-cleanup] starting cleanup sweep (5-min cadence)",
  );
  if (cleanupTimer) clearInterval(cleanupTimer);

  cleanupTimer = setInterval(() => {
    runCleanupTick({ serverOp: svr, db }).catch((err: any) => {
      console.error(
        "[federation-cleanup] tick error:",
        err?.message ?? err,
      );
    });
  }, CLEANUP_INTERVAL_MS);

  if (immediate) {
    // Run an immediate first tick after role detection
    runCleanupTick({ serverOp: svr, db }).catch((err: any) => {
      console.error(
        "[federation-cleanup] initial tick error:",
        err?.message ?? err,
      );
    });
  }
}

/**
 * Look up the instance role from the Instance table.
 * Returns null if the table doesn't exist or no record is present.
 */
async function getInstanceRole(db: any): Promise<string | null> {
  try {
    for await (const inst of (db as any).flair.Instance.search()) {
      return inst.role ?? null;
    }
  } catch {
    /* table may not exist yet */
  }
  return null;
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
 *
 * Logging emits token-id prefix only (NEVER the full username, NEVER a
 * password).
 */
export async function runCleanupTick(
  opts: {
    serverOp?: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
    db?: any;
    now?: Date;
  } = {},
): Promise<void> {
  let svr: (op: any, ctx?: any, authorize?: boolean) => Promise<any>;
  let db: any;

  if (opts.serverOp && opts.db) {
    svr = opts.serverOp;
    db = opts.db;
  } else {
    const harper = await import("@harperfast/harper");
    svr = opts.serverOp ?? harper.server.operation;
    db = opts.db ?? harper.databases;
  }

  const now = opts.now ?? new Date();

  // ── Query candidates ──────────────────────────────────────────────────
  const candidates: any[] = [];
  try {
    for await (const token of (db as any).flair.PairingToken.search()) {
      const consumed = !!token.consumedBy;
      const expired = token.expiresAt && new Date(token.expiresAt) < now;
      if (consumed || expired) {
        candidates.push(token);
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
  for (const token of candidates) {
    const tokenId: string = token.id;
    const consumed = !!token.consumedBy;
    const expired =
      token.expiresAt && new Date(token.expiresAt) < now;
    const bootstrapUsername = `pair-bootstrap-${tokenId.slice(0, 8)}`;

    // Drop the bootstrap user
    try {
      await svr(
        { operation: "drop_user", username: bootstrapUsername },
        { user: null },
        false, // bypass Harper permission checks
      );
      console.log(
        "[federation-cleanup] dropped user",
        { tid: tokenId.slice(0, 8) },
      );
    } catch (err: any) {
      const msg = err?.message ?? "";
      const isNotFound =
        err?.statusCode === 404 ||
        msg.toLowerCase().includes("not exist") ||
        msg.toLowerCase().includes("not found");

      if (isNotFound) {
        // Idempotent — user already gone, no action needed
      } else {
        console.error(
          "[federation-cleanup] drop_user error",
          { tid: tokenId.slice(0, 8), err: String(err?.message ?? err) },
        );
      }
    }

    // ── Housekeeping ────────────────────────────────────────────────────
    if (expired && !consumed) {
      // Delete the expired, unconsumed token record itself
      try {
        await svr(
          {
            operation: "delete",
            database: "flair",
            table: "PairingToken",
            hash_value: tokenId,
          },
          { user: null },
          false,
        );
        console.log(
          "[federation-cleanup] deleted expired token",
          { tid: tokenId.slice(0, 8) },
        );
      } catch (err: any) {
        console.error(
          "[federation-cleanup] delete token error",
          { tid: tokenId.slice(0, 8), err: String(err?.message ?? err) },
        );
      }
    }

    // Consumed tokens: keep record for audit trail
    if (consumed) {
      console.log(
        "[federation-cleanup] keeping audit record",
        { tid: tokenId.slice(0, 8), consumedBy: token.consumedBy },
      );
    }
  }
}
