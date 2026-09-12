/**
 * federation-verify.ts — `flair federation verify` (flair#823)
 *
 * End-to-end canary: write a tagged memory locally, push it (bring-up has
 * no sync daemon yet), then probe each peer. Same class as fleet-verify /
 * flair#988: separate "couldn't check" from "verified wrong."
 *
 *   UNVERIFIABLE (warning, exit 0): HTTP 401/403, unreachable, revoked,
 *     no endpoint, or we could not inject the canary while lastSyncAt is
 *     still fresh.
 *   FAIL (exit 1): a reachable, authenticated peer is missing the canary
 *     after a successful push — or lastSyncAt is stale when we could not
 *     inject and the peer answered 200 without the tag.
 *   OK (exit 0): the canary was found.
 *
 * Revoked peers are UNVERIFIABLE (listed, not probed, not FAIL) — Cos
 * mid-flight: same couldn't-check bucket as 401 / unreachable. Authenticating
 * the probe may later use #822's publicKey; this module does not wait on it.
 * Do NOT always exit 0 — a verified-wrong reachable peer still fails.
 */

import { validatePeerEndpoint } from "./fleet-verify.js";
import {
  DEFAULT_INTERVAL_SECONDS,
  freshnessWindowMs,
} from "./federation/scheduler.js";

// ─── Result shape ────────────────────────────────────────────────────────────

export type FederationVerifyStatus = "ok" | "fail" | "unverifiable";

export interface FederationPeerRecord {
  id: string;
  role?: string;
  status?: string;
  endpoint?: string | null;
  lastSyncAt?: string | null;
}

export interface FederationPeerResult {
  id: string;
  status: FederationVerifyStatus;
  detail: string;
  lastSyncAt: string | null;
  /** True when we received HTTP 200 from this peer (authenticated enough to search). */
  authenticated: boolean;
}

export const FED_VERIFY_EXIT_OK = 0;
export const FED_VERIFY_EXIT_DIVERGED = 1;

export type FederationVerifyKind = "ok" | "diverged" | "unverifiable-only" | "empty";

export interface FederationVerifyVerdict {
  kind: FederationVerifyKind;
  exitCode: number;
  failedCount: number;
  unverifiableCount: number;
  okCount: number;
  /** Primary sentence. Never "FAIL / did not see the memory" for unverifiable-only. */
  summary: string;
  /**
   * Present when any peer is unverifiable. Warning, not a failure.
   * Same couldn't-check framing as flair#988.
   */
  warning: string | null;
}

export function defaultFreshnessMs(): number {
  return freshnessWindowMs(DEFAULT_INTERVAL_SECONDS);
}

export function lastSyncFreshness(
  lastSyncAt: string | null | undefined,
  nowMs: number,
  windowMs: number,
): { fresh: boolean; ageMs: number | null } {
  if (!lastSyncAt) return { fresh: false, ageMs: null };
  const t = Date.parse(lastSyncAt);
  if (!Number.isFinite(t)) return { fresh: false, ageMs: null };
  const ageMs = nowMs - t;
  return { fresh: ageMs <= windowMs, ageMs };
}

/**
 * After the wait window, a peer answered 200 but never showed the canary.
 * A successful push means we verified the write is absent → FAIL.
 * A failed/skipped push plus a fresh lastSyncAt is "couldn't inject,"
 * not "verified diverged." A stale reachable peer still FAILs.
 */
export function classifyMissingAfterWindow(input: {
  pushed: boolean;
  lastSyncAt: string | null | undefined;
  nowMs: number;
  freshnessMs: number;
  waitSeconds: number;
}): { status: "fail" | "unverifiable"; detail: string } {
  const { fresh, ageMs } = lastSyncFreshness(input.lastSyncAt, input.nowMs, input.freshnessMs);
  if (input.pushed) {
    return {
      status: "fail",
      detail: `timeout — reachable peer did not have the canary after push within ${input.waitSeconds}s`,
    };
  }
  if (fresh) {
    const age = ageMs == null ? "unknown" : `${Math.floor(ageMs / 1000)}s ago`;
    return {
      status: "unverifiable",
      detail:
        `could not push canary; lastSyncAt is fresh (${age}) — could not confirm this write propagated`,
    };
  }
  const age = ageMs == null ? "never" : `${Math.floor(ageMs / 1000)}s ago`;
  return {
    status: "fail",
    detail: `timeout — reachable peer missing canary; lastSyncAt stale/absent (${age})`,
  };
}

/** Immediate classification of a single HTTP status from the read-back probe. */
export function classifyProbeHttpStatus(status: number): "found-ok" | "auth" | "other" {
  if (status === 401 || status === 403) return "auth";
  if (status >= 200 && status < 300) return "found-ok";
  return "other";
}

