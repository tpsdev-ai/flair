/**
 * replicated-nodes.ts — two-node Harper harness for flair#2208.
 *
 * flair#2194 made the MCP signing key default to the one @harperfast/oauth
 * generates on first mint and persists in its `harper_oauth_mcp_keys` table.
 * The open question (flair#2208) is whether that table is shared across
 * REPLICATED Harper nodes — a token minted on node A verifying on node B — and
 * how long convergence takes.
 *
 * There is no other two-node replication harness in the tree: the flair#878
 * "convergence" test (test/integration/deploy-replication-convergence.test.ts)
 * boots HTTP StUBS, not two Harpers, and every other integration test that
 * calls `startHarper` runs a single node. This is therefore the smallest
 * harness that boots TWO real, ephemeral, isolated Harpers and configures a
 * replication route between them.
 *
 * ── Scope and honesty ─────────────────────────────────────────────────────
 * Multi-node replication is a Harper PRO feature (node_modules/harper/README.md:
 * "Harper Pro ... extends the core with enterprise features including
 * multi-node replication"). The open-source `harper` core that flair depends on
 * does not ship the replication transport: `server.replication.replicateOperation`
 * is a stub that rejects with `Replication not implemented.` (dist/server/Server.js),
 * and `replication_routes` is declared but consumed nowhere. `probeReplicationSupport`
 * measures exactly that, on the real build, so a test can GATE explicitly rather
 * than pass silently. On a replication-capable build the same harness boots the
 * pair and the cross-node test measures convergence.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 * Everything is HOME-isolated and ephemeral, via test/helpers/harper-lifecycle:
 * ROOTPATH/HOME are fresh temp dirs, HTTP/ops ports are OS-assigned, and
 * teardown kills only the PIDs `startHarper` started (stopHarper). It never
 * touches production (localhost:9925/9926, ~/.flair). `assertOwnedInstance`
 * re-checks each instance is the loopback temp instance before any HTTP call.
 * Every wait here is bounded by an explicit timeout.
 *
 * Fixtures use neutral names (node-a/node-b, host-a/host-b) — never a real
 * fleet host or agent.
 */
import { mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "./harper-lifecycle.js";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");

/** Every wait in this harness is capped by an explicit timeout. */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_CONVERGENCE_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;

/** Create a temp app dir carrying the shipped config (or a mutated copy) plus
 *  node_modules/dist symlinks, so Harper boots THIS worktree's flair. */
export function makeNodeWorkDir(prefix: string, mutate?: (shipped: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  symlinkSync(join(REPO_ROOT, "dist"), join(dir, "dist"));
  if (mutate) writeFileSync(join(dir, "config.yaml"), mutate(readFileSync(SHIPPED_CONFIG, "utf-8")), "utf-8");
  else copyFileSync(SHIPPED_CONFIG, join(dir, "config.yaml"));
  return dir;
}

/** A `replication:` top-level block that makes `peer` a replication route of
 *  this node and replicates every database (`"*"`). Best-effort for a
 *  replication-capable build; on the OSS core it is accepted by config
 *  validation but no transport is started (see the module header). */
export function replicationRouteConfigYaml(selfHostname: string, peerHostname: string, peerPort: number | string): string {
  return [
    "replication:",
    `  hostname: ${selfHostname}`,
    '  databases: "*"',
    "  routes:",
    `    - hostname: ${peerHostname}`,
    `      port: ${peerPort}`,
  ].join("\n");
}

function basicHeader(h: HarperInstance): string {
  return "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");
}

async function ops(h: HarperInstance, op: Record<string, unknown>, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<{ status: number; body: string }> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicHeader(h) },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
}

export interface ReplicationSupport {
  /** True when the build implements replication (the fan-out op succeeds). */
  supported: boolean;
  /** The exact observed error when unsupported; null when supported. */
  error: string | null;
}

/**
 * Measure, on the real installed Harper build, whether replication is
 * implemented. Boots one ephemeral node, asks the ops API to apply a config
 * change WITH replication fan-out (`set_configuration` + `replicated: true`,
 * which routes through `server.replication.replicateOperation`), and reads the
 * result. Self-contained: the node and its temp dir are always torn down.
 *
 * A non-"not implemented" failure is reported as `supported: false` with the
 * exact error rather than assumed — an unverified capability must never read as
 * "available".
 */
