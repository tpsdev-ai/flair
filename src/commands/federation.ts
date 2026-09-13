/**
 * federation.ts — `flair federation` command group (flair#1620 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration, action handlers, and group-specific
 * inline helpers (crypto/sign, status-fetch sentences, pair token parse,
 * sync/watch, prune duration). Shared CLI helpers (api, resolveTarget,
 * credential flags, …) stay in cli.ts and are bound before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import nacl from "tweetnacl";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { keystore, keyPath as keystoreKeyPath } from "../keystore.js";
import * as render from "../render.js";
import { runFederationVerify } from "../federation-verify.js";
import { resolveHubPeerIdentity } from "../lib/federation-pair-identity.js";
import {
  defaultAdminPassPath,
  isLocalBase,
  resolveAdminUser,
} from "../lib/auth-resolve.js";
import { DEFAULT_INTERVAL_SECONDS as FEDERATION_SYNC_DEFAULT_INTERVAL } from "../federation/scheduler.js";

export type FederationCli = {
  api: (...args: any[]) => Promise<any>;
  resolveTarget: (opts: { target?: string }) => string | undefined;
  resolveBaseUrl: (opts: { target?: string; url?: string; port?: string | number }) => string;
  resolveEffectiveOpsUrl: (opts: { target?: string; opsTarget?: string }) => string | undefined;
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
  applyAdminPassFile: (opts: { adminPass?: string; adminPassFile?: string }) => void;
  addSharedCredentialOptions: (cmd: Command) => Command;
  addSharedIdentityOption: (cmd: Command) => Command;
  shouldShowInlineSecretWarning: (
    optValue: string | undefined,
    fromEnv: boolean,
    secretFlagNames: Set<string>,
    flagName: string,
  ) => boolean;
};

let cli: FederationCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: FederationCli): void {
  cli = fns;
}

function api(...args: any[]): Promise<any> {
  return cli.api(...args);
}
function resolveTarget(opts: { target?: string }): string | undefined {
  return cli.resolveTarget(opts);
}
function resolveBaseUrl(opts: { target?: string; url?: string; port?: string | number }): string {
  return cli.resolveBaseUrl(opts);
}
function resolveEffectiveOpsUrl(opts: { target?: string; opsTarget?: string }): string | undefined {
  return cli.resolveEffectiveOpsUrl(opts);
}
function resolveOpsPort(opts: { opsPort?: string | number; port?: string | number }): number {
  return cli.resolveOpsPort(opts);
}
function applyAdminPassFile(opts: { adminPass?: string; adminPassFile?: string }): void {
  cli.applyAdminPassFile(opts);
}
function addSharedCredentialOptions(cmd: Command): Command {
  return cli.addSharedCredentialOptions(cmd);
}
function addSharedIdentityOption(cmd: Command): Command {
  return cli.addSharedIdentityOption(cmd);
}
function shouldShowInlineSecretWarning(
  optValue: string | undefined,
  fromEnv: boolean,
  secretFlagNames: Set<string>,
  flagName: string,
): boolean {
  return cli.shouldShowInlineSecretWarning(optValue, fromEnv, secretFlagNames, flagName);
}

// Federation crypto helpers — inlined to avoid cross-boundary imports from
// src/ into resources/, which don't survive npm packaging (see also
// resources/federation-crypto.ts; the two must stay in sync).
function sortKeys(val: unknown): unknown {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((val as Record<string, unknown>)[key]);
  }
  return sorted;
}
function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}
function signBody(body: Record<string, any>, secretKey: Uint8Array): string {
  const message = new TextEncoder().encode(canonicalize(body));
  const sig = nacl.sign.detached(message, secretKey);
  return Buffer.from(sig).toString("base64url");
}

// Per-record principalId (federation-edge-hardening slice 3a / flair#1416).
// Sourced from the write-time provenance stamp (memory-provenance slice 1,
// Memory.ts's buildProvenance) when present. `provenance` is persisted as
// a JSON STRING (not an object), so it must be parsed — a raw
// `row.provenance?.verified?.agentId` would silently always be undefined.
// Soul/Agent/Relationship rows never carry a provenance stamp today, so
// this is a no-op for them (those tables are not principal-owning).
//
// As of v:2 this value is IN the signed payload. The receiver validates
// it against data.agentId for Memory (PRINCIPAL_OWNING_TABLES); it is
// no longer informational-only. Credential.principalId is an unrelated
// owner field — do not grep that path when changing this one.
//
// S2 COMMENT-PIN (Kern P2-5, flair#1521): Message is principal-owning by `from`
// (PRINCIPAL_OWNER_FIELD in federation-classify.ts) but its rows carry NO
// `provenance` stamp, so principalIdFromRow returns undefined for them → a v:2
// Message push would omit `principalId` → the receiver's v≥2
// checkPrincipalEntitlement skips EVERY Message as `principal_mismatch` (a
// 100%-skip sync, not a migration). S1 does not push Message (receive-only —
// the spoke push list below is a separate hardcoded set), so this is inert
// today; the S2 pusher MUST stamp `principalId = row.from` for Message here
// (a per-table owner-aware derivation, not `provenance.verified.agentId`).
function principalIdFromRow(row: any): string | undefined {
  if (typeof row?.provenance !== "string" || row.provenance.length === 0) return undefined;
  try {
    return JSON.parse(row.provenance)?.verified?.agentId ?? undefined;
  } catch {
    return undefined;
  }
}

// Federation push private-visibility filter — inlined for the SAME reason as
// the crypto helpers above (see comment there; also resources/memory-
// visibility.ts, the canonical definition; the two must stay in sync).
//
// federation-edge-hardening slice 2 (the office-visibility read leak: one rule, one place): the
// push side of federation sync (runFederationSyncOnce below) must exclude
// `private` Memory rows from what gets sent to peers, using the EXACT same
// "not private" semantics as resources/memory-read-scope.ts's resolveReadScope()
// — a record with NO visibility field (legacy, pre-dates the field) is NOT
// private and must keep syncing exactly as before. Only `visibility ===
// "private"` is excluded; null/undefined/"shared"/anything else is included.
const FEDERATION_PRIVATE_VISIBILITY = "private";
function isFederationPrivateVisibility(visibility: string | null | undefined): boolean {
  return visibility === FEDERATION_PRIVATE_VISIBILITY;
}

async function loadInstanceSecretKey(instanceId: string, opts: { adminPass?: string; adminUser?: string; opsPort?: string | number; port?: string | number }): Promise<Uint8Array> {
  // Try keystore first
  const seed = keystore.getPrivateKeySeed(instanceId);
  if (seed) {
    return nacl.sign.keyPair.fromSeed(seed).secretKey;
  }

  // Fallback: check DB for legacy _keySeed
  const opsPort = resolveOpsPort(opts);
  const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
  const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
  const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ operation: "search_by_value", schema: "flair", table: "Instance", search_attribute: "id", search_type: "equals", search_value: instanceId, get_attributes: ["*"] }),
  });
  if (res.ok) {
    const rows = await res.json() as any[];
    if (rows[0]?._keySeed) {
      const seedFromDb = Buffer.from(rows[0]._keySeed, "base64url");
      // Migrate to keystore
      keystore.setPrivateKeySeed(instanceId, new Uint8Array(seedFromDb));
      return nacl.sign.keyPair.fromSeed(new Uint8Array(seedFromDb)).secretKey;
    }
  }

  // flair#1233: the old advice here — "Re-run 'flair federation status' to
  // regenerate" — was impossible: the server's create branch only fires when
  // NO Instance row exists, so a re-run can never regenerate a key for an
  // existing identity. Name the real remedy instead.
  throw new Error(
    `No usable private key for instance ${instanceId}. Expected keystore file: ${keystoreKeyPath(instanceId)} ` +
    `(no legacy _keySeed in the Instance table either). Restore that key file from a backup of ~/.flair/keys ` +
    `(and FLAIR_KEY_PASSPHRASE, if one was set when it was written), or re-key this instance: delete its ` +
    `Instance row and re-pair to mint a fresh identity.`,
  );
}

/**
 * Sign a request body and return a new body with the signature field added.
 */
export function signRequestBody(body: Record<string, any>, secretKey: Uint8Array): Record<string, any> {
  // Fresh signing with anti-replay: embeds _ts and _nonce before signing.
  // Equivalent to federation-crypto.ts signBodyFresh — duplicated here because
  // the CLI module has its own local signBody for dependency isolation.
  const freshBody = {
    ...body,
    _ts: Date.now(),
    _nonce: Buffer.from(nacl.randomBytes(16)).toString("base64url"),
  };
  const sig = signBody(freshBody, secretKey);
  return { ...freshBody, signature: sig };
}