export function authUnverifiableDetail(status: number): string {
  return `HTTP ${status} — could not authenticate to peer (couldn't check, not a sync failure)`;
}

/**
 * Revoked rows are decommissioned. Do not HTTP-probe them, and do not FAIL
 * them — Cos / flair#823: revoked = UNVERIFIABLE (warn), same bucket as
 * 401 / unreachable.
 */
export function selectPeersToProbe(
  peers: FederationPeerRecord[],
  onlyId?: string,
): { probe: FederationPeerRecord[]; skippedRevoked: FederationPeerRecord[] } {
  const skippedRevoked = peers.filter((p) => p.status === "revoked" && (!onlyId || p.id === onlyId));
  let probe = peers.filter((p) => p.status !== "revoked");
  if (onlyId) probe = probe.filter((p) => p.id === onlyId);
  return { probe, skippedRevoked };
}

export function revokedAsUnverifiable(p: FederationPeerRecord): FederationPeerResult {
  return {
    id: p.id,
    status: "unverifiable",
    detail: "revoked — could not check (intentional, not a sync failure)",
    lastSyncAt: p.lastSyncAt ?? null,
    authenticated: false,
  };
}

function formatUnverifiableWarning(unverifiableCount: number, checkedOk: number): string {
  return (
    `${unverifiableCount} peer(s) unverifiable — could not check ` +
    `(auth refused, unreachable, revoked, or no endpoint); ` +
    `${checkedOk} checked peer(s) have the memory.`
  );
}

/**
 * Separate "couldn't check" from "verified wrong" (flair#823 / #988).
 * Unverifiable peers never fail the run; a reachable missing-canary still does.
 */
export function describeFederationVerify(results: FederationPeerResult[]): FederationVerifyVerdict {
  const failed = results.filter((r) => r.status === "fail");
  const unverifiable = results.filter((r) => r.status === "unverifiable");
  const ok = results.filter((r) => r.status === "ok");
  const warning = unverifiable.length > 0
    ? formatUnverifiableWarning(unverifiable.length, ok.length)
    : null;

  if (results.length === 0) {
    return {
      kind: "empty",
      exitCode: FED_VERIFY_EXIT_OK,
      failedCount: 0,
      unverifiableCount: 0,
      okCount: 0,
      summary: "no peers to probe.",
      warning: null,
    };
  }

  if (failed.length > 0) {
    return {
      kind: "diverged",
      exitCode: FED_VERIFY_EXIT_DIVERGED,
      failedCount: failed.length,
      unverifiableCount: unverifiable.length,
      okCount: ok.length,
      summary: `FAIL: ${failed.length}/${results.length} peer(s) did not see the memory.`,
      warning,
    };
  }

  if (ok.length === 0 && unverifiable.length > 0) {
    return {
      kind: "unverifiable-only",
      exitCode: FED_VERIFY_EXIT_OK,
      failedCount: 0,
      unverifiableCount: unverifiable.length,
      okCount: 0,
      summary: "no reachable peer was verified wrong.",
      warning,
    };
  }

  return {
    kind: "ok",
    exitCode: FED_VERIFY_EXIT_OK,
    failedCount: 0,
    unverifiableCount: unverifiable.length,
    okCount: ok.length,
    summary: `PASS: memory propagated to all ${ok.length} checked peer(s).`,
    warning,
  };
}

export function decideFederationVerifyExitCode(results: FederationPeerResult[]): number {
  return describeFederationVerify(results).exitCode;
}

export function renderFederationVerifyVerdict(verdict: FederationVerifyVerdict): string {
  const lines: string[] = [];
  if (verdict.warning) {
    lines.push(`── WARNING: ${verdict.warning} ──`);
  }
  if (verdict.kind === "diverged") {
    lines.push(`── ${verdict.summary} ──`);
    lines.push("Diagnostics to run next:");
    lines.push("  flair federation status     # confirm peers are paired + lastSyncAt is recent");
    lines.push("  flair federation reachability  # confirm peers are HTTP-reachable");
    lines.push("  flair federation sync       # push now (verify also does this itself)");
    lines.push("  curl <peer-endpoint>/Health  # raw probe");
  } else if (verdict.kind !== "empty") {
    lines.push(`── ${verdict.summary} ──`);
  }
  return lines.join("\n");
}

// ─── Injectable seams ────────────────────────────────────────────────────────

export interface FederationVerifyApi {
  (method: string, path: string, body?: unknown, opts?: { baseUrl?: string }): Promise<unknown>;
}

export interface FederationSyncOnceResult {
  pushed: number;
  skipped: number;
  error?: Error;
}

