/**
 * replicated-nodes.ts — two-node Harper harness for flair#2208.
 *
 * flair#2194 made the MCP signing key default to the one @harperfast/oauth
 * generates on first mint and persists in its `harper_oauth_mcp_keys` table.
 * The open question (flair#2208) is whether that table is shared across
 * REPLICATED Harper nodes — a token minted on node A verifying on node B — and
 * how long convergence takes.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────
 * Multi-node replication is a Harper PRO feature (node_modules/harper/README.md:
 * "Harper Pro ... extends the core with enterprise features including
 * multi-node replication"). The open-source `harper` core that flair depends on
 * does not ship the replication transport: `server.replication.replicateOperation`
 * is a stub that rejects with `Replication not implemented.` (dist/server/Server.js).
 * `probeReplicationSupport` measures that on a real installed build.
 *
 * `startReplicatedPair` therefore boots Harper Pro from
 * `FLAIR_TEST_HARPER_PRO_DIR`: two ephemeral nodes with distinct loopback
 * identities, replication listeners on one OS-allocated port, and an `add_node`
 * handshake. The callers that need the replicated path skip when the variable
 * is absent.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 * Everything is HOME-isolated and ephemeral, via test/helpers/harper-lifecycle:
 * ROOTPATH/HOME are fresh temp dirs, HTTP/ops ports are OS-assigned, and
 * teardown kills only the PIDs `startHarper` started (stopHarper). It never
 * touches production (localhost:9925/9926, ~/.flair). Callers invoke
 * `assertOwnedInstance` to check an instance is the loopback temp instance.
 * HTTP requests have explicit timeouts; polling deadlines are checked between predicate calls.
 *
 * Fixtures use neutral names (node-a/node-b, host-a/host-b) — never a real
 * fleet host or agent.
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "./harper-lifecycle.js";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");

/**
 * Install root of a Harper Pro build, for the two-node test. Harper's
 * open-source core ships no replication transport (see `probeReplicationSupport`),
 * so the replicated path requires Pro. Absent means the caller skips the test.
 */
export const PRO_INSTALL_DIR = process.env.FLAIR_TEST_HARPER_PRO_DIR;

export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_CONVERGENCE_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;

/** Create a temp app dir carrying the shipped config (or a mutated copy) plus
 *  node_modules/dist symlinks, so Harper boots THIS worktree's flair. */
export function makeNodeWorkDir(
  prefix: string,
  mutate?: (shipped: string) => string,
  opts: { realNodeModules?: boolean } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (opts.realNodeModules) {
    // A real directory of per-entry symlinks: a single symlink to the worktree
    // would let an installer write reach the shared checkout.
    mkdirSync(join(dir, "node_modules"));
    for (const name of readdirSync(join(REPO_ROOT, "node_modules"))) {
      symlinkSync(join(REPO_ROOT, "node_modules", name), join(dir, "node_modules", name));
    }
  } else {
    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  }
  symlinkSync(join(REPO_ROOT, "dist"), join(dir, "dist"));
  if (mutate) writeFileSync(join(dir, "config.yaml"), mutate(readFileSync(SHIPPED_CONFIG, "utf-8")), "utf-8");
  else copyFileSync(SHIPPED_CONFIG, join(dir, "config.yaml"));
  return dir;
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
  /** The observed error excerpt when unsupported; null when supported. */
  error: string | null;
}

/**
 * Measure, on the real installed Harper build, whether replication is
 * implemented. Boots one ephemeral node, asks the ops API to apply a config
 * change WITH replication fan-out (`set_configuration` + `replicated: true`,
 * which routes through `server.replication.replicateOperation`), and reads the
 * result. Self-contained: the node and its temp dir are always torn down.
 *
 * Failures return `supported: false` with an observed error excerpt.
 */
export async function probeReplicationSupport(opts: { timeoutMs?: number } = {}): Promise<ReplicationSupport> {
  const workDir = makeNodeWorkDir("flair-test-2208-probe-");
  let inst: HarperInstance | undefined;
  try {
    inst = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT, multiWorkerUnsafe: false });
    assertOwnedInstance(inst, "probe");
    const res = await ops(inst, { operation: "set_configuration", replicated: true }, opts.timeoutMs);
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
  /** Form the cluster (add_node). */
  connect(): Promise<void>;
  /** Stop both nodes and remove both temp dirs. Kills only these PIDs. */
  stop(): Promise<void>;
}

export function isReplicatedPairReady(
  statuses: Array<{ status: number; body: string }>,
  expectedPeers: readonly [string, string],
): boolean {
  return statuses.length === 2 && statuses.every(({ status, body }, index) => {
    if (status !== 200) return false;
    const connections = (JSON.parse(body) as {
      connections?: Array<{ name?: string; database_sockets?: Array<{ connected?: boolean }> }>;
    }).connections ?? [];
    if (connections.length !== 1 || connections[0]!.name !== expectedPeers[index]) return false;
    const sockets = connections[0]!.database_sockets;
    return Array.isArray(sockets) && sockets.length > 0 && sockets.every((socket) => socket.connected === true);
  });
}

/** A random 127.0.0.0/8 address, so parallel runs do not share a replication
 *  listener. The whole /8 is loopback on Linux. */
function randomLoopbackHost(): string {
  const b = () => 1 + Math.floor(Math.random() * 254);
  return `127.${b()}.${b()}.${b()}`;
}