// Alias: signBodyFresh for clarity at call sites
const signBodyFresh = signRequestBody;

/**
 * The most recent CONTACT with any peer (max of peer.lastSyncAt), or null.
 *
 * Contact, not merge: a sync that reaches the peer and legitimately has
 * nothing to send still proves the driver ran. This is half of what lets
 * `federation status` tell "nothing is driving sync" apart from "sync is
 * running, the peer is unreachable" (flair#922) — the other half is whether
 * the service manager has a driver loaded.
 *
 * Returns null on ANY failure. A driver verdict is a diagnostic aid; it must
 * never be the reason `federation status` fails.
 */
async function latestPeerContact(opts: { target?: string }): Promise<string | null> {
  try {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    const { peers } = await api("GET", "/FederationPeers", undefined, baseUrl ? { baseUrl } : undefined);
    let best: number | null = null;
    for (const p of peers ?? []) {
      if (!p?.lastSyncAt) continue;
      const t = Date.parse(p.lastSyncAt);
      if (Number.isFinite(t) && (best === null || t > best)) best = t;
    }
    return best === null ? null : new Date(best).toISOString();
  } catch {
    return null;
  }
}

/**
 * True when the CLI is pointed at the instance running on THIS machine.
 *
 * The scheduler check is inherently local — launchctl/systemctl only know
 * about jobs on the host the CLI is running on. Reporting "no driver" while
 * `--target` points at someone else's hub would be a confident claim about a
 * machine we cannot see, so the driver block is suppressed for remote targets.
 */
function driverCheckAppliesTo(opts: { target?: string }): boolean {
  const target = resolveTarget(opts);
  return !target || isLocalBase(target.replace(/\/$/, ""));
}

/**
 * flair#1108: a bare undici/Node "fetch failed" names neither the URL
 * that was probed nor the knob that would change it. These helpers are
 * the operator-facing sentence and the setting that produced (or would
 * change) that URL. Pure so the contract can be unit-tested without
 * driving process.exit.
 */
export function federationStatusUrlSetting(opts: { target?: string; port?: string | number }): string {
  if (opts.target) return "--target";
  if (process.env.FLAIR_TARGET) return "FLAIR_TARGET";
  if (process.env.FLAIR_URL) return "FLAIR_URL";
  if (opts.port !== undefined && opts.port !== null && String(opts.port) !== "") return "--port";
  return "FLAIR_URL or --port";
}

export function describeFederationStatusFetchFailed(url: string, setting: string): string {
  return `fetch failed against ${url} (set ${setting})`;
}

/** True for a connect-level failure (no HTTP status): Node's undici
 *  `TypeError: fetch failed`, Bun's `Unable to connect…`, or a cause
 *  carrying a connect/DNS errno. Auth and HTTP errors stay out. */
export function isFederationStatusConnectFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\bfetch failed\b/i.test(msg)) return true;
  if (/unable to connect/i.test(msg)) return true;
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" && cause && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : "";
  return /^(ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH)$/.test(code);
}

export function rewriteFederationStatusFetchFailed(err: unknown, url: string, setting: string): unknown {
  if (!isFederationStatusConnectFailure(err)) return err;
  const next = new Error(describeFederationStatusFetchFailed(url, setting));
  if (err && typeof err === "object" && "status" in err) {
    (next as { status?: unknown }).status = (err as { status?: unknown }).status;
  }
  return next;
}

/**
 * Auth-shaped vs connect-level for `federation status`. A rewritten
 * fetch-failed sentence embeds the probed URL; that URL can contain a
 * whole-token `401` (e.g. `--port 401`). The old `message.includes("401")`
 * check then printed the credential remedy and hid the URL+setting this
 * change exists to surface (Bugbot on flair#1108).
 */
export function isFederationStatusAuthFailure(err: unknown): boolean {
  if (!err) return false;
  if (isFederationStatusConnectFailure(err)) return false;
  if (typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (status === 401 || status === 403) return true;
  }
  const m = err instanceof Error
    ? err.message
    : String(typeof err === "object" && err && "message" in err
      ? (err as { message?: unknown }).message ?? err
      : err);
  return m.includes("missing_or_invalid_authorization") || /(?:^|\D)401(?:\D|$)/.test(m);
}

/**
 * Whether to print the "set one of: FLAIR_AGENT_ID / FLAIR_ADMIN_PASS /
 * FLAIR_TOKEN" block. Narrower than `isFederationStatusAuthFailure`: a
 * 403 with credentials already sent (wrong password) is fatal, but the
 * server's own body is the honest message — the credential-list remedy
 * is for missing/invalid auth (401), not a rejected password (flair#634).
 */
export function isFederationStatusAuthRemedy(err: unknown): boolean {
  if (!err || isFederationStatusConnectFailure(err)) return false;
  if (typeof err === "object" && "status" in err && (err as { status?: unknown }).status === 401) {
    return true;
  }
  const m = err instanceof Error
    ? err.message
    : String(typeof err === "object" && err && "message" in err
      ? (err as { message?: unknown }).message ?? err
      : err);
  return m.includes("missing_or_invalid_authorization") || /(?:^|\D)401(?:\D|$)/.test(m);
}

/** Parse a JSON triple file for --token-from.
 *  Expected shape: { "token": "...", "user": "pair-bootstrap-<id>", "password": "...", "expiresAt": "<ISO>" }
 *  Returns the triple on success. Validation failures exit(1).
 */
export function parseTokenFromFile(filePath: string): {
  token: string; user: string; password: string; expiresAt: string;
} {
  let raw: string;
  if (filePath === "-") {
    raw = readFileSync("/dev/stdin", "utf-8");
  } else {
    if (!existsSync(filePath)) {
      console.error(`Error: --token-from file not found: ${filePath}`);
      process.exit(1);
    }
    raw = readFileSync(filePath, "utf-8");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`Error: --token-from file is not valid JSON: ${filePath}`);
    process.exit(1);
  }

  // Validate all four fields present and non-empty
  const required = ["token", "user", "password", "expiresAt"] as const;
  for (const field of required) {
    if (!parsed[field] || typeof parsed[field] !== "string" || parsed[field].trim() === "") {
      console.error(`Error: --token-from JSON is missing or has empty required field "${field}"`);
      process.exit(1);
    }
  }

  // Validate expiresAt is a parseable date and is in the future
  const expiry = new Date(parsed.expiresAt);
  if (isNaN(expiry.getTime())) {
    console.error(`Error: --token-from JSON has invalid expiresAt date: "${parsed.expiresAt}"`);
    process.exit(1);
  }
  const now = new Date();
  if (expiry <= now) {
    console.error(`Error: --token-from JSON has expired token (expiresAt: ${parsed.expiresAt})`);
    process.exit(1);
  }
  const fiveMin = 5 * 60 * 1000;
  if (expiry.getTime() - now.getTime() < fiveMin) {
    console.error(`warning: pairing token expires in less than 5 minutes (expiresAt: ${parsed.expiresAt})`);
  }

  return {
    token: parsed.token.trim(),
    user: parsed.user.trim(),
    password: parsed.password.trim(),
    expiresAt: parsed.expiresAt.trim(),
  };
}