export interface FederationVerifyClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface FederationVerifyDeps {
  api: FederationVerifyApi;
  syncOnce: (opts: Record<string, unknown>) => Promise<FederationSyncOnceResult>;
  fetch: typeof fetch;
  clock?: FederationVerifyClock;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface FederationVerifyOptions {
  agentId: string;
  waitMs: number;
  waitSeconds: number;
  tag: string;
  peerId?: string;
  baseUrl?: string;
  /** Forwarded to runFederationSyncOnce (admin pass, ops port, target, …). */
  syncOpts: Record<string, unknown>;
  freshnessMs?: number;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface FederationVerifyResult {
  exitCode: number;
  verdict: FederationVerifyVerdict;
  peers: FederationPeerResult[];
  skippedRevoked: FederationPeerRecord[];
  memId: string | null;
  cleanedUp: boolean;
  pushed: boolean;
  tag: string;
}

function defaultClock(): FederationVerifyClock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function canaryContainsTag(data: unknown, tag: string): boolean {
  const results = (data as { results?: Array<{ content?: string }> } | null)?.results ?? [];
  return results.some((r) => (r.content ?? "").includes(tag));
}

export async function runFederationVerify(
  opts: FederationVerifyOptions,
  deps: FederationVerifyDeps,
): Promise<FederationVerifyResult> {
  const log = deps.log ?? (() => {});
  const err = deps.error ?? (() => {});
  const clock = deps.clock ?? defaultClock();
  const freshnessMs = opts.freshnessMs ?? defaultFreshnessMs();
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const apiOpts = opts.baseUrl ? { baseUrl: opts.baseUrl } : undefined;

  log(`── flair federation verify — ${new Date(clock.now()).toISOString()} ──`);
  log(`Tag: ${opts.tag}, wait window: ${opts.waitSeconds}s`);

  const memId = `${opts.agentId}-${clock.now()}-fed-verify`;
  const writtenAt = new Date(clock.now()).toISOString();
  try {
    await deps.api("PUT", `/Memory/${encodeURIComponent(memId)}`, {
      id: memId,
      agentId: opts.agentId,
      content: `${opts.tag} — federation verify probe written at ${writtenAt}`,
      type: "memory",
      durability: "ephemeral",
      // Ephemeral defaults to private; private never federates. Shared is
      // required so the canary actually leaves this instance.
      visibility: "shared",
      tags: ["federation-verify", opts.tag],
      createdAt: writtenAt,
    }, apiOpts);
    log(`1. Wrote local memory: ${memId}`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    err(`1. Local write FAILED: ${message}`);
    return {
      exitCode: FED_VERIFY_EXIT_DIVERGED,
      verdict: {
        kind: "diverged",
        exitCode: FED_VERIFY_EXIT_DIVERGED,
        failedCount: 0,
        unverifiableCount: 0,
        okCount: 0,
        summary: `local write failed: ${message}`,
        warning: null,
      },
      peers: [],
      skippedRevoked: [],
      memId: null,
      cleanedUp: true,
      pushed: false,
      tag: opts.tag,
    };
  }

  let pushed = false;
  let cleanedUp = false;
  let result: FederationVerifyResult = {
    exitCode: FED_VERIFY_EXIT_OK,
    verdict: describeFederationVerify([]),
    peers: [],
    skippedRevoked: [],
    memId,
    cleanedUp: false,
    pushed: false,
    tag: opts.tag,
  };

  try {
    log("   Pushing canary via federation sync…");
    const syncResult = await deps.syncOnce(opts.syncOpts);
    if (syncResult.error) {
      log(`   Push: FAILED (${syncResult.error.message}) — probing with lastSyncAt freshness`);
    } else {
      pushed = true;
      log(`   Push: synced ${syncResult.pushed} record(s) (${syncResult.skipped} skipped)`);
    }

    let listed: FederationPeerRecord[] = [];
    try {
      const r = await deps.api("GET", "/FederationPeers", undefined, apiOpts) as { peers?: FederationPeerRecord[] };
      listed = r.peers ?? [];
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      err(`Failed to list peers: ${message}`);
      const peers: FederationPeerResult[] = [{
        id: "(peer enumeration)",
        status: "unverifiable",
        detail: `GET /FederationPeers failed: ${message} — could not check any peer`,
        lastSyncAt: null,
        authenticated: false,
      }];
      const verdict = describeFederationVerify(peers);
      log(renderFederationVerifyVerdict(verdict));
      result = {
        exitCode: verdict.exitCode,
        verdict,
        peers,
        skippedRevoked: [],
        memId,
        cleanedUp: false,
        pushed,
        tag: opts.tag,
      };
      return result;
    }

    const selected = selectPeersToProbe(listed, opts.peerId);
    const skippedRevoked = selected.skippedRevoked;
    const toProbe = selected.probe;
    const revokedRows = skippedRevoked.map(revokedAsUnverifiable);
    for (const row of revokedRows) {
      log(`   ${row.id}  UNVERIFIABLE (${row.detail})`);
    }

    if (toProbe.length === 0) {
      if (revokedRows.length === 0) log("(no peers to probe)");
      const verdict = describeFederationVerify(revokedRows);
      log(renderFederationVerifyVerdict(verdict));
      result = {
        exitCode: verdict.exitCode,
        verdict,
        peers: revokedRows,
        skippedRevoked,
        memId,
        cleanedUp: false,
        pushed,
        tag: opts.tag,
      };
      return result;
    }

    log(`2. Probing ${toProbe.length} peer(s) over ${opts.waitSeconds}s window…`);

    const started = clock.now();
    const settled = new Map<string, FederationPeerResult>();
    const sawAuthenticatedMissing = new Set<string>();

    const settle = (row: FederationPeerResult) => {
      settled.set(row.id, row);
      const label = row.status === "ok" ? "OK" : row.status === "fail" ? "FAIL" : "UNVERIFIABLE";
      log(`   ${row.id}  ${label} (${row.detail})`);
    };

    while (clock.now() - started < opts.waitMs && settled.size < toProbe.length) {
      for (const p of toProbe) {
        if (settled.has(p.id)) continue;
        const endpointCheck = validatePeerEndpoint(p.endpoint);
        if ("error" in endpointCheck) {
          settle({
            id: p.id,
            status: "unverifiable",
            detail: endpointCheck.error,
            lastSyncAt: p.lastSyncAt ?? null,
            authenticated: false,
          });
          continue;
        }
        let probeUrl: URL;
        try {
          probeUrl = new URL("/SemanticSearch", endpointCheck.url);
        } catch {
          settle({
            id: p.id,
            status: "unverifiable",
            detail: `invalid endpoint URL: ${p.endpoint}`,
            lastSyncAt: p.lastSyncAt ?? null,
            authenticated: false,
          });
          continue;
        }
        try {
          const res = await deps.fetch(probeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: opts.tag, limit: 5 }),
            signal: AbortSignal.timeout(probeTimeoutMs),
          });
          const kind = classifyProbeHttpStatus(res.status);
          if (kind === "auth") {
            settle({
              id: p.id,
              status: "unverifiable",
              detail: authUnverifiableDetail(res.status),
              lastSyncAt: p.lastSyncAt ?? null,
              authenticated: false,
            });
            continue;
          }
          if (kind !== "found-ok") {
            // Retry 4xx/5xx other than 401/403 — couldn't complete this tick.
            continue;
          }
          const data = await res.json().catch(() => ({}));
          if (canaryContainsTag(data, opts.tag)) {
            const elapsed = Math.floor((clock.now() - started) / 1000);
            settle({
              id: p.id,
              status: "ok",
              detail: `memory found after ${elapsed}s`,
              lastSyncAt: p.lastSyncAt ?? null,
              authenticated: true,
            });
          } else {
            sawAuthenticatedMissing.add(p.id);
          }
        } catch {
          // Unreachable this tick — retry until the window elapses.
        }
      }
      if (settled.size < toProbe.length) {
        await clock.sleep(pollIntervalMs);
      }
    }

    for (const p of toProbe) {
      if (settled.has(p.id)) continue;
      if (sawAuthenticatedMissing.has(p.id)) {
        const classified = classifyMissingAfterWindow({
          pushed,
          lastSyncAt: p.lastSyncAt,
          nowMs: clock.now(),
          freshnessMs,
          waitSeconds: opts.waitSeconds,
        });
        settle({
          id: p.id,
          status: classified.status,
          detail: classified.detail,
          lastSyncAt: p.lastSyncAt ?? null,
          authenticated: true,
        });
      } else {
        settle({
          id: p.id,
          status: "unverifiable",
          detail: `unreachable — no successful probe within ${opts.waitSeconds}s (couldn't check, not a sync failure)`,
          lastSyncAt: p.lastSyncAt ?? null,
          authenticated: false,
        });
      }
    }

    const peers = [...revokedRows, ...toProbe.map((p) => settled.get(p.id)!)];
    const verdict = describeFederationVerify(peers);
    log(renderFederationVerifyVerdict(verdict));
    result = {
      exitCode: verdict.exitCode,
      verdict,
      peers,
      skippedRevoked,
      memId,
      cleanedUp: false,
      pushed,
      tag: opts.tag,
    };
    return result;
  } finally {
    try {
      await deps.api("DELETE", `/Memory/${encodeURIComponent(memId)}`, undefined, apiOpts);
      cleanedUp = true;
      log(`4. Cleanup: deleted local memory ${memId}`);
    } catch {
      log(`4. Cleanup: could NOT delete local memory ${memId} (manual cleanup needed)`);
    }
    result.cleanedUp = cleanedUp;
  }
}
