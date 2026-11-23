/**
 * flair-instance.ts — Smoke test helper for Flair instance lifecycle.
 *
 * Supports two modes:
 *   1. FLAIR_TEST_URL env → use external Flair (CI-friendly, Docker)
 *   2. Auto-detect at http://127.0.0.1:9926 (local dev, already running)
 *
 * Returns a handle with {baseUrl, opsUrl, adminUser, adminPass, cleanup()}.
 * cleanup() deletes any agents/memories/souls created during the test.
 */

import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import {
  EMBEDDING_READY_DEADLINE_MS,
  recordStepSummary,
  warmInstanceEmbeddings,
} from "../../../scripts/ci/embedding-readiness.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlairInstance {
  /** Flair HTTP base URL, e.g. http://127.0.0.1:9926 */
  baseUrl: string;
  /** Harper operations API URL, e.g. http://127.0.0.1:9925 */
  opsUrl: string;
  /** Admin user (default: admin) */
  adminUser: string;
  /** Admin password */
  adminPass: string;
  /** Auth header value for Basic auth */
  authHeader: string;
  /** Clean up all agents/memories/souls created during this test */
  cleanup: (agentIds: string[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Client-side timeout and acceptance policy for instance resolution, measured
 * on a monotonic clock: every `/Health` request's client timeout and every poll
 * sleep is clamped to the time left, and an answer that arrives at or after the
 * bound is not accepted (a fetch or sleep that ignores its timer can still
 * settle later).
 */
export const INSTANCE_RESOLVE_BUDGET_MS = 30_000;
/** Client timeout of one `/Health` request, before clamping to the time left. */
export const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
/** Pause between `/Health` polls, before clamping to the time left. */
export const HEALTH_POLL_INTERVAL_MS = 500;

/** Seams for the resolution bound's unit test; the smoke path passes none. */
export interface ResolveFlairInstanceOptions {
  /** Monotonic milliseconds (default `performance.now()`). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Builds each `/Health` request's signal (default `AbortSignal.timeout`). */
  timeoutSignal?: (ms: number) => AbortSignal;
  /** Resolution budget (default `INSTANCE_RESOLVE_BUDGET_MS`), so the default clock can be tested in real time. */
  budgetMs?: number;
}

function resolvePorts(): { httpPort: number; opsPort: number } {
  if (process.env.FLAIR_TEST_URL) {
    const u = new URL(process.env.FLAIR_TEST_URL);
    const hp = parseInt(u.port || "9926", 10);
    return { httpPort: hp, opsPort: hp - 1 };
  }
  return { httpPort: 9926, opsPort: 9925 };
}

/**
 * Resolve a Flair instance for smoke testing.
 *
 * Priority:
 *   1. FLAIR_TEST_URL env (CI / Docker)
 *   2. Auto-detect at http://127.0.0.1:9926 (local dev)
 *
 * Admin credentials: FLAIR_ADMIN_PASS env > "admin123" (Docker default)
 */
export async function resolveFlairInstance(opts: ResolveFlairInstanceOptions = {}): Promise<FlairInstance> {
  const { httpPort, opsPort } = resolvePorts();
  const baseUrl = process.env.FLAIR_TEST_URL ?? `http://127.0.0.1:${httpPort}`;
  const opsUrl = `http://127.0.0.1:${opsPort}`;
  const adminUser = process.env.FLAIR_ADMIN_USER ?? "admin";
  const adminPass = process.env.FLAIR_ADMIN_PASS ?? "admin123";
  const authHeader = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

  // Wait for Flair to be healthy, within INSTANCE_RESOLVE_BUDGET_MS measured on
  // a monotonic clock: each request's client timeout and each sleep are sized to
  // the time left, and a success that arrives at or after the deadline is refused.
  // This is a client-side timeout and acceptance policy; a fetch or sleep that
  // ignores its timer can still settle later.
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutSignal = opts.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const budgetMs = opts.budgetMs ?? INSTANCE_RESOLVE_BUDGET_MS;
  const deadline = now() + budgetMs;
  let ready = false;

  for (;;) {
    // Whole milliseconds (Node's AbortSignal.timeout rejects a fraction),
    // rounded down so the request's timer is never due after the deadline.
    const requestMs = Math.min(HEALTH_REQUEST_TIMEOUT_MS, Math.floor(deadline - now()));
    if (requestMs < 1) break;
    try {
      const res = await fetchImpl(`${baseUrl}/Health`, {
        signal: timeoutSignal(requestMs),
      });
      if (res.ok && now() < deadline) {
        ready = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    // Whole milliseconds for the pause too: a timer may round a fractional
    // delay up (Node makes any delay under 1 ms a 1 ms timer), which would fall
    // due after the deadline, so under 1 ms left ends the wait without a sleep.
    const pauseMs = Math.min(HEALTH_POLL_INTERVAL_MS, Math.floor(deadline - now()));
    if (pauseMs < 1) break;
    await sleep(pauseMs);
  }

  if (!ready) {
    throw new Error(
      `Flair instance at ${baseUrl} was not confirmed healthy before the client-side deadline (${budgetMs / 1000}s). ` +
      `Ensure a Flair instance is running (local: 'flair serve', Docker: see CI workflow). ` +
      `Or set FLAIR_TEST_URL to an existing instance.`,
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    opsUrl,
    adminUser,
    adminPass,
    authHeader,
    cleanup: async (agentIds: string[]) => {
      await cleanupAgents(opsUrl, authHeader, agentIds);
    },
  };
}

// ---------------------------------------------------------------------------
// Agent management (ops API)
// ---------------------------------------------------------------------------

/** HTTP port from a baseUrl, e.g. http://127.0.0.1:9926 → 9926 */
function httpPortFrom(baseUrl: string): number {
  return parseInt(new URL(baseUrl).port || "9926", 10);
}

/**
 * Create an agent via the Harper operations API insert.
 * Returns the agent ID.
 */
export async function createAgent(
  opsUrl: string,
  authHeader: string,
): Promise<string> {
  const id = `smoke-${Date.now()}-${randomBytes(4).toString("hex")}`;
  // Generate a test Ed25519 keypair (matches real agent registration)
  const kp = nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString("base64url");

  const body = JSON.stringify({
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{
      id,
      name: `Smoke Test ${id.slice(-8)}`,
      kind: "agent",
      publicKey,
      createdAt: new Date().toISOString(),
    }],
  });

  // Try with auth first; if 401 (e.g. authorizeLocal=true with wrong password), retry without auth
  let res = await fetch(opsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) {
    res = await fetch(opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createAgent ${id}: HTTP ${res.status} ${text}`);
  }
  const text = await res.text();
  if (!text.includes("inserted")) {
    throw new Error(`createAgent ${id}: unexpected response: ${text}`);
  }

  return id;
}

/**
 * Write a memory via the Flair REST API.
 */
export async function writeMemory(
  baseUrl: string,
  agentId: string,
  content: string,
  opts?: { tags?: string[]; durability?: string },
  authHeader?: string,
): Promise<string> {
  const memId = `${agentId}-${Date.now()}-${randomBytes(4).toString("hex")}`;

  const body: Record<string, unknown> = {
    id: memId,
    agentId,
    content,
    type: "memory",
    durability: opts?.durability ?? "standard",
    createdAt: new Date().toISOString(),
  };

  if (opts?.tags) body.tags = opts.tags;

  const res = await fetch(`${baseUrl}/Memory/${encodeURIComponent(memId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`writeMemory: HTTP ${res.status} ${text}`);
  }

  // Allow time for embeddings to be generated
  await new Promise(r => setTimeout(r, 3000));

  return memId;
}

/**
 * Warm the embedding model before the timed golden-path assertions run.
 *
 * flair#1219 — the flake this kills: the embedding backend
 * (harper-fabric-embeddings → llama.cpp) loads the model lazily on the FIRST
 * embedding call, not at Harper boot. `/Health` returning 200 therefore does
 * NOT mean the model is ready. On a cold or loaded CI runner that first load
 * can take well over 10s — longer than `writeMemory`'s client-side
 * `AbortSignal.timeout(10_000)` on `PUT /Memory` — so whichever timed step is
 * first (Step 2, Write memory) intermittently died with
 * `TimeoutError: The operation timed out` at ~10s. It reproduces green
 * locally where the model is already warm (a warm write is ~3s). Confirmed
 * across #1217/#1221/#1222.
 *
 * This helper pays the cold-start cost UP FRONT, on a throwaway agent+memory:
 * it returns only after a stored embedding was observed on this instance, before
 * the measured Step-2 write runs (an observation, not a guarantee the model
 * stays loaded). It exercises the same server path the timed step does (an
 * ops-inserted agent, then an admin-authed PUT /Memory). It deletes its own
 * throwaway rows and agent and reports a failed delete, naming what may remain,
 * rather than treating it as gone.
 *
 * flair#3052: elapsed time (the shared helper in
 * scripts/ci/embedding-readiness.mjs) and a hard attempt cap
 * (MAX_READINESS_ATTEMPTS) govern retries and acceptance, not an attempt count
 * alone: three calls that each time out at the default provider bound, plus two
 * retry pauses, take about 62 s however generous the per-attempt budget was.
 * This is a client-side policy; an in-flight request or sleep can still settle
 * after the deadline, and its answer is then refused. Among non-2xx Memory responses
 * only a 503 whose JSON error field is `memory_provider_timeout` is retried;
 * any other non-2xx answer fails at once. A 2xx whose read-back fails or does
 * not show a stored vector and model stamp is also retried within the deadline.
 *
 * NOTE: this deliberately does NOT weaken `writeMemory`'s 10s timeout — that
 * timeout is a real client-side guard and stays put. The fix is to ensure the
 * measured write is never the one that pays for the model load.
 */
export async function warmEmbeddingModel(
  flair: FlairInstance,
  opts?: { deadlineMs?: number },
): Promise<{ elapsedMs: number; attempts: number }> {
  const result = await warmInstanceEmbeddings({
    baseUrl: flair.baseUrl,
    opsUrl: flair.opsUrl,
    authHeader: flair.authHeader,
    label: "smoke warm-up",
    deadlineMs: opts?.deadlineMs ?? EMBEDDING_READY_DEADLINE_MS,
  });
  recordStepSummary("Smoke Tests (Golden Path)", result);
  return result;
}

/**
 * Search memories via the Flair REST API.
 */
export async function searchMemories(
  baseUrl: string,
  agentId: string,
  query: string,
  limit = 5,
  authHeader?: string,
): Promise<any> {
  const res = await fetch(`${baseUrl}/SemanticSearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
    body: JSON.stringify({ agentId, q: query, limit }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`searchMemories: HTTP ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * Bootstrap context for an agent.
 */
export async function bootstrapAgent(
  baseUrl: string,
  agentId: string,
  maxTokens = 4000,
  authHeader?: string,
): Promise<any> {
  const res = await fetch(`${baseUrl}/BootstrapMemories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
    body: JSON.stringify({ agentId, maxTokens }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`bootstrapAgent: HTTP ${res.status} ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Cleanup (ops API)
// ---------------------------------------------------------------------------

async function opsPost(opsUrl: string, authHeader: string, body: unknown): Promise<any> {
  const jsonBody = JSON.stringify(body);
  // Try with auth first; if 401 (authorizeLocal=true), retry without auth
  let res = await fetch(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: jsonBody,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) {
    res = await fetch(opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: jsonBody,
      signal: AbortSignal.timeout(10_000),
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`opsPost: HTTP ${res.status} ${text}`);
  }
  return res.json().catch(() => ({}));
}

async function cleanupAgents(opsUrl: string, authHeader: string, agentIds: string[]): Promise<void> {
  for (const agentId of agentIds) {
    try {
      // 1. Find agent memories
      const memRes = await opsPost(opsUrl, authHeader, {
        operation: "search_by_value",
        database: "flair",
        table: "Memory",
        search_attribute: "agentId",
        search_value: agentId,
        get_attributes: ["id"],
      });

      const memories: Array<{ id: string }> = Array.isArray(memRes) ? memRes : [];
      const memIds = memories.filter(m => m?.id).map(m => m.id);

      // 2. Delete memories in batches of 100
      for (let i = 0; i < memIds.length; i += 100) {
        const batch = memIds.slice(i, i + 100);
        await opsPost(opsUrl, authHeader, {
          operation: "delete",
          database: "flair",
          table: "Memory",
          ids: batch,
        });
      }

      // 3. Delete souls
      const soulRes = await opsPost(opsUrl, authHeader, {
        operation: "search_by_value",
        database: "flair",
        table: "Soul",
        search_attribute: "agentId",
        search_value: agentId,
        get_attributes: ["id"],
      });
      const souls: Array<{ id: string }> = Array.isArray(soulRes) ? soulRes : [];
      if (souls.length > 0) {
        await opsPost(opsUrl, authHeader, {
          operation: "delete",
          database: "flair",
          table: "Soul",
          ids: souls.filter(s => s?.id).map(s => s.id),
        });
      }

      // 4. Delete the agent
      await opsPost(opsUrl, authHeader, {
        operation: "delete",
        database: "flair",
        table: "Agent",
        ids: [agentId],
      });
    } catch (err) {
      console.error(`[flair-instance] cleanup agent ${agentId} failed:`, err);
    }
  }
}
