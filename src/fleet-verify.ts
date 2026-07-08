/**
 * fleet-verify.ts — `flair fleet verify` (flair#636)
 *
 * Fabric deploys tolerate replication errors by design (origin-first, see
 * src/deploy.ts's REPLICATION_FAILURE_RE / --ignore-replication-errors) —
 * but nothing upstream of this module confirms a replicated node actually
 * converged. Harper's own "Successfully deployed" means "origin took it."
 * This sweeps the origin + every known peer and reports a per-node table
 * instead of a single boolean, reusing src/probe.ts's `probeInstance`
 * verbatim (flair#635/#641 — same shape, Fabric admin Basic auth swapped in
 * for the injected `authedGet`, exactly per that module's own docstring).
 *
 * ── What "peer" means here — read before trusting a green sweep ──────────
 * Harper Fabric's OWN cluster-replication peers (the physical nodes a
 * component gets replicated to by `harper deploy`) are NOT enumerable
 * through any operation in the OSS @harperfast/harper build this repo
 * depends on. `cluster_status` — the operation that would answer "what
 * nodes are in this cluster and are they in sync" — is explicitly called
 * out as harper-pro-only in Harper's own source (node_modules/@harperfast/
 * harper/components/mcp/tools/schemas/operationDescriptions.ts: "Out-of-core
 * operations (e.g. harper-pro's cluster_status) cannot have entries here").
 * There is no "list this cluster's replication nodes" call available to this
 * CLI, on the origin or anywhere else — direct AND via-origin cluster
 * topology discovery are both unavailable in this Harper tier.
 *
 * The only node registry this module CAN reach is Flair's OWN federation
 * peer table (resources/Federation.ts's Peer records, via GET
 * /FederationPeers) — a distinct, higher-level concept (cross-instance
 * memory-sync pairing, hub-and-spoke) that happens to double as a fleet
 * registry ONLY where an operator has ALSO paired each Fabric replica as a
 * federation peer of the origin. A replica that was never paired is
 * invisible to this sweep — `0 peers known` means "0 peers ON FILE", never
 * "0 peers exist." renderFleetSweepTable() prints this caveat inline
 * whenever the peer list comes back empty, so it can't be missed by reading
 * a green summary line.
 *
 * Every peer that DOES carry a direct `endpoint` gets a REAL probe (health +
 * authenticated version check, same Fabric admin Basic-auth credentials as
 * the origin — a Fabric cluster shares one admin realm). A peer with no
 * usable endpoint is reported "unverifiable" — never silently dropped, never
 * printed green. See classifyNode()'s "method" field: "direct" (we actually
 * hit it) vs "none" (we could not attempt a check at all, and say why).
 */

import { probeInstance, type ProbeResult, type ProbeInstanceOptions } from "./probe.js";
import * as render from "./render.js";

// ─── Result shape ────────────────────────────────────────────────────────────

export type FleetNodeRole = "origin" | "peer";

/** "direct" = we actually made an HTTP request to this node. "none" = we had no usable way to reach it at all. */
export type FleetCheckMethod = "direct" | "none";

export type FleetNodeStatus =
  | "ok"            // healthy, authenticated, version matches (or no baseline to compare against)
  | "unreachable"   // /Health never answered within the timeout
  | "auth-failed"   // healthy, but the authenticated check was rejected
  | "skew"          // healthy + authenticated, but running a different version than expected
  | "unverifiable"; // no way to check this node at all (no endpoint, bad URL, or peer enumeration itself failed)

export interface FleetNodeResult {
  id: string;
  role: FleetNodeRole;
  url: string | null;
  method: FleetCheckMethod;
  healthy: boolean | null;
  authenticated: boolean | null;
  version: string | null;
  versionMatch: boolean | null;
  status: FleetNodeStatus;
  /** Always present — human-readable reason, especially load-bearing when !ok. */
  detail: string;
}

// ─── Exit codes (documented in `flair fleet verify --help`) ─────────────────

/** All nodes verified: healthy, authenticated, and version-matched. */
export const FLEET_EXIT_OK = 0;
/** Origin failed — unreachable, unauthenticated, or running the wrong version. Worst case: the cluster's entrypoint itself is broken. */
export const FLEET_EXIT_ORIGIN_FAILED = 1;
/** Origin is fine, but at least one reachable peer is running a DIFFERENT version — a mixed-version fleet (the #638 scenario). */
export const FLEET_EXIT_PEER_SKEW = 2;
/** Origin is fine, no version skew among reachable peers, but at least one peer could not be verified at all (unreachable, auth rejected, or no endpoint on file). */
export const FLEET_EXIT_PEER_UNREACHABLE = 3;

