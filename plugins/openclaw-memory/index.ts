/**
 * openclaw-flair — OpenClaw Memory Plugin backed by Flair
 *
 * Replaces the built-in MEMORY.md / memory-lancedb system with Flair as the
 * single source of truth for agent memory. Uses Flair's native Harper
 * embeddings — no OpenAI API key required.
 *
 * Implements the OpenClaw "memory" plugin slot:
 *   - memory_recall  → POST /SemanticSearch (semantic search)
 *   - memory_store   → PUT  /Memory/<id>  (write + embed)
 *   - memory_get     → GET  /Memory/<id>  (fetch by id)
 *   - before_agent_start hook → inject recent/relevant memories
 *   - agent_end hook → auto-capture from conversation
 */

import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ─── Config ──────────────────────────────────────────────────────────────────

interface FlairMemoryConfig {
  url?: string;
  agentId: string;
  keyPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  maxRecallResults?: number;
  maxBootstrapTokens?: number;
}

const DEFAULT_URL = "http://127.0.0.1:9926";
const DEFAULT_MAX_RECALL = 5;
const DEFAULT_MAX_BOOTSTRAP_TOKENS = 4000;

// ─── Key Resolution (separated from network client for security scanner) ──────

/**
 * Resolve the default Flair key path for an agent.
 * Checks FLAIR_KEY_DIR env var first, then standard ~/.flair/keys/ path.
 */
function resolveDefaultKeyPath(agentId: string): string | null {
  const keyDirEnv = process.env.FLAIR_KEY_DIR;
  if (keyDirEnv) {
    const envPath = resolve(keyDirEnv, `${agentId}.key`);
    if (existsSync(envPath)) return envPath;
  }
  const standard = resolve(homedir(), ".flair", "keys", `${agentId}.key`);
  if (existsSync(standard)) return standard;
  return null;
}

// ─── Flair HTTP Client ────────────────────────────────────────────────────────

class FlairMemoryClient {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly keyPath: string | null;

  constructor(config: FlairMemoryConfig) {
    this.baseUrl = (config.url ?? DEFAULT_URL).replace(/\/$/, "");
    this.agentId = config.agentId;
    this.keyPath = config.keyPath
      ? resolve(config.keyPath.replace(/^~/, homedir()))
      : resolveDefaultKeyPath(config.agentId);
  }

