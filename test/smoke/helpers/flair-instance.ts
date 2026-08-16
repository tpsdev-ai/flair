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
export async function resolveFlairInstance(): Promise<FlairInstance> {
  const { httpPort, opsPort } = resolvePorts();
  const baseUrl = process.env.FLAIR_TEST_URL ?? `http://127.0.0.1:${httpPort}`;
  const opsUrl = `http://127.0.0.1:${opsPort}`;
  const adminUser = process.env.FLAIR_ADMIN_USER ?? "admin";
  const adminPass = process.env.FLAIR_ADMIN_PASS ?? "admin123";
  const authHeader = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

  // Wait for Flair to be healthy
  const deadline = Date.now() + 30_000;
  let ready = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/Health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!ready) {
    throw new Error(
      `Flair instance at ${baseUrl} did not respond within 30s. ` +
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
 * This helper pays the cold-start cost UP FRONT, on a throwaway agent+memory,
 * with a generous budget and a couple of retries, so the model is hot before
 * the measured Step-2 write ever runs. It exercises the exact same path the
 * timed step does (create agent → PUT /Memory, admin-authed), so it warms
 * precisely what Step 2 needs. It creates and deletes its own throwaway agent,
 * leaving no residue in the instance.
 *
 * NOTE: this deliberately does NOT weaken `writeMemory`'s 10s timeout — that
 * timeout is a real client-side guard and stays put. The fix is to ensure the
 * measured write is never the one that pays for the model load.
 */
export async function warmEmbeddingModel(
  flair: FlairInstance,
  opts?: { timeoutMs?: number; attempts?: number },
): Promise<{ elapsedMs: number; attempts: number }> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const maxAttempts = opts?.attempts ?? 3;

  // A real throwaway agent so the write is fully valid and reaches the
  // server-side embedding step (Memory.put → getEmbedding) rather than being
  // rejected before it. Mirrors Step 1 + Step 2 of the golden path.
  const warmAgentId = await createAgent(flair.opsUrl, flair.authHeader);
  const t0 = performance.now();
  let lastErr: unknown;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const memId = `${warmAgentId}-warmup-${Date.now()}-${randomBytes(4).toString("hex")}`;
      const body = {
        id: memId,
        agentId: warmAgentId,
        content: `embedding warm-up ${memId}`,
        type: "memory",
        durability: "ephemeral",
        createdAt: new Date().toISOString(),
      };
      try {
        // Generous per-attempt budget: this call is EXPECTED to absorb the
        // cold model load, so it must not use writeMemory's 10s abort.
        const res = await fetch(`${flair.baseUrl}/Memory/${encodeURIComponent(memId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: flair.authHeader },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          return { elapsedMs: Math.round(performance.now() - t0), attempts: attempt };
        }
        lastErr = new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
      } catch (err) {
        lastErr = err;
      }
      // Brief backoff before retrying a still-loading model.
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(
      `warmEmbeddingModel: embedding model did not become ready within ` +
      `${maxAttempts} attempt(s) @ ${timeoutMs}ms each: ${String(lastErr)}`,
    );
  } finally {
    // Never let a warm-up leak an agent into the instance, even on failure.
    await flair.cleanup([warmAgentId]).catch(() => {});
  }
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