/** Ask the OS for a free port on `host` (loopback addresses included). */
async function getFreePortOn(host: string): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolveListen, reject) => {
    srv.once("error", reject);
    srv.listen(0, host, () => resolveListen());
  });
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/**
 * Boot two ephemeral Harper Pro nodes with distinct node identities and a
 * replication listener on the same port on different loopback addresses.
 *
 * Both nodes carry this worktree's flair (via makeNodeWorkDir) and inherit the
 * caller's FLAIR_MCP_* environment, so both can run MCP on with no pinned key.
 * `connect()` performs the cluster handshake. Callers MUST call `stop()`.
 */
/** Why a replicated pair cannot run on this host, or null when it can: the
 *  nodes bind random 127.0.0.0/8 addresses, which only Linux routes to loopback
 *  by default (macOS configures 127.0.0.1 alone). */
export function replicatedPairUnsupportedReason(): string | null {
  if (process.platform !== "linux") {
    return `the two-node harness binds random 127.0.0.0/8 addresses, which only Linux routes to loopback (this host is ${process.platform})`;
  }
  return null;
}

export async function startReplicatedPair(opts: {
  mutateConfig?: (shipped: string) => string;
  /** Server environment for both nodes, merged the same way `startHarper`
   *  merges it; an `undefined` entry removes that variable from both. */
  serverEnv?: Record<string, string | undefined>;
} = {}): Promise<ReplicatedPair> {
  if (!PRO_INSTALL_DIR) {
    throw new Error("FLAIR_TEST_HARPER_PRO_DIR is not set; a replicated pair needs a Harper Pro install root");
  }
  const unsupported = replicatedPairUnsupportedReason();
  if (unsupported) throw new Error(`a replicated pair cannot start here: ${unsupported}`);
  const hostA = randomLoopbackHost();
  let hostB = randomLoopbackHost();
  while (hostB === hostA) hostB = randomLoopbackHost();
  const replicationPort = await getFreePortOn(hostA);
  const workDirA = makeNodeWorkDir("flair-test-2208-a-", opts.mutateConfig, { realNodeModules: true });
  const workDirB = makeNodeWorkDir("flair-test-2208-b-", opts.mutateConfig, { realNodeModules: true });
  let a: HarperInstance | undefined;
  let b: HarperInstance | undefined;
  try {
    a = await startHarper({
      cwd: workDirA,
      harperBinDir: PRO_INSTALL_DIR,
      multiWorkerUnsafe: false,
      nodeHostname: hostA,
      env: { REPLICATION_SECUREPORT: `${hostA}:${replicationPort}` },
      serverEnv: opts.serverEnv,
    });
    b = await startHarper({
      cwd: workDirB,
      multiWorkerUnsafe: false,
      harperBinDir: PRO_INSTALL_DIR,
      nodeHostname: hostB,
      env: { REPLICATION_SECUREPORT: `${hostB}:${replicationPort}` },
      serverEnv: opts.serverEnv,
    });
  } catch (err) {
    if (b) { try { await stopHarper(b); } catch { /* best effort */ } }
    if (a) { try { await stopHarper(a); } catch { /* best effort */ } }
    try { rmSync(workDirA, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(workDirB, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
  const connect = async () => {
    assertOwnedInstance(a!, "node-a");
    assertOwnedInstance(b!, "node-b");
    const tokenRes = await ops(a!, { operation: "create_authentication_tokens" });
    if (tokenRes.status !== 200) throw new Error(`create_authentication_tokens on node-a → HTTP ${tokenRes.status} ${tokenRes.body.slice(0, 200)}`);
    const token = (JSON.parse(tokenRes.body) as { operation_token?: string }).operation_token;
    if (!token) throw new Error("create_authentication_tokens on node-a returned no operation_token");
    const add = await ops(b!, { operation: "add_node", rejectUnauthorized: false, hostname: hostA, authorization: `Bearer ${token}` });
    if (add.status !== 200) throw new Error(`add_node on node-b → HTTP ${add.status} ${add.body.slice(0, 300)}`);
    await waitUntil(async () => {
      const statuses = await Promise.all([a!, b!].map((h) => ops(h, { operation: "cluster_status" })));
      return isReplicatedPairReady(statuses, [hostB, hostA]);
    }, { timeoutMs: DEFAULT_CONVERGENCE_TIMEOUT_MS, what: "replicated cluster connection" });
  };
  const stop = async () => {
    // flair#2568: both nodes at once, so the two stops settle within one stop
    // deadline rather than two; the work-dir removals below follow them. Best
    // effort, as before: every stop result — a HarperStopTimeoutError
    // included — is discarded. allSettled over `stopHarper` rather than
    // `stopHarpers`, which module mocks of harper-lifecycle
    // (replicated-nodes-probe) do not provide.
    await Promise.allSettled([b!, a!].map((inst) => stopHarper(inst)));
    try { rmSync(workDirA, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(workDirB, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { a: a!, b: b!, connect, stop };
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
 * Poll until success or timeout; check the deadline between predicate calls.
 * A predicate may run past the deadline. Return milliseconds since `startMs`
 * (or polling start) on success.
 */
export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; intervalMs?: number; startMs?: number; what: string },
): Promise<number> {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const start = opts.startMs ?? Date.now();
  const deadline = start + opts.timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`${opts.what} did not become true within ${opts.timeoutMs}ms`);
    const matched = await predicate();
    const elapsed = Date.now() - start;
    if (elapsed > opts.timeoutMs) throw new Error(`${opts.what} did not become true within ${opts.timeoutMs}ms`);
    if (matched) return elapsed;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
