/**
 * replication-convergence.ts — flair#878
 *
 * Harper Fabric's component replication to peers converges ASYNCHRONOUSLY. A
 * peer-replication error raised by `harper deploy` is therefore a snapshot of
 * one instant, not a terminal verdict: the origin has the component, one peer
 * did not have it *at the moment the deploy call returned*, and Harper keeps
 * healing after the CLI has stopped watching.
 *
 * The incident this module closes (flair#878): a two-node cluster upgrade
 * reported
 *
 *     Component 'flair' was deployed on the origin node but failed to
 *     replicate to 1 of 1 peer node(s): <peer> (Error: Connection closed 1006)
 *
 * and the CLI treated it as failure. Afterwards both nodes carried
 * byte-identical component files and all data was intact — the upgrade had
 * succeeded. Worse, the CLI's retry re-ran the full deploy while Harper was
 * still healing, and *that* attempt died with an npm `ENOTEMPTY` on a native
 * module, turning a transient warning into a hard, misleading failure.
 *
 * ── The signal this module uses ─────────────────────────────────────────────
 * `cluster_status` — the operation that would answer "are my cluster peers in
 * sync" — is harper-pro-only and unavailable in the OSS build this CLI ships
 * (see src/fleet-verify.ts's header for the same constraint). What IS
 * available in the OSS build is `get_components`, an `admin_read` operation
 * that walks the components root and returns, per file, `{ name, size, mtime }`
 * (directories recurse through `entries`; `node_modules` is excluded
 * server-side). Addressing it at each node's OWN hostname yields a per-node
 * fingerprint of the deployed component tree, and comparing peer-to-origin
 * answers exactly the question the deploy error left open.
 *
 * `mtime` is the load-bearing half of that fingerprint, not decoration: a peer
 * still holding the PREVIOUS version can easily match on size (a same-length
 * version string, an unchanged asset) but cannot match on the extraction
 * timestamp the origin just stamped. Size alone would be a much weaker check.
 *
 * ── Why a node-identity guard exists (the false-success this would otherwise
 *    have) ────────────────────────────────────────────────────────────────────
 * A Fabric cluster endpoint is GTM-steered: `https://<cluster>.<org>.
 * harperfabric.com` resolves to ONE of the member nodes, and which one is not
 * guaranteed stable between the deploy call and this poll. If the cluster
 * endpoint happened to steer to the very peer that failed, a naive
 * origin-vs-peer comparison would be comparing a node against ITSELF and would
 * report `converged` for a cluster that never converged — precisely the
 * failure mode that is worse than the bug being fixed, because it turns a
 * false alarm into a false all-clear.
 *
 * The guard is a DNS resolution of both hostnames: the peer is only compared
 * against the deploy target when the two resolve to disjoint address sets.
 * Overlapping (or unresolvable) addresses yield `unknown`, never `converged`.
 * This is the reporter's own observation encoded as a check rather than as
 * prose a future reader has to remember — the two nodes "resolve to different
 * IPs" is the property that makes the comparison meaningful at all.
 *
 * ── The invariant every caller may rely on ──────────────────────────────────
 * `converged: true` is returned ONLY when every named peer was positively
 * observed, over a distinct network identity, to hold a component tree
 * identical to the origin's. Every other outcome — unparseable error, node
 * name that is not an addressable host, DNS failure, shared address, HTTP
 * failure, absent component, differing files — is `converged: false`. There is
 * no path that infers convergence from the absence of evidence.
 */

import { lookup } from "node:dns/promises";

// ─── Tunables ────────────────────────────────────────────────────────────────

/**
 * How long to wait for asynchronous peer replication to converge before giving
 * up on confirming it. Generous on purpose: the whole point is that Harper is
 * still working after the deploy call returned, and the cost of waiting is a
 * slower failure report, while the cost of NOT waiting is the flair#878
 * false-failure plus a destructive retry.
 */
export const DEFAULT_CONVERGENCE_TIMEOUT_MS = 180_000;
/** How often to re-fingerprint every node while waiting. */
export const CONVERGENCE_POLL_INTERVAL_MS = 10_000;

/**
 * Quiescence (see awaitOriginQuiescent): how many consecutive identical
 * fingerprints of the ORIGIN's component tree count as "nothing is writing to
 * it any more". Two is the minimum that can distinguish "stable" from "read
 * once"; the interval between them is what gives it meaning.
 */
export const QUIESCENT_STABLE_READS = 2;
export const DEFAULT_QUIESCENT_TIMEOUT_MS = 120_000;
export const QUIESCENT_POLL_INTERVAL_MS = 5_000;