export async function runFederationSyncOnce(opts: any): Promise<{ pushed: number; skipped: number; error?: Error }> {
  const target = resolveTarget(opts);
  const baseUrl = target ? target.replace(/\/$/, "") : undefined;
  // Same allowAdmin listing as federation verify — flag/file admin pass
  // must reach GET /FederationPeers and /FederationInstance, not just the
  // ops-API Basic header used later in this function.
  const apiOpts = (baseUrl || opts.adminPass || opts.adminUser)
    ? {
      ...(baseUrl ? { baseUrl } : {}),
      ...(opts.adminPass ? { explicitAdminPass: opts.adminPass as string } : {}),
      ...(opts.adminUser ? { adminUser: opts.adminUser as string } : {}),
    }
    : undefined;
  let totalMerged = 0;
  let totalSkipped = 0;
  try {
    const { peers } = await api("GET", "/FederationPeers", undefined, apiOpts);
    const hub = peers.find((p: any) => p.role === "hub" && p.status !== "revoked");
    if (!hub) {
      return { pushed: 0, skipped: 0, error: new Error("No hub peer configured. Use 'flair federation pair' first.") };
    }

    console.log(`Syncing to hub: ${hub.id}...`);
    const since = hub.lastSyncAt ?? new Date(0).toISOString();
    // Capture sync start time BEFORE we query records. We advance the local
    // hub peer's lastSyncAt to this value after success so the next poll's
    // `since` cursor moves forward — fixes task #146 (federation peer
    // .lastSyncAt update bug). Records updated DURING this sync will have
    // updatedAt > syncStartedAt and be picked up next cycle, not missed.
    const syncStartedAt = new Date().toISOString();
    const opsEndpoint = resolveEffectiveOpsUrl(opts) ?? `http://127.0.0.1:${resolveOpsPort(opts)}`;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
    const tables = ["Memory", "Soul", "Agent", "Relationship"];
    const instance = await api("GET", "/FederationInstance", undefined, apiOpts);
    const hubUrl = hub.endpoint ?? hub.id;

    // ── Batching constants ──────────────────────────────────────────────
    // 2MB JSON budget (server cap is 10MB; 2MB leaves headroom for headers
    // and signature metadata) + 50 records max per batch. The hub merge itself
    // is fast (~1.7s/50 records, per its SyncLog), but the Fabric ingress was
    // observed to intermittently stall on larger POSTs — a 50-record batch hung
    // ~2 min while the same records split into 2×25 went through immediately.
    // 50 keeps batches in the reliable range, and sendBatch's adaptive split
    // recovers if a stretch still stalls.
    const BUDGET_BYTES = 2_000_000;
    const BUDGET_RECORDS = 50;

    // ── sendBatch helper ────────────────────────────────────────────────
    // Secret key is lazy-loaded: only needed when there are records to send.
    // Loading earlier would cause a spurious error when SQL queries fail
    // (e.g. 401) before we know we have records.
    let secretKey: Uint8Array | undefined;
    // Statuses the Fabric ingress returns when a batch POST didn't complete in
    // time (408) or was too large (413), plus the transient gateway 5xx family.
    // Splitting the batch and retrying smaller chunks lets the sync converge
    // instead of aborting the whole run.
    const TIMEOUT_STATUSES = new Set([408, 413, 502, 503, 504]);
    // Per-batch wall-clock cap. Without it a stalled connection to the Fabric
    // ingress hangs the whole sync until the *gateway's* timeout fires (~2 min
    // observed), which is what stranded the re-pair. A 45s cap is generous —
    // a healthy 50-record batch merges in <2s — so a trip means a real stall,
    // and we split-and-retry rather than wait it out.
    const BATCH_TIMEOUT_MS = 45_000;
    async function sendBatch(batch: any[]): Promise<{ merged: number; skipped: number }> {
      if (!secretKey) secretKey = await loadInstanceSecretKey(instance.id, opts);
      const syncBody: Record<string, any> = { instanceId: instance.id, records: batch, lamportClock: Date.now() };
      const signedSyncBody = signBodyFresh(syncBody, secretKey);

      // Halve and retry down to a single record. Covers both an explicit
      // timeout status AND a client-side abort (stalled socket). The hub
      // merges idempotently (put-by-id), so retried records are safe.
      const splittable = (status: number | null) =>
        batch.length > 1 && (status === null || TIMEOUT_STATUSES.has(status));
      const split = async () => {
        const mid = Math.floor(batch.length / 2);
        const left = await sendBatch(batch.slice(0, mid));
        const right = await sendBatch(batch.slice(mid));
        return { merged: left.merged + right.merged, skipped: left.skipped + right.skipped };
      };

      let syncRes: Response;
      try {
        syncRes = await fetch(`${hubUrl}/FederationSync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signedSyncBody),
          signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
        });
      } catch (err: any) {
        // Timeout/abort or network drop — no status. Split if we can.
        if (splittable(null)) return await split();
        throw new Error(`Sync batch (${batch.length} record${batch.length === 1 ? "" : "s"}) failed: ${err?.message ?? err}`);
      }
      if (!syncRes.ok) {
        if (splittable(syncRes.status)) return await split();
        const text = await syncRes.text().catch(() => "");
        throw new Error(`Sync batch failed: ${syncRes.status} ${text}`);
      }
      return await syncRes.json() as { merged: number; skipped: number };
    }

    let totalBatches = 0;
    // Memory rows that passed the since-cursor filter but were excluded as
    // private. Used only so the quiet path can distinguish "nothing since
    // the cursor" from "found rows, all withheld" (flair#1232). Does not
    // change what gets pushed — private still never leaves the instance.
    let privateHeldBack = 0;

    for (const table of tables) {
      let rows: any[] = [];
      for (const query of [
        { search_attribute: "updatedAt", search_type: "greater_than", search_value: since },
        // Rows with null updatedAt (legacy direct-insert rows) use createdAt.
        // COALESCE(updatedAt, createdAt) > since → pick up null-updatedAt rows
        // whose createdAt > since. Filtered in JS below.
        { search_attribute: "updatedAt", search_type: "equals", search_value: null },
      ]) {
        let res: Response;
        try {
          res = await fetch(`${opsEndpoint}/`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({ operation: "search_by_conditions", schema: "flair", table, operator: "and", conditions: [query], get_attributes: ["*"] }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err: any) {
          return { pushed: totalMerged, skipped: totalSkipped, error: err instanceof Error ? err : new Error(String(err)) };
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return { pushed: totalMerged, skipped: totalSkipped, error: new Error(`SQL query failed (${res.status}): ${text}`) };
        }
        const batch = await res.json() as any[];
        // For null-updatedAt rows, use createdAt as the effective timestamp.
        // Skip rows created before the last sync cursor. Only Memory carries
        // a `visibility` field (Soul/Agent/Relationship don't — see
        // schemas/memory.graphql vs agent.graphql), so the private-exclusion
        // filter only applies there; on the other 3 tables `row.visibility`
        // is always undefined, which isFederationPrivateVisibility() treats
        // as non-private (included) — a no-op for them.
        const sinceCursor = batch.filter((r: any) => r.updatedAt !== null || r.createdAt > since);
        const federable = sinceCursor.filter((r: any) => table !== "Memory" || !isFederationPrivateVisibility(r.visibility));
        if (table === "Memory") privateHeldBack += sinceCursor.length - federable.length;
        rows = rows.concat(federable);
      }
      if (rows.length === 0) continue;

      // Records are signed (below) before they're batched, so the secret key
      // is needed here rather than only inside sendBatch. Still deferred
      // until we know THIS table has rows to send — preserves the "don't
      // load the key on a no-op run" property the original lazy load had.
      if (!secretKey) secretKey = await loadInstanceSecretKey(instance.id, opts);

      let batch: any[] = [];
      let batchBytes = 0;

      for (const row of rows) {
        const updatedAt = row.updatedAt ?? row.createdAt;
        const originatorInstanceId = instance.id;

        // Per-record signature (federation-edge-hardening slice 3a): signed by
        // THIS instance — the originator — over a versioned canonical form, so
        // a receiver (including a hub relaying this record onward to other
        // spokes) can verify authorship independent of who forwarded the
        // batch. Closes the hub-relay forgery hole — see
        // resources/Federation.ts FederationSync.post's verification gate.
        //
        // CONTRACT — must match reconstructRecordVerifyBody
        // (resources/federation-classify.ts) byte-for-byte. canonicalize()
        // sorts keys, so field ORDER doesn't matter, but the field SET and
        // values do. `v` versions the canonical form itself: a v:1
        // signature cannot verify as v:2 (principalId in the field set).
        //
        // v: 2 puts principalId in the signed payload when the row carries
        // a provenance stamp, and puts `v` on the wire so Phase 1
        // receivers (`const v = record.v ?? 1`) don't default these
        // records back to 1. Soul/Agent/Relationship have no stamp and
        // omit principalId; Memory without a stamp also omits it (the
        // receiver then skips Memory as principal_mismatch — absent is
        // not an accept).
        const principalId = principalIdFromRow(row);
        const signedPayload: Record<string, any> = {
          v: 2,
          table,
          id: row.id,
          data: row,
          updatedAt,
          originatorInstanceId,
        };
        if (principalId) signedPayload.principalId = principalId;
        const signature = signBody(signedPayload, secretKey);

        const sr: Record<string, any> = {
          v: 2,
          table,
          id: row.id,
          data: row,
          updatedAt,
          originatorInstanceId,
          signature,
        };
        if (principalId) sr.principalId = principalId;

        const srBytes = JSON.stringify(sr).length;

        if (batch.length >= BUDGET_RECORDS || (batch.length > 0 && batchBytes + srBytes > BUDGET_BYTES)) {
          const result = await sendBatch(batch);
          totalMerged += result.merged;
          totalSkipped += result.skipped;
          totalBatches++;
          batch = [];
          batchBytes = 0;
        }

        batch.push(sr);
        batchBytes += srBytes;
      }

      // Send final partial batch for this table
      if (batch.length > 0) {
        const result = await sendBatch(batch);
        totalMerged += result.merged;
        totalSkipped += result.skipped;
        totalBatches++;
      }
    }

    // Advance the local hub peer's lastSyncAt cursor. The hub-side
    // FederationSync handler updates ITS view of the spoke peer, but the
    // spoke never updated its own view of the hub — so `since` stayed at
    // whatever value was on the peer record at pair time (often near-epoch),
    // and every poll re-queried `updatedAt > since` and re-sent every
    // memory ever written. The receiver-side contentHash gate in
    // Federation.ts prevents the actual blob re-write, but advancing the
    // cursor here stops the redundant network traffic + Lambda compute
    // entirely. Task #146. Even no-change runs should advance.
    try {
      const advanceRes = await fetch(`${opsEndpoint}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          operation: "update",
          database: "flair",
          table: "Peer",
          records: [{ id: hub.id, lastSyncAt: syncStartedAt }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!advanceRes.ok) {
        const txt = await advanceRes.text().catch(() => "");
        console.warn(`⚠️  Local hub.lastSyncAt advance failed (${advanceRes.status}): ${txt.slice(0, 200)}. Next poll will re-send memories.`);
      }
    } catch (advErr: any) {
      console.warn(`⚠️  Local hub.lastSyncAt advance error: ${advErr?.message ?? advErr}. Next poll will re-send memories.`);
    }

    if (totalBatches === 0) {
      // No-change syncs must still ping the hub so it updates the
      // spoke's lastSyncAt (liveness). Without this, idle-but-alive spokes
      // look indistinguishable from dead ones on the hub dashboard.
      try {
        if (!secretKey) secretKey = await loadInstanceSecretKey(instance.id, opts);
        const pingBody = signBodyFresh({
          instanceId: instance.id,
          records: [],
          lamportClock: Date.now(),
        }, secretKey);
        const pingRes = await fetch(`${hubUrl}/FederationSync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pingBody),
          signal: AbortSignal.timeout(10_000),
        });
        if (!pingRes.ok) {
          const txt = await pingRes.text().catch(() => "");
          console.warn(`⚠️  Liveness ping to hub failed (${pingRes.status}): ${txt.slice(0, 200)}. Hub won't update spoke liveness.`);
        }
      } catch (pingErr: any) {
        console.warn(`⚠️  Liveness ping error: ${pingErr?.message ?? pingErr}. Hub won't update spoke liveness.`);
      }

      // flair#1232: "No changes" is true only when nothing was found since
      // the cursor. If rows were found and every one was withheld as private,
      // say so — count and reason only, never content. A zero withheld count
      // must not invent a private-withheld story.
      console.log(
        privateHeldBack > 0
          ? `No federable changes since last sync (${privateHeldBack} row${privateHeldBack === 1 ? "" : "s"} held back: private visibility).`
          : "No changes since last sync.",
      );
      return { pushed: 0, skipped: 0 };
    }

    console.log(`✅ Synced ${totalMerged} records (${totalSkipped} skipped) across ${totalBatches} batches`);
    return { pushed: totalMerged, skipped: totalSkipped };
  } catch (err: any) {
    return { pushed: totalMerged, skipped: totalSkipped, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export async function runFederationWatch(opts: any): Promise<void> {
  const intervalMs = Math.max(5, parseFloat(opts.interval) || 30) * 1000;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`flair federation watch — interval ${intervalMs / 1000}s. Ctrl-C to stop.`);
  try {
    while (!stopped) {
      try {
        const r = await runFederationSyncOnce(opts);
        const ts = new Date().toISOString();
        if (r.error) console.error(`[${ts}] sync error: ${r.error.message}`);
        else console.log(`[${ts}] sync ok — pushed ${r.pushed}, skipped ${r.skipped}`);
      } catch (err: any) {
        console.error(`[${new Date().toISOString()}] watch loop error: ${err.message}`);
      }
      // Sleep but exit early on signal
      const t = Date.now();
      while (!stopped && Date.now() - t < intervalMs) {
        const remaining = intervalMs - (Date.now() - t);
        await new Promise((r) => setTimeout(r, Math.min(250, remaining)));
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  console.log("flair federation watch — stopped.");
}

// `flair federation prune` — remove stale spoke peers (never the hub).
// Productizes flair#695 into a real CLI
// subcommand with safety: dry-run is the default, --apply required to delete.
function parseDuration(spec: string): number | null {
  // Accept forms like "30d", "12h", "90m". Returns milliseconds.
  // Rejects zero and sub-1-minute durations: a 0-ms cutoff would equal Date.now()
  // and prune every non-hub peer (Sherlock review on #314).
  const m = spec.match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mul = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[unit] ?? null;
  if (mul == null) return null;
  const ms = n * mul;
  const ONE_MINUTE = 60 * 1000;
  if (ms < ONE_MINUTE) return null;
  return ms;
}

export function register(program: Command): void {
  // ─── flair federation ────────────────────────────────────────────────────────

  const federation = program.command("federation").description("Manage federation (hub-and-spoke sync)");

  federation
    .command("status")
    .description("Show federation status and peer connections")
    .option("--port <port>", "Harper HTTP port")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
    .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
    .option("--json", "Emit JSON {instance, peers, driver} (also: pipe + FLAIR_OUTPUT=json)")
    .action(async (opts: any) => {
      // Same URL api() would have derived, including --port (the command
      // advertised --port but previously dropped it on the floor). Naming
      // that URL on fetch failure is only honest if it is the URL we probe.
      const baseUrl = resolveBaseUrl(opts).replace(/\/$/, "");
      const urlSetting = federationStatusUrlSetting(opts);
      const mode = render.resolveOutputMode(opts);

      // flair#1233: fetch instance and peers INDEPENDENTLY. One read failing
      // must never take down the whole render — the principle latestPeerContact
      // already documents for the driver verdict ("must never be the reason
      // `federation status` fails"), extended to the two primary reads. Print
      // what's available; mark the rest unverifiable.
      let instance: any = null;
      let instanceErr: any = null;
      try {
        instance = await api("GET", "/FederationInstance", undefined, { baseUrl });
      } catch (err) {
        instanceErr = rewriteFederationStatusFetchFailed(err, baseUrl, urlSetting);
      }

      // peers: null = unverifiable (the read failed), [] = verified empty.
      let peers: any[] | null = null;
      let peersErr: any = null;
      try {
        const r = await api("GET", "/FederationPeers", undefined, { baseUrl });
        peers = r.peers ?? [];
      } catch (err) {
        peersErr = rewriteFederationStatusFetchFailed(err, baseUrl, urlSetting);
      }

      // Auth-shaped failures stay FATAL even when the other read succeeded:
      // both endpoints sit behind the same allowAdmin gate, so a 401/403 is a
      // property of the session's credentials, not of one endpoint — and
      // degrading it to "unverifiable" would swallow the actionable remedy
      // (flair#634's UX, kept). Only non-auth failures degrade independently.
      // Both reads failed → nothing to render at all. Either way keep the
      // classic failure UX (auth remedy when it's an auth problem), exit
      // non-zero.
      if ((instanceErr && peersErr) || isFederationStatusAuthFailure(instanceErr) || isFederationStatusAuthFailure(peersErr)) {
        const primaryErr = instanceErr ?? peersErr;
        const msg = String(primaryErr.message ?? primaryErr);
        if (isFederationStatusAuthRemedy(primaryErr)) {
          console.error(`${render.icons.error} federation status requires auth.`);
          console.error(`  ${render.wrap(render.c.dim, "Set one of:")}`);
          console.error(`    ${render.wrap(render.c.cyan, "FLAIR_AGENT_ID=<your-agent-id>")}     ${render.wrap(render.c.dim, "(Ed25519 — uses ~/.flair/keys/<id>.key)")}`);
          console.error(`    ${render.wrap(render.c.cyan, "FLAIR_ADMIN_PASS=<admin-password>")}  ${render.wrap(render.c.dim, "(admin Basic auth, remote targets)")}`);
          console.error(`    ${render.wrap(render.c.cyan, "FLAIR_TOKEN=<bearer>")}               ${render.wrap(render.c.dim, "(legacy)")}`);
          process.exit(1);
        }
        console.error(`${render.icons.error} ${msg}`);
        process.exit(1);
      }

      // Driver state (flair#922). Computed from the LOCAL service manager, so
      // it is only meaningful when the CLI is pointed at the local instance —
      // and only when the peer read succeeded: the verdict is derived from
      // peer contact, so with peers unverifiable it would be a confident claim
      // built on no data.
      let driver: import("../federation/scheduler.js").SchedulerStatus | null = null;
      let assessment: import("../federation/scheduler.js").DriverAssessment | null = null;
      if (peers !== null && driverCheckAppliesTo(opts)) {
        try {
          const { schedulerStatus, assessDriver } = await import("../federation/scheduler.js");
          driver = schedulerStatus();
          let lastSyncAt: string | null = null;
          for (const p of peers) {
            if (!p?.lastSyncAt) continue;
            const t = Date.parse(p.lastSyncAt);
            if (Number.isFinite(t) && (lastSyncAt === null || t > Date.parse(lastSyncAt))) {
              lastSyncAt = new Date(t).toISOString();
            }
          }
          assessment = assessDriver({
            installed: driver.installed,
            active: driver.active,
            intervalSeconds: driver.intervalSeconds,
            lastSyncAt,
            now: Date.now(),
          });
        } catch {
          // An unsupported platform (neither darwin nor linux) or an
          // unreadable unit must not take down `federation status` — the peer
          // table is still the primary output.
          driver = null;
          assessment = null;
        }
      }

      if (mode === "json") {
        console.log(render.asJSON({
          instance,
          peers,
          driver,
          driverAssessment: assessment,
          // flair#1233: name what could not be read, so a partial result is
          // distinguishable from "verified absent" (instance/peers stay null
          // when their read failed).
          ...(instanceErr || peersErr
            ? {
                unverifiable: {
                  ...(instanceErr ? { instance: String(instanceErr.message ?? instanceErr) } : {}),
                  ...(peersErr ? { peers: String(peersErr.message ?? peersErr) } : {}),
                },
              }
            : {}),
        }));
        return;
      }

      console.log(render.wrap(render.c.bold, "Federation"));
      if (instance) {
        const statusColor = instance.status === "active" ? render.c.green : render.c.yellow;
        console.log(render.kv("Instance", `${instance.id}  ${render.wrap(render.c.dim, `(${instance.role})`)}`));
        console.log(render.kv("Public key", render.wrap(render.c.dim, instance.publicKey)));
        console.log(render.kv("Status", render.wrap(statusColor, instance.status)));

        // flair#1233 degraded marker — actor + state + remedy. The server sets
        // signingKeyAvailable (runtime-only) on GET /FederationInstance; only
        // an explicit false fires this. Older servers omit the field, which
        // proves nothing either way, so no marker.
        if (instance.signingKeyAvailable === false) {
          console.log();
          console.log(`${render.icons.warn} ${render.wrap(render.c.yellow, "Signing key unavailable — the server could not store or read this instance's private key.")}`);
          console.log(`  ${render.wrap(render.c.dim, "Reads (this status) still work; pair/sync signing on that instance will fail until the keystore is fixed.")}`);
          console.log(`  ${render.wrap(render.c.cyan, "Fix on the server: make $HOME/.flair/keys (under the Harper process's HOME) a directory writable by the Harper process, mode 0700. If the key was never stored, re-key: delete the Instance row and re-pair.")}`);
        }
      } else {
        // Instance read failed but peers succeeded — render what we have.
        console.log(render.kv("Instance", `${render.icons.warn} unverifiable — ${render.wrap(render.c.dim, String(instanceErr?.message ?? instanceErr))}`));
      }

      if (peers === null) {
        // Peer read failed but the instance rendered — say so explicitly
        // instead of aborting: "unverifiable" is a different claim from "no
        // peers", and conflating them is how hub state became unobservable.
        console.log();
        console.log(`${render.icons.warn} ${render.wrap(render.c.yellow, "Peers unverifiable — the peer read failed. This says nothing about whether peers exist or sync runs.")}`);
        console.log(`  ${render.wrap(render.c.dim, String(peersErr?.message ?? peersErr))}`);
        return;
      }

      if (peers.length === 0) {
        console.log(`\n${render.icons.info} ${render.wrap(render.c.dim, "No peers configured. Use 'flair federation pair' to connect to a hub.")}`);
        return;
      }

      // Print the driver line BEFORE the per-peer table: "is anything running
      // sync at all" is the question that decides how to read everything
      // below it.
      if (assessment) {
        const icon = assessment.verdict === "driving" || assessment.verdict === "external-driver"
          ? render.icons.ok
          : assessment.verdict === "unknown"
            ? render.icons.info
            : render.icons.warn;
        const color = assessment.verdict === "driving" || assessment.verdict === "external-driver"
          ? render.c.green
          : assessment.verdict === "unknown"
            ? render.c.dim
            : render.c.yellow;
        console.log();
        console.log(`${icon} ${render.wrap(color, assessment.headline)}`);
        console.log(`  ${render.wrap(render.c.dim, assessment.detail)}`);
        if (assessment.remedy) console.log(`  ${render.wrap(render.c.cyan, assessment.remedy)}`);
      }

      const now = Date.now();
      const formatPeerAge = (iso: string | null, refNow: number, staleAfterMs: number): string => {
        if (!iso) return render.wrap(render.c.red, "never");
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return render.wrap(render.c.red, "never");
        const ageMs = refNow - t;
        const ageStr = ageMs < 60_000 ? "<1m ago"
          : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago`
          : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago`
          : `${Math.floor(ageMs / 86_400_000)}d ago`;
        const stale = ageMs > staleAfterMs;
        return render.wrap(stale ? render.c.yellow : render.c.dim, ageStr);
      };
      console.log();
      const cols: render.TableColumn[] = [
        { label: "peer", key: "id" },
        { label: "role", key: "role", format: (v) => String(v ?? "—") },
        {
          label: "status",
          key: "status",
          format: (v) => {
            const s = String(v ?? "—");
            const color = s === "paired" || s === "connected" || s === "active" ? render.c.green : s === "revoked" ? render.c.red : render.c.yellow;
            return render.wrap(color, s);
          },
        },
        {
          // Liveness: "did we hear from this peer recently?" Updates on every
          // contact, even when 100% of records were skipped. See flair#444.
          label: "last_sync",
          key: "lastSyncAt",
          format: (v) => formatPeerAge(v as string | null, now, 86_400_000),
        },
        {
          // Progress: "did data actually flow in?" Updates only when merged>0.
          // Diverging from last_sync means contact-yes but data-no — investigate.
          label: "last_merge",
          key: "lastMergeAt",
          format: (v) => formatPeerAge(v as string | null, now, 86_400_000),
        },
        {
          label: "relay",
          key: "relayOnly",
          format: (v) => (v ? render.wrap(render.c.cyan, "yes") : render.wrap(render.c.dim, "no")),
        },
      ];
      console.log(render.table(cols, peers as Array<Record<string, unknown>>));

      // Stale warning is gated on lastMergeAt (real progress), not lastSyncAt.
      // A peer that "syncs" every 5min but hasn't merged a record in 24h is
      // exactly the failure mode we want surfaced.
      const haveStale = peers.some((p: any) => {
        const cursor = p.lastMergeAt ?? p.lastSyncAt;
        if (!cursor) return true;
        const t = Date.parse(cursor);
        return !Number.isFinite(t) || (now - t) > 86_400_000;
      });
      if (haveStale) {
        console.log();
        // The staleness warning used to fire identically whether sync was
        // running and the peer was unreachable, or nothing had run sync since
        // the day the spoke was paired (flair#922). Those need opposite
        // actions, so the remedy is now chosen by the driver verdict instead
        // of always pointing at SyncLog.
        const noDriver = assessment?.verdict === "no-driver" || assessment?.verdict === "driver-inactive";
        const remedy = noDriver
          ? "Nothing is driving sync — see the driver line above. Run 'flair federation sync enable'."
          : "Check skippedReasons in SyncLog or run 'flair federation sync'.";
        console.log(`${render.icons.warn} ${render.wrap(render.c.yellow, "One or more peers haven't merged a record in >24h.")} ${render.wrap(render.c.dim, remedy)}`);
      }

      const haveContactButNoMerge = peers.some((p: any) => {
        if (!p.lastSyncAt || !Number.isFinite(Date.parse(p.lastSyncAt))) return false;
        if ((now - Date.parse(p.lastSyncAt)) > 3_600_000) return false; // only recent contact
        // Contact within the last hour, but no merge ever (or stale by >1h)
        if (!p.lastMergeAt) return true;
        const tm = Date.parse(p.lastMergeAt);
        return !Number.isFinite(tm) || (now - tm) > 3_600_000;
      });
      if (haveContactButNoMerge && !haveStale) {
        console.log();
        console.log(`${render.icons.warn} ${render.wrap(render.c.yellow, "Peer contact is fresh but no records merged in the last hour.")} ${render.wrap(render.c.dim, "Possible silent-skip scenario — check SyncLog.skippedReasons.")}`);
      }
    });

  // `flair federation reachability` — probe local instance + all paired peers.
  // Productizes flair#695: a single command that tells
  // you whether memories CAN flow across the federation right now. Read-only;
  // no mutations, no side effects beyond a single tagged status read per peer.
  federation
    .command("reachability")
    .description("Probe local Flair + each paired peer for reachability (read-only)")
    .option("--port <port>", "Harper HTTP port")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
    .option("--quiet", "Suppress output on full success")
    .option("--json", "Emit machine-readable JSON instead of text")
    .option("--peer-timeout <seconds>", "HTTP timeout per peer probe (default 5)", "5")
    .action(async (opts: any) => {
      const target = resolveTarget(opts);
      const baseUrl = target ? target.replace(/\/$/, "") : undefined;
      const timeoutMs = (Number(opts.peerTimeout) || 5) * 1000;
      type Result = { host: string; port: number | null; status: "ok" | "fail" | "skip"; detail: string };
      const results: Result[] = [];

      // 1. Local probe.
      try {
        const inst = await api("GET", "/FederationInstance", undefined, baseUrl ? { baseUrl } : undefined);
        results.push({ host: "local", port: null, status: "ok", detail: `instance ${inst.id} (${inst.role}, ${inst.status})` });
      } catch (e: any) {
        results.push({ host: "local", port: null, status: "fail", detail: e.message });
      }

      // 2. Per-peer probes. For each peer with an `endpoint` (URL), probe it.
      // Peers without an endpoint are reverse-tunnel-paired (the spoke can't
      // reach the hub directly without the tunnel) and we skip.
      let peers: any[] = [];
      try {
        const r = await api("GET", "/FederationPeers", undefined, baseUrl ? { baseUrl } : undefined);
        peers = r.peers ?? [];
      } catch (e: any) {
        results.push({ host: "/FederationPeers", port: null, status: "fail", detail: e.message });
      }

      for (const p of peers) {
        const endpoint = p.endpoint as string | undefined;
        if (!endpoint) {
          results.push({ host: p.id, port: null, status: "skip", detail: `${p.role ?? "—"} (no endpoint — needs tunnel)` });
          continue;
        }
        // Any HTTP response (including 401) means the peer is reachable + responding.
        // We're checking the network path, not auth; 401 is expected for unauth probes.
        // Use new URL() to avoid path-swallowing when endpoint includes a query
        // (Sherlock review on #314).
        let probeUrl: URL;
        try {
          probeUrl = new URL("/Health", endpoint);
        } catch {
          results.push({ host: p.id, port: null, status: "fail", detail: `${p.role ?? "—"} invalid endpoint URL` });
          continue;
        }
        if (probeUrl.protocol !== "http:" && probeUrl.protocol !== "https:") {
          results.push({ host: p.id, port: null, status: "fail", detail: `${p.role ?? "—"} unsupported protocol ${probeUrl.protocol}` });
          continue;
        }
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), timeoutMs);
          const res = await fetch(probeUrl, { signal: ctrl.signal });
          clearTimeout(t);
          results.push({ host: p.id, port: null, status: "ok", detail: `${p.role ?? "—"} HTTP ${res.status}` });
        } catch (e: any) {
          const msg = e.name === "AbortError" ? `timeout after ${opts.peerTimeout}s` : e.message;
          results.push({ host: p.id, port: null, status: "fail", detail: `${p.role ?? "—"} ${msg}` });
        }
      }

      const failures = results.filter(r => r.status === "fail").length;

      if (opts.json) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), failures, results }, null, 2));
      } else if (!(opts.quiet && failures === 0)) {
        console.log(`── Flair reachability — ${new Date().toISOString()} ──`);
        for (const r of results) {
          const tag = r.status === "ok" ? "OK  " : r.status === "skip" ? "SKIP" : "FAIL";
          console.log(`${tag} ${r.host.padEnd(40)} ${r.detail}`);
        }
        if (failures > 0) {
          console.log(`── ${failures} path(s) FAILED ──`);
        } else {
          console.log("── all reachable ──");
        }
      }

      if (failures > 0) process.exit(1);
    });

  federation
    .command("pair <hub-url>")
    .description("Pair this spoke with a hub instance")
    .option("--port <port>", "Harper HTTP port")
    .option("--admin-pass <pass>", "Admin password")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--token <token>", "One-time pairing token from hub admin (env: FLAIR_PAIRING_TOKEN) [deprecated: use --token-from]")
    .option("--token-from <file>", "Read bootstrap triple from JSON file (use '-' for stdin)")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
    .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
    .action(async (hubUrl: string, opts: any) => {
      const target = resolveTarget(opts);
      const baseUrl = target ? target.replace(/\/$/, "") : undefined;
      try {
        const instance = await api("GET", "/FederationInstance", undefined, baseUrl ? { baseUrl } : undefined);
        console.log(`${target ? "Remote" : "Local"} instance: ${instance.id} (${instance.role})`);

        // Determine token source: --token-from wins if both specified
        if (opts.tokenFrom && opts.token) {
          console.error("warning: --token-from takes precedence over --token. The --token flag is deprecated; use --token-from <file> instead.");
        }

        let pairingToken: string;
        let authHeader: string | undefined;

        if (opts.tokenFrom) {
          // ── Bootstrap triple path (--token-from) ──
          const triple = parseTokenFromFile(opts.tokenFrom);
          pairingToken = triple.token;
          authHeader = `Basic ${Buffer.from(`${triple.user}:${triple.password}`).toString("base64")}`;
          console.log(`Using bootstrap user: ${triple.user}`);
        } else if (opts.token) {
          // ── Bare token path (--token) — deprecated ──
          pairingToken = opts.token || process.env.FLAIR_PAIRING_TOKEN;
          console.error("warning: --token is deprecated. Use --token-from <file> to keep credentials out of shell history.");

          // Warning: inline token may leak to shell history.
          const tokenFromEnv = !opts.token && !!process.env.FLAIR_PAIRING_TOKEN;
          if (shouldShowInlineSecretWarning(opts.token, tokenFromEnv, new Set(["--token"]), "--token")) {
            console.error(
              "warning: --token passed inline. Consider --token-from <file> or FLAIR_PAIRING_TOKEN env " +
              "to keep secrets out of shell history."
            );
          }
        } else {
          console.error("Error: --token or --token-from is required. Ask the hub admin to run 'flair federation token' and provide the token.");
          process.exit(1);
        }

        // Load secret key and sign the pairing request.
        const secretKey = await loadInstanceSecretKey(instance.id, opts);
        const pairBody: Record<string, any> = {
          instanceId: instance.id,
          publicKey: instance.publicKey,
          role: "spoke",
          pairingToken,
        };
        const signedBody = signBodyFresh(pairBody, secretKey);

        const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (authHeader) {
          fetchHeaders.Authorization = authHeader;
        }

        const res = await fetch(`${hubUrl}/FederationPair`, {
          method: "POST",
          headers: fetchHeaders,
          body: JSON.stringify(signedBody),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(`Pairing failed: ${res.status} ${text}`);
          process.exit(1);
        }

        const result = await res.json() as any;

        // flair#822: fail-closed. Pair already returns instance.{id,publicKey}
        // when the hub has a FederationInstance row. A missing key means that
        // row was absent (#839) — ERROR, never store "". Do not GET
        // /FederationInstance: bootstrap Basic cannot read it (allowAdmin),
        // and a successful GET find-or-creates a hub Instance. A spoke Peer
        // write does not provision the hub row.
        const resolvedHub = resolveHubPeerIdentity(result);
        if (resolvedHub.ok === false) {
          console.error(`Error: ${resolvedHub.error}`);
          process.exit(1);
        }
        console.log(`✅ Paired with hub: ${resolvedHub.peer.id}`);

        // Record the hub as our local peer. This is REQUIRED, not optional:
        // `flair federation sync` reads the Peer table to find the hub, so
        // without this record sync reports "No hub peer configured" and silently
        // never runs. Previously this was gated on `if (adminPass)` and the write
        // result was never checked — pairing with only an agent key (or a failed
        // upsert) left no peer behind a misleadingly green "✅ Paired".
        const adminPass = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD ?? "";
        if (!adminPass) {
          console.error(
            "Error: paired on the hub, but the local hub-peer record needs admin auth to write — " +
            "pass --admin-pass, or set FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD, then re-run pair. " +
            "Without it, 'flair federation sync' will report 'No hub peer configured'."
          );
          process.exit(1);
        }
        const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
        const opsEndpoint = resolveEffectiveOpsUrl(opts) ?? `http://127.0.0.1:${resolveOpsPort(opts)}`;
        const peerRes = await fetch(`${opsEndpoint}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({
            operation: "upsert", database: "flair", table: "Peer",
            records: [{
              id: resolvedHub.peer.id,
              publicKey: resolvedHub.peer.publicKey,
              role: "hub", endpoint: hubUrl, status: "paired",
              pairedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!peerRes.ok) {
          const text = await peerRes.text().catch(() => "");
          console.error(
            `Error: paired with the hub but failed to write the local hub-peer record ` +
            `(${peerRes.status} ${text.slice(0, 200)}). Ops endpoint: ${opsEndpoint}. ` +
            `'flair federation sync' will not find the hub until this succeeds — check --admin-pass and the ops port.`
          );
          process.exit(1);
        }
        console.log(`✅ Recorded hub as local peer: ${resolvedHub.peer.id} → ${hubUrl}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  federation
    .command("token")
    .description("Generate a one-time pairing token (run on the hub)")
    .option("--port <port>", "Harper HTTP port")
    .option("--admin-pass <pass>", "Admin password")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--ttl <minutes>", "Token TTL in minutes (default: 60)", "60")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
    .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
    .option("--format <format>", "Output format: json (default) or text (bare token, deprecated)", "json")
    .action(async (opts: any) => {
      const target = resolveTarget(opts);
      const baseUrl = target ? target.replace(/\/$/, "") : undefined;
      try {
        const token = randomBytes(24).toString("base64url");
        const ttlMinutes = parseInt(opts.ttl, 10) || 60;
        const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

        const opsEndpoint = resolveEffectiveOpsUrl(opts) ?? `http://127.0.0.1:${resolveOpsPort(opts)}`;
        const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
        const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;

        // 1. Persist the PairingToken record
        const opsRes = await fetch(`${opsEndpoint}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({
            operation: "upsert", database: "flair", table: "PairingToken",
            records: [{
              id: token,
              createdAt: new Date().toISOString(),
              expiresAt,
            }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!opsRes.ok) {
          const detail = await opsRes.text().catch(() => "");
          throw new Error(`Failed to persist pairing token (${opsRes.status}): ${detail || "no body"}`);
        }

        // 2. Create bootstrap user for this token
        const bootstrapPassword = randomBytes(32).toString("base64url");
        const bootstrapUsername = `pair-bootstrap-${token.slice(0, 8)}`;

        let addUserRes: Response;
        try {
          addUserRes = await fetch(`${opsEndpoint}/`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({
              operation: "add_user",
              username: bootstrapUsername,
              password: bootstrapPassword,
              role: "flair_pair_initiator",
              active: true,
            }),
            signal: AbortSignal.timeout(10_000),
          });
        } catch (err: any) {
          // Network failure creating bootstrap user — roll back PairingToken
          await fetch(`${opsEndpoint}/`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({
              operation: "delete",
              database: "flair",
              table: "PairingToken",
              hash_value: token,
            }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => {});
          throw new Error(`Failed to create bootstrap user (network): ${err.message}`);
        }

        if (!addUserRes.ok) {
          // add_user failed — roll back PairingToken so the two stay in sync
          await fetch(`${opsEndpoint}/`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({
              operation: "delete",
              database: "flair",
              table: "PairingToken",
              hash_value: token,
            }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => {});
          const detail = await addUserRes.text().catch(() => "");
          throw new Error(`Failed to create bootstrap user (${addUserRes.status}): ${detail || "no body"}`);
        }

        // 3. Output
        const format = (opts.format ?? "json").toLowerCase();
        if (format === "text") {
          process.stderr.write(`[DEPRECATION] --format text is deprecated. Default output is now JSON.\n`);
          console.log(token);
        } else {
          console.log(JSON.stringify({ token, user: bootstrapUsername, password: bootstrapPassword, expiresAt }, null, 2));
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  const federationSync = addSharedCredentialOptions(
    federation
      .command("sync")
      .description("Push local changes to the hub (one-shot). Subcommands manage the scheduled driver.")
      .option("--port <port>", "Harper HTTP port")
      .option("--ops-port <port>", "Harper operations API port")
      .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
      .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)"),
  ).action(async (opts: any) => {
      // --admin-pass-file resolves into the same `adminPass` slot the inline
      // flag uses, so the scheduler never has to embed a secret in a unit file.
      applyAdminPassFile(opts);
      const r = await runFederationSyncOnce(opts);
      if (r.error) {
        console.error(`Error: ${r.error.message}`);
        process.exit(1);
      }
    });

  // ─── flair federation sync enable | disable | status ────────────────────────
  // The supervised driver (flair#922). Federation had no automatic driver at
  // all: `sync` is one-shot and `watch` is a foreground loop that dies with its
  // terminal, so every operator paired a spoke, saw one successful sync, and
  // then silently stopped syncing.
  //
  // Shape deliberately mirrors `flair rem nightly enable|disable|status` —
  // same verbs, same platform coverage (launchd on macOS, systemd --user timer
  // on Linux), same "never claim success before activation succeeded" rule.
  // Strategy is a PERIODIC ONE-SHOT rather than a supervised long-lived
  // watcher; the reasoning is in src/federation/scheduler.ts's header.

  federationSync
    .command("enable")
    .description("Install the sync driver (launchd on macOS, systemd timer on Linux)")
    .option("--interval <seconds>", `Seconds between syncs (default ${FEDERATION_SYNC_DEFAULT_INTERVAL})`, String(FEDERATION_SYNC_DEFAULT_INTERVAL))
    // Deliberately NOT `--no-admin-pass-file`: commander treats a `--no-x` flag
    // as the negation of `--x`, and declaring both on one command makes the
    // POSITIVE option silently parse to undefined — `--admin-pass-file /path`
    // would be accepted and dropped, producing a driver that fails auth every
    // cycle with no error anywhere. Verified against commander 14.
    .option("--no-credentials", "Do not wire any credential file into the unit")
    // `--admin-pass-file` and `--target` are NOT redeclared here (flair#926).
    // The parent `flair federation sync` owns both, and commander matches an
    // option against the parent's list before dispatching — so a duplicate
    // declaration here never receives a value, it only makes the option LOOK
    // local. Both flags still work on this command; they arrive via
    // optsWithGlobals() below and are listed under "Global Options" in --help.
    .addHelpText(
      "after",
      "\nCredentials:\n"
        + "  --admin-pass-file defaults to ~/.flair/admin-pass when that file exists.\n"
        + "  The PATH is stored in the unit — never the password.\n",
    )
    .action(async (_opts: any, cmd: any) => {
      // optsWithGlobals(), NOT the action's first argument: `--admin-pass-file`
      // and `--target` are declared on the PARENT (`flair federation sync`), and
      // commander binds their values there. The subcommand's own opts() has no
      // entry for them at all. Reading only the local opts silently dropped
      // `--admin-pass-file <path>` here (flair#923), which installed a driver
      // that failed auth every cycle with no error anywhere. Verified against
      // commander 14; test/unit/cli-option-collisions.test.ts pins the rule.
      const opts = cmd.optsWithGlobals();
      const intervalSeconds = Number(opts.interval);
      if (!Number.isFinite(intervalSeconds)) {
        console.error(`Error: --interval must be a number of seconds (got: ${opts.interval})`);
        process.exit(1);
      }

      // Default to the canonical admin-pass file when it is actually there.
      // Silently wiring a path that does not exist would produce a driver that
      // runs and fails auth every interval — the failure mode this whole issue
      // is about, in a new costume.
      let adminPassFile: string | undefined;
      if (opts.credentials === false) {
        adminPassFile = undefined;
      } else if (typeof opts.adminPassFile === "string" && opts.adminPassFile) {
        adminPassFile = opts.adminPassFile;
      } else {
        const fallback = defaultAdminPassPath();
        adminPassFile = existsSync(fallback) ? fallback : undefined;
      }

      const { enableScheduler, formatEnableReport } = await import("../federation/scheduler.js");
      try {
        const r = enableScheduler({ intervalSeconds, adminPassFile, target: opts.target });
        const { lines, ok } = formatEnableReport(r, { adminPassFile, target: opts.target });
        for (const line of lines) console.log(line);
        if (!ok) process.exit(1);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  federationSync
    .command("disable")
    .description("Remove the sync driver (peers and sync history are preserved)")
    .option("--remove-shim", "Also delete the ~/.flair/bin/flair-federation-sync shim")
    .action(async (opts: any) => {
      const { disableScheduler } = await import("../federation/scheduler.js");
      try {
        const r = disableScheduler({ removeShim: !!opts.removeShim });
        if (r.removed.length === 0) {
          console.log(`(Federation sync driver was not installed on ${r.platform})`);
          return;
        }
        console.log(`✅ Federation sync driver disabled (${r.platform})`);
        console.log(`   Removed:`);
        for (const p of r.removed) console.log(`     ${p}`);
        if (r.unloadResult && r.unloadResult.code !== 0) {
          console.log(`   Unload:      ${r.unloadCommand.join(" ")} → code ${r.unloadResult.code}`);
          if (r.unloadResult.stderr) console.log(`     stderr: ${r.unloadResult.stderr.trim()}`);
        }
        console.log(`\nPeers, keys and sync history are untouched. Nothing will sync until you`);
        console.log(`re-enable the driver or run \`flair federation sync\` by hand.`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  federationSync
    .command("status")
    .description("Show whether a sync driver is installed and genuinely active")
    // `--port` and `--target` are NOT redeclared here (flair#926) — the parent
    // `flair federation sync` owns them and commander binds them there. They
    // still work on this command, via optsWithGlobals() below.
    .option("--json", "Emit JSON")
    .action(async (_opts: any, cmd: any) => {
      // See the comment on `enable` above: `--target`/`--port` live on the
      // parent, so commander binds them there and only optsWithGlobals() sees
      // them.
      const opts = cmd.optsWithGlobals();
      const { schedulerStatus, formatStatusReport, assessDriver } = await import("../federation/scheduler.js");
      try {
        const s = schedulerStatus();
        const lastSyncAt = await latestPeerContact(opts);
        const a = assessDriver({
          installed: s.installed,
          active: s.active,
          intervalSeconds: s.intervalSeconds,
          lastSyncAt,
          now: Date.now(),
        });
        if (render.resolveOutputMode(opts) === "json") {
          console.log(render.asJSON({ driver: s, assessment: a, lastSyncAt }));
          return;
        }
        const { lines } = formatStatusReport(s, a);
        for (const line of lines) console.log(line);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  federation
    .command("watch")
    .description("Run federation sync in a loop (foreground daemon)")
    .option("--interval <seconds>", "Seconds between syncs", "30")
    .option("--port <port>", "Harper HTTP port")
    .option("--admin-pass <pass>", "Admin password")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--target <url>", "Remote Flair URL")
    .option("--ops-target <url>", "Explicit ops API URL")
    .action(async (opts: any) => {
      await runFederationWatch(opts);
    });

  federation
    .command("prune")
    .description("Remove stale spoke peers (older than --older-than). Hub is never pruned. Default dry-run.")
    .option("--older-than <duration>", "Duration spec (e.g. 30d, 12h, 90m)", "30d")
    .option("--apply", "Actually delete (default is dry-run)")
    .option("--include <pattern>", "Only consider peer IDs starting with this prefix")
    .option("--port <port>", "Harper HTTP port")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--target <url>", "Remote Flair URL")
    .option("--ops-target <url>", "Explicit ops API URL")
    .action(async (opts: any) => {
      const target = resolveTarget(opts);
      const baseUrl = target ? target.replace(/\/$/, "") : undefined;
      const olderThanMs = parseDuration(opts.olderThan);
      if (olderThanMs == null) {
        console.error(`Error: invalid or unsafe --older-than '${opts.olderThan}'. Use forms like 30d, 12h, 90m. Minimum 1 minute.`);
        process.exit(2);
      }
      const cutoff = Date.now() - olderThanMs;

      let peers: any[] = [];
      try {
        const r = await api("GET", "/FederationPeers", undefined, baseUrl ? { baseUrl } : undefined);
        peers = r.peers ?? [];
      } catch (e: any) {
        console.error(`Error fetching peers: ${e.message}`);
        process.exit(1);
      }

      const candidates = peers.filter(p => {
        // Hub-protection: never prune. Case-insensitive; null/undefined role is
        // treated as "unknown — refuse to prune to be safe" (Sherlock review on #314).
        const role = (p.role ?? "").toString().toLowerCase();
        if (role === "hub" || role === "") return false;
        // Include filter.
        if (opts.include && !String(p.id ?? "").startsWith(opts.include)) return false;
        // Stale threshold: a peer with NO lastSyncAt is treated as having been
        // born and immediately abandoned — qualifies if it's older than the
        // threshold based on pairedAt instead.
        const ts = p.lastSyncAt ?? p.pairedAt;
        if (!ts) return true; // truly orphaned record — prune candidate.
        return new Date(ts).getTime() < cutoff;
      });

      if (candidates.length === 0) {
        console.log(`flair federation prune: no peers older than ${opts.olderThan} (and not hub) — nothing to do.`);
        return;
      }

      if (!opts.apply) {
        console.log(`── flair federation prune — dry-run (use --apply to delete) ──`);
        console.log(`Would delete ${candidates.length} peer(s) older than ${opts.olderThan}:`);
        for (const p of candidates) {
          const ts = p.lastSyncAt ?? p.pairedAt ?? "never";
          const age = ts === "never" ? "(never synced/paired)" : `${Math.floor((Date.now() - new Date(ts).getTime()) / (24 * 60 * 60 * 1000))}d ago`;
          console.log(`  ${p.id}  ${(p.role ?? "—").padEnd(8)} lastSyncAt ${ts} (${age})`);
        }
        console.log(`Run with --apply to actually delete.`);
        return;
      }

      // Apply path. Delete each peer via the Harper ops API. We use the
      // domain-socket form when local; otherwise we fall back to the resource
      // DELETE which requires admin auth.
      let deleted = 0;
      let errors = 0;
      for (const p of candidates) {
        try {
          const res = await api("DELETE", `/FederationPeers/${encodeURIComponent(p.id)}`, undefined, baseUrl ? { baseUrl } : undefined);
          const ok = res?.ok ?? res?.deleted ?? true;
          if (ok) {
            deleted++;
            const ts = p.lastSyncAt ?? p.pairedAt ?? "never";
            console.log(`Deleted ${p.id} (last seen ${ts}).`);
          } else {
            errors++;
            console.log(`Failed to delete ${p.id}: ${JSON.stringify(res)}`);
          }
        } catch (e: any) {
          errors++;
          console.log(`Failed to delete ${p.id}: ${e.message}`);
        }
      }
      console.log(`${deleted} peer(s) deleted; ${errors} error(s).`);
      if (errors > 0) process.exit(1);
    });

  // `flair federation verify` — end-to-end roundtrip: write a tagged memory
  // locally, push it (bring-up has no daemon yet), probe peers for the tag.
  // Same class as fleet-verify / flair#988: 401/403 and unreachable are
  // UNVERIFIABLE (warning), a reachable missing canary still FAILs (flair#823).
  addSharedCredentialOptions(
    addSharedIdentityOption(
      federation
        .command("verify")
        .description("End-to-end check: write a tagged memory, push it, and verify it shows up on each peer")
        .option("--peer <id>", "Verify only against this peer ID (default: all hubs + spokes)")
        .option("--wait <seconds>", "Post-push probe window in seconds (default 60)", "60")
        .option("--tag <prefix>", "Memory tag prefix (default: fed-verify)", "fed-verify")
        .option("--port <port>", "Harper HTTP port")
        .option("--ops-port <port>", "Harper operations API port")
        .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
        .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)"),
    ),
  ).action(async (opts: any) => {
      applyAdminPassFile(opts);
      const target = resolveTarget(opts);
      const baseUrl = target ? target.replace(/\/$/, "") : undefined;
      const waitSeconds = Number(opts.wait) || 60;
      const tag = `${opts.tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("Error: FLAIR_AGENT_ID not set. Set it, pass --agent, or use 'flair agent default <id>'.");
        process.exit(1);
      }

      const result = await runFederationVerify({
        agentId,
        waitMs: waitSeconds * 1000,
        waitSeconds,
        tag,
        peerId: opts.peer,
        baseUrl,
        syncOpts: opts,
        // GET /FederationPeers is allowAdmin. applyAdminPassFile already
        // folded --admin-pass-file into opts.adminPass; without this the
        // injected api only sees { baseUrl } and flag-only creds never
        // reach the listing (UNVERIFIABLE, check never runs).
        explicitAdminPass: opts.adminPass,
        adminUser: opts.adminUser,
      }, {
        api,
        syncOnce: runFederationSyncOnce,
        fetch,
        log: (msg) => console.log(msg),
        error: (msg) => console.error(msg),
      });
      if (result.exitCode !== 0) process.exit(result.exitCode);
    });
}