export async function probeReplicationSupport(opts: { timeoutMs?: number } = {}): Promise<ReplicationSupport> {
  const workDir = makeNodeWorkDir("flair-test-2208-probe-");
  let inst: HarperInstance | undefined;
  try {
    inst = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
    const res = await ops(inst, { operation: "set_configuration", replicated: true, logging: { level: "info" } }, opts.timeoutMs);
    if (res.status === 200 && !/not implemented/i.test(res.body)) {
      return { supported: true, error: null };
    }
    const error = `set_configuration(replicated:true) → HTTP ${res.status} ${res.body.slice(0, 200)}`;
    return { supported: false, error };
  } catch (err) {
    return { supported: false, error: `replication capability probe failed: ${(err as Error)?.message ?? String(err)}` };
  } finally {
    if (inst) { try { await stopHarper(inst); } catch { /* best effort */ } }
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export interface ReplicatedPair {
  a: HarperInstance;
  b: HarperInstance;
  /** Stop both nodes and remove both temp dirs. Kills only these PIDs. */
  stop(): Promise<void>;
}

/**
 * Boot two ephemeral Harpers and make node B a replication peer of node A.
 *
 * Node A boots first (plain), then node B boots with a `replication:` block
 * whose route points at A's ops port. Both carry this worktree's flair and
 * inherit the caller's FLAIR_MCP_* environment (so both can run MCP on with no
 * pinned key). Callers MUST call `stop()`.
 */
export async function startReplicatedPair(opts: { mutateConfig?: (shipped: string) => string } = {}): Promise<ReplicatedPair> {
  const workDirA = makeNodeWorkDir("flair-test-2208-a-", opts.mutateConfig);
  const workDirB = makeNodeWorkDir("flair-test-2208-b-", opts.mutateConfig);
  const a = await startHarper({ cwd: workDirA, harperBinDir: REPO_ROOT });
  let b: HarperInstance | undefined;
  try {
    const aPeerPort = new URL(a.opsURL).port;
    b = await startHarper({
      cwd: workDirB,
      harperBinDir: REPO_ROOT,
      appendRootConfigYaml: replicationRouteConfigYaml("node-b", "node-a", aPeerPort),
    });
  } catch (err) {
    try { await stopHarper(a); } catch { /* best effort */ }
    try { rmSync(workDirA, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(workDirB, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
  const stop = async () => {
    try { await stopHarper(b!); } catch { /* best effort */ }
    try { await stopHarper(a); } catch { /* best effort */ }
    try { rmSync(workDirA, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(workDirB, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { a, b, stop };
}

/**
 * Fail closed unless `inst` is a loopback, ephemeral, temp-dir instance — never
 * production (localhost:9925/9926, ~/.flair). Call before the first HTTP call.
 */
export function assertOwnedInstance(inst: HarperInstance, label: string): void {
  const url = new URL(inst.httpURL);
  const opsUrl = new URL(inst.opsURL);
  for (const [what, u] of [["http", url], ["ops", opsUrl]] as const) {
    if (u.hostname !== "127.0.0.1") throw new Error(`${label}: ${what} host ${u.hostname} is not loopback — refusing to call a non-test instance`);
    if (u.port === "9925" || u.port === "9926") throw new Error(`${label}: ${what} port ${u.port} is the production default — refusing to call it`);
  }
  if (inst.external) throw new Error(`${label}: external instance passed to a local two-node test`);
  if (!inst.installDir.startsWith(join(tmpdir(), "flair-test-"))) throw new Error(`${label}: installDir ${inst.installDir} is not an ephemeral test tree`);
}

/**
 * Poll `predicate` every `intervalMs` until it returns true or `timeoutMs`
 * elapses (hard upper bound, independent of the predicate). Throws a named
 * error on timeout. Returns the elapsed milliseconds on success.
 */
export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; intervalMs?: number; what: string },
): Promise<number> {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const start = Date.now();
  const deadline = start + opts.timeoutMs;
  for (;;) {
    if (await predicate()) return Date.now() - start;
    if (Date.now() >= deadline) throw new Error(`${opts.what} did not become true within ${opts.timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