// ─── Parsing harper's replication error ─────────────────────────────────────

export interface ReplicationFailurePeer {
  /** The node name harper reported. May not be an addressable host — see resolvePeerUrl. */
  node: string;
  /** The per-peer error harper reported, e.g. "Error: Connection closed 1006". */
  error: string;
}

export interface ParsedReplicationFailure {
  peers: ReplicationFailurePeer[];
  failedCount: number | null;
  totalCount: number | null;
  /** The deployment id harper points at for `get_deployment`, when present. */
  deploymentId: string | null;
}

/**
 * Harper builds the message as (components/operations.js):
 *
 *   `Component '<name>' was deployed on the origin node but failed to
 *    replicate to <failed> of <total> peer node(s): <node> (<error>)[, ...].
 *    See deployment <id> (get_deployment) for details, or pass
 *    ignore_replication_errors: true ...`
 *
 * Both counts and the deployment-id tail are optional here — the aim is to
 * recover the peer NAMES, since those are the only handle the CLI has on the
 * cluster's actual topology (`cluster_status` being unavailable). Anything
 * unrecognised yields an empty peer list, which callers must treat as "cannot
 * check", never as "nothing failed".
 *
 * Literal regexes only (no interpolation) — satisfies semgrep
 * detect-non-literal-regexp.
 */
const REPLICATION_DETAIL_RE =
  /failed to replicate to (\d+)(?: of (\d+))? peer node\(s\):\s*([\s\S]*?)(?:\.\s*See deployment\s+(\S+?)\s*\(get_deployment\)|\.\s*$|$)/i;
/** One `name (error)` entry out of the comma-separated detail list. */
const PEER_ENTRY_RE = /([^,()]+?)\s*\(([^)]*)\)/g;

export function parseReplicationFailure(output: string): ParsedReplicationFailure {
  const empty: ParsedReplicationFailure = {
    peers: [],
    failedCount: null,
    totalCount: null,
    deploymentId: null,
  };
  if (!output) return empty;
  const m = REPLICATION_DETAIL_RE.exec(output);
  if (!m) return empty;

  const failedCount = Number.isFinite(Number(m[1])) ? Number(m[1]) : null;
  const totalCount = m[2] != null && Number.isFinite(Number(m[2])) ? Number(m[2]) : null;
  const deploymentId = m[4] ?? null;

  const peers: ReplicationFailurePeer[] = [];
  const detail = (m[3] ?? "").split("\n")[0];
  for (const entry of detail.matchAll(PEER_ENTRY_RE)) {
    const node = entry[1].trim();
    if (!node) continue;
    peers.push({ node, error: entry[2].trim() });
  }
  return { peers, failedCount, totalCount, deploymentId };
}

// ─── Component fingerprinting ───────────────────────────────────────────────

export interface ComponentEntry {
  name?: unknown;
  size?: unknown;
  mtime?: unknown;
  entries?: unknown;
}

/**
 * Harper serialises `mtime` as a Date, which crosses JSON as an ISO string.
 * Normalising through Date makes the comparison immune to a peer reporting a
 * different-but-equivalent encoding; an unparseable value is compared verbatim
 * rather than silently dropped (dropping it would weaken the check).
 */
function normalizeMtime(value: unknown): string {
  if (value == null) return "-";
  const asDate = new Date(value as string);
  const ms = asDate.getTime();
  return Number.isNaN(ms) ? `raw:${String(value)}` : asDate.toISOString();
}

function collectFiles(entry: ComponentEntry, prefix: string, out: string[]): void {
  if (!entry || typeof entry.name !== "string") return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (Array.isArray(entry.entries)) {
    for (const child of entry.entries) collectFiles(child as ComponentEntry, path, out);
    return;
  }
  const size = typeof entry.size === "number" ? String(entry.size) : "?";
  out.push(`${path} ${size} ${normalizeMtime(entry.mtime)}`);
}

/**
 * Reduce a `get_components` response to a stable, comparable fingerprint of ONE
 * component's file tree.
 *
 * Returns null when the response doesn't contain that component, or contains it
 * with no files at all. Null is deliberately NOT a fingerprint: two nodes that
 * both lack the component would otherwise "match" and be reported converged.
 */