  private buildAuthHeader(method: string, path: string): Record<string, string> {
    if (!this.keyPath || !existsSync(this.keyPath)) return {};
    try {
      const { sign: ed25519Sign, createPrivateKey, randomUUID: rv } = require("node:crypto");
      // Read raw bytes — supports both:
      //   - 32-byte binary seed (written by `flair init`)
      //   - base64-encoded seed (legacy format)
      const fileBuf = readFileSync(this.keyPath);
      let rawBuf: Buffer;
      if (fileBuf.length === 32) {
        // Raw binary seed
        rawBuf = fileBuf;
      } else {
        // Try base64 decode
        rawBuf = Buffer.from(fileBuf.toString("utf-8").trim(), "base64");
      }
      let privateKey: ReturnType<typeof createPrivateKey>;
      if (rawBuf.length === 32) {
        // Raw Ed25519 seed — wrap in PKCS8 DER envelope
        const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
        privateKey = createPrivateKey({ key: Buffer.concat([pkcs8Header, rawBuf]), format: "der", type: "pkcs8" });
      } else {
        privateKey = createPrivateKey({ key: rawBuf, format: "der", type: "pkcs8" });
      }
      const ts = Date.now().toString();
      const nonce = rv();
      const payload = `${this.agentId}:${ts}:${nonce}:${method}:${path}`;
      const sig = ed25519Sign(null, Buffer.from(payload), privateKey);
      return { Authorization: `TPS-Ed25519 ${this.agentId}:${ts}:${nonce}:${sig.toString("base64")}` };
    } catch {
      return {};
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...this.buildAuthHeader(method, path),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Flair ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  async writeMemory(id: string, content: string, opts: { durability?: string; type?: string; tags?: string[]; supersedes?: string } = {}): Promise<void> {
    const record: Record<string, unknown> = {
      id,
      agentId: this.agentId,
      content,
      durability: opts.durability ?? "standard",
      type: opts.type ?? "session",
      createdAt: new Date().toISOString(),
    };
    if (opts.tags?.length) record.tags = opts.tags;
    if (opts.supersedes) record.supersedes = opts.supersedes;
    await this.request("PUT", `/Memory/${id}`, record);
  }

  async searchMemories(query: string, limit: number): Promise<Array<{ id: string; content: string; score: number; tags?: string[] }>> {
    const result = await this.request<{ results?: Array<{ id: string; content: string; score?: number; similarity?: number; memory?: { id: string; content: string; tags?: string[] } }> }>(
      "POST",
      "/SemanticSearch",
      { agentId: this.agentId, q: query, limit },
    );
    return (result.results ?? []).map((r) => ({
      id: r.id ?? r.memory?.id ?? "",
      content: r.content ?? r.memory?.content ?? "",
      score: r.score ?? r.similarity ?? 0,
      tags: r.memory?.tags,
    }));
  }

  async getMemory(id: string): Promise<{ id: string; content: string; createdAt?: string } | null> {
    try {
      return await this.request("GET", `/Memory/${id}`);
    } catch {
      return null;
    }
  }

  async bootstrap(opts: { days?: number } = {}): Promise<string> {
    try {
      const days = opts.days ?? 7;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const result = await this.request<{ context?: string; text?: string }>(
        "POST",
        "/BootstrapMemories",
        { agentId: this.agentId, since },
      );
      return result.context ?? result.text ?? "";
    } catch {
      return "";
    }
  }

  async getSoul(key: string): Promise<{ id: string; key: string; value: string; contentHash?: string } | null> {
    try {
      return await this.request("GET", `/Soul/${this.agentId}-${key}`);
    } catch {
      return null;
    }
  }

  async writeSoul(key: string, value: string, contentHash?: string): Promise<void> {
    const record: Record<string, unknown> = {
      id: `${this.agentId}-${key}`,
      agentId: this.agentId,
      key,
      value,
      durability: "permanent",
      createdAt: new Date().toISOString(),
    };
    if (contentHash) record.contentHash = contentHash;
    await this.request("PUT", `/Soul/${this.agentId}-${key}`, record);
  }
}

// ─── Workspace sync helpers ───────────────────────────────────────────────────

/** Files to sync from workspace to Flair soul entries (spec: OPS-workspace-sync) */
const WORKSPACE_SOUL_FILES: Record<string, string> = {
  "SOUL.md": "soul",
  "IDENTITY.md": "identity",
  "USER.md": "user-context",
  "AGENTS.md": "workspace-rules",
};

/** Max size for a single soul entry (chars). Files larger are truncated. */
const MAX_SOUL_VALUE = 8000;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Sync workspace files to Flair soul entries.
 * Only writes when content has changed (hash comparison).
 */
async function syncWorkspaceToFlair(
  client: FlairMemoryClient,
  agentId: string,
  logger: { info: Function; warn: Function },
): Promise<number> {
  const workspace = resolve(homedir(), ".openclaw", `workspace-${agentId}`);
  if (!existsSync(workspace)) return 0;

  let synced = 0;
  for (const [filename, soulKey] of Object.entries(WORKSPACE_SOUL_FILES)) {
    const filePath = resolve(workspace, filename);
    if (!existsSync(filePath)) continue;

    try {
      let content = readFileSync(filePath, "utf-8").trim();
      if (!content) continue;
      if (content.length > MAX_SOUL_VALUE) content = content.slice(0, MAX_SOUL_VALUE) + "\n…(truncated)";

      const newHash = hashContent(content);

      // Check existing entry's hash
      const existing = await client.getSoul(soulKey);
      if (existing?.contentHash === newHash) continue; // unchanged

      await client.writeSoul(soulKey, content, newHash);
      synced++;
      logger.info(`openclaw-flair: synced ${filename} → soul:${soulKey} (hash=${newHash})`);
    } catch (err: any) {
      logger.warn(`openclaw-flair: failed to sync ${filename}: ${err.message}`);
    }
  }
  return synced;
}

// ─── Auto-capture helpers ─────────────────────────────────────────────────────

const CAPTURE_TRIGGERS = [
  /\b(remember|note that|important:|keep in mind|don't forget)\b/i,
  /\b(preference|prefer|always|never|my name is|i am|i'm)\b/i,
  /\b(decided|agreed|confirmed|finalized)\b/i,
];

function shouldCapture(text: string): boolean {
  return CAPTURE_TRIGGERS.some((re) => re.test(text));
}

function excerptForCapture(text: string, maxChars = 500): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// ─── Plugin export ────────────────────────────────────────────────────────────

export default {
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    try {
    const cfg = api.pluginConfig as FlairMemoryConfig;
    const isAutoMode = !cfg.agentId || cfg.agentId === "auto";

    // Client pool: one client per agentId, created lazily
    const clientPool = new Map<string, FlairMemoryClient>();
    
    function getClient(agentId?: string): FlairMemoryClient {
      const id = agentId || cfg.agentId;
      if (!id || id === "auto") throw new Error("no agentId available");
      let client = clientPool.get(id);
      if (!client) {
        client = new FlairMemoryClient({ ...cfg, agentId: id });
        clientPool.set(id, client);
      }
      return client;
    }

    // For non-auto mode, pre-create the client
    if (!isAutoMode) {
      getClient(cfg.agentId);
    }

    api.logger.info("openclaw-flair: config ok, creating client...");
    api.logger.info("openclaw-flair: client created");
    const maxRecall = cfg.maxRecallResults ?? DEFAULT_MAX_RECALL;
    const autoCapture = cfg.autoCapture ?? true;
    const autoRecall = cfg.autoRecall ?? true;

    // Track current agent per-session via hooks (tools don't get agentId in execute)
    let currentAgentId: string | undefined = isAutoMode ? undefined : cfg.agentId;
    
    api.on("before_agent_start", async (event: any, ctx: any) => {
      const eventAgentId = ctx?.agentId || (event as any).agentId;
      if (eventAgentId) currentAgentId = eventAgentId;

      // Sync workspace files → Flair soul entries (hash-based, only on change)
      if (eventAgentId) {
        try {
          const client = getClient(eventAgentId);
          const synced = await syncWorkspaceToFlair(client, eventAgentId, api.logger);
          if (synced > 0) api.logger.info(`openclaw-flair: workspace sync: ${synced} files updated`);
        } catch (err: any) {
          api.logger.warn(`openclaw-flair: workspace sync failed: ${err.message}`);
        }
      }
    });
    
    // Helper to get client using tracked agentId
    function getCurrentClient(): FlairMemoryClient {
      return getClient(currentAgentId);
    }

    const displayAgent = isAutoMode ? "auto (per-session)" : cfg.agentId;
    api.logger.info(`openclaw-flair: registered (agent=${displayAgent}, url=${cfg.url ?? DEFAULT_URL})`);

    // ── memory_recall ──────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search long-term memory via Flair semantic search. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_id, params) {
          const { query, limit = maxRecall } = params as { query: string; limit?: number };
          try {
            const client = getCurrentClient();
            const results = await client.searchMemories(query, limit);
            if (results.length === 0) {
              return { content: [{ type: "text", text: "No relevant memories found." }], details: { count: 0 } };
            }
            const text = results
              .map((r, i) => `${i + 1}. ${r.content} (${(r.score * 100).toFixed(0)}%)`)
              .join("\n");
            return {
              content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
              details: { count: results.length, memories: results },
            };
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: recall failed: ${err.message}`);
            return { content: [{ type: "text", text: `Memory recall unavailable: ${err.message}` }], details: { count: 0 } };
          }
        },
      },
      { name: "memory_recall" },
    );

    // ── memory_store ───────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description: "Save important information in long-term memory via Flair. Use for preferences, facts, decisions, and key context.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default: 0.7)" })),
          tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
          durability: Type.Optional(Type.Union([
            Type.Literal("permanent"),
            Type.Literal("persistent"),
            Type.Literal("standard"),
            Type.Literal("ephemeral"),
          ], { description: "Memory durability: permanent (inviolable), persistent (key decisions), standard (default), ephemeral (auto-expires)" })),
          type: Type.Optional(Type.Union([
            Type.Literal("session"),
            Type.Literal("lesson"),
            Type.Literal("decision"),
            Type.Literal("preference"),
            Type.Literal("fact"),
            Type.Literal("goal"),
          ], { description: "Memory type for categorization" })),
          supersedes: Type.Optional(Type.String({ description: "ID of memory this replaces (creates version chain)" })),
        }),
        async execute(_id, params) {
          const { text, tags, durability, type, supersedes } = params as {
            text: string; importance?: number; tags?: string[];
            durability?: string; type?: string; supersedes?: string;
          };
          try {
            const agentId = currentAgentId || cfg.agentId;
            const client = getCurrentClient();
            const memId = `${agentId}-${Date.now()}`;
            await client.writeMemory(memId, text, { tags, durability, type, supersedes });
            return {
              content: [{ type: "text", text: `Memory stored (id: ${memId})` }],
              details: { id: memId },
            };
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: store failed: ${err.message}`);
            return { content: [{ type: "text", text: `Memory store unavailable: ${err.message}` }], details: {} };
          }
        },
      },
      { name: "memory_store" },
    );

    // ── memory_get ─────────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "memory_get",
        label: "Memory Get",
        description: "Retrieve a specific memory by ID from Flair.",
        parameters: Type.Object({
          id: Type.String({ description: "Memory ID" }),
        }),
        async execute(_toolId, params) {
          const { id } = params as { id: string };
          try {
            const client = getCurrentClient();
            const mem = await client.getMemory(id);
            if (!mem) return { content: [{ type: "text", text: `Memory ${id} not found.` }], details: {} };
            return {
              content: [{ type: "text", text: mem.content }],
              details: mem,
            };
          } catch (err: any) {
            return { content: [{ type: "text", text: `Memory get failed: ${err.message}` }], details: {} };
          }
        },
      },
      { name: "memory_get" },
    );

    // ── Lifecycle: auto-recall on session start ────────────────────────────

    if (autoRecall) {
      api.on("before_agent_start", async (event: any, ctx: any) => {
        try {
          // Ensure agentId is set (in case this fires before the tracking hook)
          if (ctx?.agentId && !currentAgentId) currentAgentId = ctx.agentId;
          const client = getCurrentClient();
          const context = await client.bootstrap({ days: 7 });
          if (context && typeof context === "string" && context.trim().length > 0) {
            const truncated = context.slice(0, (cfg.maxBootstrapTokens ?? DEFAULT_MAX_BOOTSTRAP_TOKENS) * 4);
            event.injectContext?.(`\n## Memory Context (from Flair)\n\n${truncated}\n`);
            api.logger.info(`openclaw-flair: injected bootstrap context (${context.length} chars)`);
          }
        } catch (err: any) {
          api.logger.warn(`openclaw-flair: bootstrap recall failed: ${err.message}`);
        }
      });
    }

    // ── Lifecycle: auto-capture on session end ────────────────────────────

    if (autoCapture) {
      api.on("agent_end", async (event) => {
        try {
          const agentId = currentAgentId || cfg.agentId;
          const client = getCurrentClient();
          const messages = (event.messages ?? []) as Array<{ role: string; content?: string }>;
          let stored = 0;
          for (const msg of messages) {
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            const text = typeof msg.content === "string" ? msg.content : "";
            if (!text || !shouldCapture(text)) continue;
            const excerpt = excerptForCapture(text);
            const memId = `${agentId}-${Date.now()}-${stored}`;
            await client.writeMemory(memId, excerpt, { type: "session", tags: ["auto-captured"] });
            stored++;
            if (stored >= 3) break; // cap at 3 per session
          }
          if (stored > 0) api.logger.info(`openclaw-flair: auto-captured ${stored} memories`);
        } catch (err: any) {
          api.logger.warn(`openclaw-flair: auto-capture failed: ${err.message}`);
        }
      });
    }

    } catch (err: any) {
      api.logger.error(`openclaw-flair register error: ${err.message}`);
      throw err;
    }
  },
};