export const FLEET_EXIT_DESCRIPTIONS: Record<number, string> = {
  [FLEET_EXIT_OK]: "all nodes verified: healthy, authenticated, version-matched",
  [FLEET_EXIT_ORIGIN_FAILED]: "origin failed (unreachable, unauthenticated, or wrong version)",
  [FLEET_EXIT_PEER_SKEW]: "origin OK, but a reachable peer is running a DIFFERENT version (skew)",
  [FLEET_EXIT_PEER_UNREACHABLE]: "origin OK, no skew among reachable peers, but a peer could not be verified at all (unreachable, auth rejected, or no endpoint on file)",
};

/**
 * Priority order when multiple problems exist at once: an origin failure
 * always wins (nothing downstream matters if the entrypoint is broken), then
 * skew (a real mixed-version fleet), then unreachable/unverifiable (we
 * genuinely don't know that node's state).
 */
export function decideFleetExitCode(origin: FleetNodeResult, peers: FleetNodeResult[]): number {
  if (origin.status !== "ok") return FLEET_EXIT_ORIGIN_FAILED;
  if (peers.some((p) => p.status === "skew")) return FLEET_EXIT_PEER_SKEW;
  if (peers.some((p) => p.status !== "ok")) return FLEET_EXIT_PEER_UNREACHABLE;
  return FLEET_EXIT_OK;
}

// ─── Pure decision logic: ProbeResult → FleetNodeResult ─────────────────────

/**
 * Turn a probe attempt (or the absence of one) into a table row. Pure —
 * no I/O. `expectVersion` is the baseline this node should be running;
 * pass null when there is nothing to compare against (skew can't be
 * evaluated, but health/auth still can).
 */
export function classifyNode(
  role: FleetNodeRole,
  id: string,
  url: string | null,
  method: FleetCheckMethod,
  probe: ProbeResult | null,
  expectVersion: string | null,
  unverifiableReason?: string,
): FleetNodeResult {
  if (method === "none" || probe === null) {
    return {
      id, role, url, method: "none",
      healthy: null, authenticated: null, version: null, versionMatch: null,
      status: "unverifiable",
      detail: unverifiableReason ?? "no way to verify this node",
    };
  }

  if (!probe.healthy) {
    return {
      id, role, url, method,
      healthy: false, authenticated: null, version: null, versionMatch: null,
      status: "unreachable",
      detail: probe.error ?? `${url ?? id} did not answer /Health`,
    };
  }

  if (probe.authenticated === false) {
    return {
      id, role, url, method,
      healthy: true, authenticated: false, version: null, versionMatch: null,
      status: "auth-failed",
      detail: probe.error ?? "authenticated request rejected",
    };
  }

  if (expectVersion !== null && probe.versionMatch === false) {
    return {
      id, role, url, method,
      healthy: true, authenticated: probe.authenticated, version: probe.version, versionMatch: false,
      status: "skew",
      detail: probe.error ?? `version mismatch: expected ${expectVersion}, reports ${probe.version ?? "unknown"}`,
    };
  }

  return {
    id, role, url, method,
    healthy: true, authenticated: probe.authenticated, version: probe.version, versionMatch: probe.versionMatch,
    status: "ok",
    detail: probe.version ? `healthy, running ${probe.version}` : "healthy",
  };
}

// ─── Peer endpoint validation ────────────────────────────────────────────────

/**
 * A federation Peer record may have no `endpoint` at all (tunnel-paired —
 * see src/cli.ts's existing `flair federation ping` handling of the same
 * shape) or an endpoint that isn't a plain http(s) URL. Reject non-http(s)
 * schemes rather than attempting to fetch them (same protocol allowlist as
 * the existing federation-ping probe — Sherlock review on #314).
 */