export function fingerprintComponent(body: unknown, project: string): string | null {
  const roots = (body as { entries?: unknown })?.entries;
  if (!Array.isArray(roots)) return null;
  const component = roots.find(
    (e) => e && typeof e === "object" && (e as ComponentEntry).name === project,
  ) as ComponentEntry | undefined;
  if (!component) return null;
  const children = Array.isArray(component.entries) ? component.entries : [];
  const lines: string[] = [];
  for (const child of children) collectFiles(child as ComponentEntry, "", lines);
  if (lines.length === 0) return null;
  lines.sort();
  return lines.join("\n");
}

/** How many file entries differ between two fingerprints (for operator-facing detail). */
export function fingerprintDiffCount(a: string, b: string): number {
  const left = new Set(a.split("\n"));
  const right = new Set(b.split("\n"));
  let diff = 0;
  for (const line of left) if (!right.has(line)) diff++;
  for (const line of right) if (!left.has(line)) diff++;
  return diff;
}

// ─── Addressing a node ──────────────────────────────────────────────────────

/**
 * A Harper node name is a hostname (server/nodeName.ts derives it from
 * `node.hostname`, the replication URL, or the TLS certificate CN), so it can
 * normally be addressed directly with the deploy target's scheme and port.
 *
 * But harper's error detail is FREE TEXT — the per-peer entry falls back to the
 * literal `'unknown'`, and a malformed cluster can put an arbitrary message
 * there. Anything that isn't a plain `host[:port]` is rejected rather than
 * guessed at: an unaddressable node yields "cannot check", which is safe, while
 * a guessed address could reach the wrong machine, which is not.
 */
const HOSTPORT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

export function resolvePeerUrl(node: string, referenceUrl: string): string | null {
  const trimmed = (node ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).origin;
    } catch {
      return null;
    }
  }

  if (!HOSTPORT_RE.test(trimmed)) return null;

  let reference: URL;
  try {
    reference = new URL(referenceUrl);
  } catch {
    return null;
  }
  const lastColon = trimmed.lastIndexOf(":");
  const host = lastColon > 0 ? trimmed.slice(0, lastColon) : trimmed;
  const port = lastColon > 0 ? trimmed.slice(lastColon + 1) : "";
  const url = new URL(reference.origin);
  url.hostname = host;
  if (port) url.port = port;
  // Setting an invalid hostname on a URL is a silent no-op in WHATWG URL, which
  // would leave us pointed at the ORIGIN while believing we addressed the peer.
  if (url.hostname !== host.toLowerCase()) return null;
  return url.origin;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ─── Injectable seams ───────────────────────────────────────────────────────

export interface ConvergenceDeps {
  /** POST `{operation: "get_components"}` at a node's base URL. */
  getComponents: (baseUrl: string) => Promise<unknown>;
  /** Resolve every A/AAAA address for a hostname. */
  resolveHostAddresses: (hostname: string) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onProgress?: (msg: string) => void;
}

/**
 * Real `get_components` caller. Fabric serves the operations API on the same
 * origin the deploy targets, with the same admin Basic auth the deploy used.
 *
 * NEVER logs or returns the credential, and never folds a response BODY into a
 * thrown error — only the status code. An operations-API error body can echo
 * request context, and this runs with cluster-admin credentials.
 */
export function buildOpsGetComponents(
  fabricUser?: string,
  fabricPassword?: string,
  timeoutMs = 15_000,
): (baseUrl: string) => Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (fabricUser && fabricPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${fabricUser}:${fabricPassword}`).toString("base64")}`;
  }
  return async (baseUrl: string) => {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/", {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "get_components" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`get_components returned HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };
}

async function defaultResolveHostAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

export function defaultConvergenceDeps(
  fabricUser?: string,
  fabricPassword?: string,
  onProgress?: (msg: string) => void,
): ConvergenceDeps {
  return {
    getComponents: buildOpsGetComponents(fabricUser, fabricPassword),
    resolveHostAddresses: defaultResolveHostAddresses,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    onProgress,
  };
}

// ─── Convergence ────────────────────────────────────────────────────────────

export type PeerConvergenceState = "converged" | "diverged" | "unknown";

export interface PeerConvergenceResult {
  node: string;
  url: string | null;
  state: PeerConvergenceState;
  /** Always populated — an operator has to be able to act on a non-converged row. */
  detail: string;
}

export interface ConvergenceResult {
  /** TRUE ONLY on positive, identity-guarded observation of every named peer. */
  converged: boolean;
  /**
   * Whether every peer reached a definite verdict. `conclusive: false` means
   * the CLI could not look, NOT that the cluster is fine — the two must never
   * be conflated, which is why they are separate fields.
   */
  conclusive: boolean;
  peers: PeerConvergenceResult[];
  elapsedMs: number;
  /** One-line summary suitable for an error message or a progress log. */
  detail: string;
}

