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
 * Create an agent via the Flair REST API (which triggers key generation etc).
 * Returns the agent ID.
 */
export async function createAgent(
  baseUrl: string,
  authHeader: string,
): Promise<string> {
  const id = `smoke-${Date.now()}-${randomBytes(4).toString("hex")}`;

  const res = await fetch(`${baseUrl}/Agent/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({
      id,
      name: `Smoke Test ${id.slice(-8)}`,
      kind: "agent",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createAgent ${id}: HTTP ${res.status} ${text}`);
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
    headers: { "Content-Type": "application/json" },
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
 * Search memories via the Flair REST API.
 */
export async function searchMemories(
  baseUrl: string,
  agentId: string,
  query: string,
  limit = 5,
): Promise<any> {
  const res = await fetch(`${baseUrl}/SemanticSearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
): Promise<any> {
  const res = await fetch(`${baseUrl}/BootstrapMemories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  const res = await fetch(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
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