export function validatePeerEndpoint(endpoint: string | null | undefined): { url: string } | { error: string } {
  if (!endpoint) {
    return { error: "no endpoint on file (never federation-paired with a direct endpoint, or tunnel-paired)" };
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { error: `invalid endpoint URL on file: ${endpoint}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `unsupported endpoint protocol on file: ${parsed.protocol}` };
  }
  return { url: endpoint };
}

// ─── Fabric admin Basic-auth authedGet (injected into probeInstance) ────────

/**
 * Builds the authedGet probeInstance needs, using Fabric admin Basic auth —
 * the exact credential shape src/deploy.ts and src/fabric-upgrade.ts already
 * use for the whole cluster (FABRIC_USER/FABRIC_PASSWORD). Assumes a single
 * Fabric cluster shares one admin realm across its nodes; a peer that
 * rejects these credentials (a genuinely separate Harper instance with its
 * own admin) surfaces as "auth-failed" — itself a real, informative finding,
 * not a bug in this probe.
 *
 * NEVER logs the credential — only the Authorization header carries it, and
 * probeInstance/callers only ever see/report the HTTP outcome.
 */
export function buildFabricAuthedGet(
  baseUrl: string,
  fabricUser: string,
  fabricPassword: string,
): (path: string) => Promise<any> {
  const base = baseUrl.replace(/\/+$/, "");
  const auth = Buffer.from(`${fabricUser}:${fabricPassword}`).toString("base64");
  return async (path: string) => {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    return text ? JSON.parse(text) : {};
  };
}

// ─── Peer enumeration ────────────────────────────────────────────────────────

export interface FleetPeerRecord {
  id: string;
  role?: string;
  status?: string;
  endpoint?: string | null;
}

async function defaultFetchPeers(authedGet: (path: string) => Promise<any>): Promise<FleetPeerRecord[]> {
  const body = await authedGet("/FederationPeers");
  return Array.isArray(body?.peers) ? body.peers : [];
}

// ─── Injectable seams (tests mock these — no real network/probing) ─────────

export interface FleetVerifyDeps {
  probe: (baseUrl: string, opts: ProbeInstanceOptions) => Promise<ProbeResult>;
  fetchPeers: (authedGet: (path: string) => Promise<any>) => Promise<FleetPeerRecord[]>;
  buildAuthedGet: (baseUrl: string, fabricUser: string, fabricPassword: string) => (path: string) => Promise<any>;
  log?: (msg: string) => void;
}

function defaultDeps(): FleetVerifyDeps {
  return {
    probe: probeInstance,
    fetchPeers: defaultFetchPeers,
    buildAuthedGet: buildFabricAuthedGet,
  };
}

export interface FleetVerifyOptions {
  target: string;
  fabricUser: string;
  fabricPassword: string;
  /** Version every node must report. Omit to compare peers against the origin's OWN reported version instead (self-consistency check). */
  expectVersion?: string;
  /** Per-node /Health poll timeout (probeInstance default: 60s). */
  timeoutMs?: number;
}

export interface FleetSweepResult {
  target: string;
  /** The version baseline actually used for skew comparisons, or null when there was none available. */
  expectVersion: string | null;
  /** "explicit" = --expect-version was given. "origin" = derived from the origin's own reported version. "none" = no baseline available. */
  expectVersionSource: "explicit" | "origin" | "none";
  origin: FleetNodeResult;
  peers: FleetNodeResult[];
  /** Set when GET /FederationPeers on the origin itself failed — peer coverage is unknown, not necessarily zero. */
  peerEnumerationError: string | null;
  exitCode: number;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export async function sweepFleet(
  opts: FleetVerifyOptions,
  injected?: Partial<FleetVerifyDeps>,
): Promise<FleetSweepResult> {
  const deps: FleetVerifyDeps = { ...defaultDeps(), ...injected };
  const log = deps.log ?? (() => {});

  const originAuthedGet = deps.buildAuthedGet(opts.target, opts.fabricUser, opts.fabricPassword);

  log(`Probing origin ${opts.target} ...`);
  const originProbe = await deps.probe(opts.target, {
    expectVersion: opts.expectVersion,
    timeoutMs: opts.timeoutMs,
    authedGet: originAuthedGet,
  });

  const explicitExpect = opts.expectVersion ?? null;
  const expectVersion = explicitExpect ?? originProbe.version ?? null;
  const expectVersionSource: "explicit" | "origin" | "none" =
    explicitExpect !== null ? "explicit" : expectVersion !== null ? "origin" : "none";

  // Origin is classified against the EXPLICIT expectation only — when none was
  // given, the origin itself defines the baseline and can't be "skewed"
  // relative to its own reading.
  const origin = classifyNode("origin", "origin", opts.target, "direct", originProbe, explicitExpect);

  let peerRecords: FleetPeerRecord[] = [];
  let peerEnumerationError: string | null = null;
  try {
    log("Enumerating federation peers ...");
    peerRecords = await deps.fetchPeers(originAuthedGet);
  } catch (err: any) {
    peerEnumerationError = err?.message ?? String(err);
  }

  // Revoked peers are intentionally decommissioned — reporting them
  // unreachable would be noise, not signal.
  const knownPeers = peerRecords.filter((p) => p.status !== "revoked");

  const peers: FleetNodeResult[] = [];
  for (const p of knownPeers) {
    const check = validatePeerEndpoint(p.endpoint);
    if ("error" in check) {
      peers.push(classifyNode("peer", p.id, p.endpoint ?? null, "none", null, expectVersion, check.error));
      continue;
    }
    log(`Probing peer ${p.id} (${check.url}) ...`);
    const peerAuthedGet = deps.buildAuthedGet(check.url, opts.fabricUser, opts.fabricPassword);
    const peerProbe = await deps.probe(check.url, {
      expectVersion: expectVersion ?? undefined,
      timeoutMs: opts.timeoutMs,
      authedGet: peerAuthedGet,
    });
    peers.push(classifyNode("peer", p.id, check.url, "direct", peerProbe, expectVersion));
  }

  if (peerEnumerationError) {
    // A failure to even LIST peers means fleet coverage is unknown — never
    // let that read as "0 peers, all clear."
    peers.push({
      id: "(peer enumeration)",
      role: "peer",
      url: null,
      method: "none",
      healthy: null, authenticated: null, version: null, versionMatch: null,
      status: "unverifiable",
      detail: `GET /FederationPeers on the origin failed: ${peerEnumerationError} — fleet coverage unknown, cannot confirm every peer was even considered`,
    });
  }

  const exitCode = decideFleetExitCode(origin, peers);

  return { target: opts.target, expectVersion, expectVersionSource, origin, peers, peerEnumerationError, exitCode };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<FleetNodeStatus, string> = {
  ok: render.c.green,
  skew: render.c.red,
  unreachable: render.c.red,
  "auth-failed": render.c.yellow,
  unverifiable: render.c.yellow,
};

/**
 * Per-node table + the caveats an operator needs to trust it. An "ok" row
 * always means a REAL probe answered; anything else names exactly how it's
 * wrong (see FleetNodeResult.detail) instead of a bare pass/fail.
 */
export function renderFleetSweepTable(result: FleetSweepResult): string {
  const rows = [result.origin, ...result.peers];
  const cols: render.TableColumn[] = [
    { label: "node", key: "id" },
    { label: "role", key: "role" },
    { label: "method", key: "method", format: (v) => (v === "direct" ? "direct" : render.wrap(render.c.dim, "none")) },
    {
      label: "status",
      key: "status",
      format: (v) => render.wrap(STATUS_COLOR[v as FleetNodeStatus] ?? render.c.dim, String(v)),
    },
    { label: "version", key: "version", format: (v) => (v ? String(v) : render.wrap(render.c.dim, "—")) },
    { label: "detail", key: "detail" },
  ];

  const lines: string[] = [render.table(cols, rows as unknown as Array<Record<string, unknown>>)];

  if (result.peers.length === 0 || (result.peers.length === 1 && result.peerEnumerationError)) {
    lines.push("");
    lines.push(render.wrap(
      render.c.dim,
      "0 federation peers known to the origin. This does NOT mean the Fabric cluster has no other " +
      "replication nodes — Harper's own cluster peers aren't visible to this tool (cluster_status is a " +
      "harper-pro-only operation, unavailable in the OSS build this CLI ships). It means no other node is " +
      "paired as a Flair federation peer of this origin. If this cluster has replicas, pair them " +
      "(`flair federation pair`) so fleet verify can actually see them.",
    ));
  }

  const expectLine =
    result.expectVersionSource === "explicit"
      ? `compared against --expect-version ${result.expectVersion}`
      : result.expectVersionSource === "origin"
        ? `compared against the origin's own reported version (${result.expectVersion}) — no --expect-version given`
        : "no version baseline available (origin unreachable/unauthenticated and no --expect-version given) — skew could not be checked";
  lines.push("");
  lines.push(render.wrap(render.c.dim, expectLine));

  return lines.join("\n");
}