export interface AwaitConvergenceOptions {
  targetUrl: string;
  project: string;
  peers: ReplicationFailurePeer[];
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function summarize(peers: PeerConvergenceResult[], converged: boolean, conclusive: boolean): string {
  if (peers.length === 0) {
    return "harper's replication error named no peer nodes — convergence could not be checked";
  }
  if (converged) {
    const names = peers.map((p) => p.node).join(", ");
    return `all ${peers.length} peer node(s) hold the same component tree as the origin (${names})`;
  }
  const parts = peers.map((p) => `${p.node}: ${p.state} — ${p.detail}`);
  return conclusive
    ? `peer replication did NOT converge — ${parts.join("; ")}`
    : `convergence could NOT be determined — ${parts.join("; ")}`;
}

/**
 * Poll every named peer until its component tree matches the origin's, or the
 * deadline passes.
 *
 * Never throws for cluster-side reasons: a peer that cannot be reached, named,
 * or resolved is reported as `unknown` and the caller decides. The only
 * unhandled throw would be a bug in an injected dep.
 */
export async function awaitReplicationConvergence(
  opts: AwaitConvergenceOptions,
  deps: ConvergenceDeps,
): Promise<ConvergenceResult> {
  const started = deps.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONVERGENCE_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? CONVERGENCE_POLL_INTERVAL_MS;
  const deadline = started + timeoutMs;

  const results: PeerConvergenceResult[] = opts.peers.map((p) => {
    const url = resolvePeerUrl(p.node, opts.targetUrl);
    return {
      node: p.node,
      url,
      state: "unknown" as PeerConvergenceState,
      detail: url
        ? "not checked yet"
        : `harper reported "${p.node}", which is not an addressable host — this CLI will not guess an address for it, so convergence cannot be checked from here`,
    };
  });

  const finish = (): ConvergenceResult => {
    const converged = results.length > 0 && results.every((r) => r.state === "converged");
    const conclusive = results.length > 0 && results.every((r) => r.state !== "unknown");
    return {
      converged,
      conclusive,
      peers: results,
      elapsedMs: deps.now() - started,
      detail: summarize(results, converged, conclusive),
    };
  };

  const addressable = results.filter((r) => r.url !== null);
  if (addressable.length === 0) return finish();

  const targetHost = hostnameOf(opts.targetUrl);
  let targetAddresses: string[] = [];
  if (targetHost) {
    try {
      targetAddresses = await deps.resolveHostAddresses(targetHost);
    } catch {
      targetAddresses = [];
    }
  }

  for (;;) {
    let originFingerprint: string | null = null;
    let originError: string | null = null;
    try {
      originFingerprint = fingerprintComponent(await deps.getComponents(opts.targetUrl), opts.project);
      if (!originFingerprint) {
        originError = `the deploy target did not report a '${opts.project}' component tree to compare peers against`;
      }
    } catch (err: any) {
      originError = `could not read the deploy target's component tree: ${err?.message ?? String(err)}`;
    }

    for (const peer of results) {
      if (peer.state === "converged" || peer.url === null) continue;

      if (!originFingerprint) {
        peer.state = "unknown";
        peer.detail = originError ?? "no origin fingerprint to compare against";
        continue;
      }

      const peerHost = hostnameOf(peer.url);
      let peerAddresses: string[] = [];
      if (peerHost) {
        try {
          peerAddresses = await deps.resolveHostAddresses(peerHost);
        } catch {
          peerAddresses = [];
        }
      }

      if (peerAddresses.length === 0) {
        peer.state = "unknown";
        peer.detail = `${peerHost ?? peer.url} did not resolve — cannot reach this node to check whether it converged`;
        continue;
      }
      if (targetAddresses.length === 0) {
        peer.state = "unknown";
        peer.detail =
          `the deploy target's own hostname did not resolve, so this peer cannot be proven to be a different ` +
          `node from it — refusing to compare a node against itself`;
        continue;
      }
      if (peerAddresses.some((a) => targetAddresses.includes(a))) {
        peer.state = "unknown";
        peer.detail =
          `${peerHost} currently resolves to the same address as the deploy target — a Fabric cluster endpoint ` +
          `is steered to one member node, so this comparison would be the peer against itself. Refusing to ` +
          `report convergence from it`;
        continue;
      }

      let peerFingerprint: string | null = null;
      try {
        peerFingerprint = fingerprintComponent(await deps.getComponents(peer.url), opts.project);
      } catch (err: any) {
        peer.state = "unknown";
        peer.detail = `could not read this node's component tree: ${err?.message ?? String(err)}`;
        continue;
      }

      if (!peerFingerprint) {
        peer.state = "diverged";
        peer.detail = `this node reports no '${opts.project}' component at all`;
        continue;
      }
      if (peerFingerprint === originFingerprint) {
        peer.state = "converged";
        peer.detail = "component files match the origin byte-for-byte (name, size and mtime)";
        continue;
      }
      peer.state = "diverged";
      peer.detail = `${fingerprintDiffCount(originFingerprint, peerFingerprint)} component file entr(ies) differ from the origin`;
    }

    if (results.every((r) => r.state === "converged")) break;
    if (deps.now() >= deadline) break;
    deps.onProgress?.(
      `waiting for peer replication to converge (${results.filter((r) => r.state === "converged").length}/${results.length} peer(s) match the origin so far)...`,
    );
    await deps.sleep(pollIntervalMs);
  }

  return finish();
}

// ─── Quiescence (clean-first retry precondition) ────────────────────────────

export interface QuiescenceResult {
  /** True iff the origin's component tree was read identically on consecutive polls. */
  quiescent: boolean;
  detail: string;
  elapsedMs: number;
}

/**
 * Wait until the ORIGIN's component tree stops changing.
 *
 * This is the retry's clean-first precondition. Retrying on a fixed 5s/10s
 * backoff re-issues a full deploy while the previous attempt's SERVER-SIDE work
 * — tarball extraction and `npm install` into `<components-root>/<project>` —
 * may still be running, and two writers in one component directory is the
 * best available explanation for the reported
 * `ENOTEMPTY: directory not empty, rmdir '.../node_modules/<pkg>/dist'`, the
 * error that took that upgrade from "transient warning" to "failed".
 *
 * Stated honestly: the CLI cannot observe WHY the remote install failed — that
 * happened inside Harper on another host. What it can do is remove the overlap,
 * which is a necessary condition for any concurrent-writer explanation and
 * costs nothing when the explanation is something else.
 *
 * What the CLI CANNOT do is make Harper's remote install clean-first directly.
 * Harper consults a component's `install_command` only when `node_modules` is
 * ABSENT — `components/Application.ts` returns early ("already has
 * node_modules; skipping install") before the custom command is ever read — so
 * it cannot be used to clear an existing tree, and `deploy_component` exposes no
 * clean/force-reinstall option. Not starting attempt N+1 on top of attempt N is
 * therefore the only clean-first guarantee available from this side.
 *
 * Returns `quiescent: false` when it could not establish stability. Callers
 * must treat that as "do not retry", never as "safe to retry".
 */
export async function awaitOriginQuiescent(
  opts: {
    targetUrl: string;
    project: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    stableReads?: number;
  },
  deps: ConvergenceDeps,
): Promise<QuiescenceResult> {
  const started = deps.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUIESCENT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? QUIESCENT_POLL_INTERVAL_MS;
  const stableReads = opts.stableReads ?? QUIESCENT_STABLE_READS;
  const deadline = started + timeoutMs;

  let previous: string | null = null;
  let streak = 0;
  let lastError: string | null = null;

  for (;;) {
    let fingerprint: string | null = null;
    try {
      fingerprint = fingerprintComponent(await deps.getComponents(opts.targetUrl), opts.project);
      if (!fingerprint) lastError = `the deploy target reports no '${opts.project}' component tree`;
    } catch (err: any) {
      lastError = err?.message ?? String(err);
    }

    if (fingerprint) {
      if (previous !== null && fingerprint === previous) {
        streak++;
      } else {
        streak = 1;
      }
      previous = fingerprint;
      lastError = null;
      if (streak >= stableReads) {
        return {
          quiescent: true,
          detail: `origin component tree unchanged across ${streak} consecutive reads`,
          elapsedMs: deps.now() - started,
        };
      }
    } else {
      streak = 0;
      previous = null;
    }

    if (deps.now() >= deadline) {
      return {
        quiescent: false,
        detail:
          `origin component tree did not settle within ${timeoutMs}ms` +
          (lastError ? ` (last read: ${lastError})` : " — it is still being written to"),
        elapsedMs: deps.now() - started,
      };
    }
    deps.onProgress?.("waiting for the origin's component tree to settle before retrying...");
    await deps.sleep(pollIntervalMs);
  }
}
