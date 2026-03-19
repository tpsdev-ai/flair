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

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { FlairClient } from "@tpsdev-ai/flair-client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveAgentId } from "./key-resolver.js";

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

// ─── Workspace sync helpers ───────────────────────────────────────────────────

const WORKSPACE_SOUL_FILES: Record<string, string> = {
  "SOUL.md": "soul",
  "IDENTITY.md": "identity",
  "USER.md": "user-context",
  "AGENTS.md": "workspace-rules",
};

const MAX_SOUL_VALUE = 8000;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function syncWorkspaceToFlair(
  client: FlairClient,
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
      const existing = await client.soul.get(soulKey);
      if ((existing as any)?.contentHash === newHash) continue;

      await client.soul.set(soulKey, content);
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
    const cfg = (api.pluginConfig ?? {}) as FlairMemoryConfig;
    const isAutoMode = !cfg.agentId || cfg.agentId === "auto";

    // Client pool: one FlairClient per agentId, created lazily
    const clientPool = new Map<string, FlairClient>();

    // Resolve fallback agentId once at registration time
    const fallbackAgentId = resolveAgentId();

    function getClient(agentId?: string): FlairClient {
      const id = agentId || cfg.agentId || fallbackAgentId;
      if (!id || id === "auto") throw new Error("no agentId available — set agentId in plugin config, FLAIR_AGENT_ID env var, or ensure OpenClaw provides it via session context");
      let client = clientPool.get(id);
      if (!client) {
        client = new FlairClient({
          url: cfg.url ?? DEFAULT_URL,
          agentId: id,
          keyPath: cfg.keyPath,
        });
        clientPool.set(id, client);
      }
      return client;
    }

    if (!isAutoMode) {
      getClient(cfg.agentId);
    }

    if (!isAutoMode) {
      api.logger.info("openclaw-flair: client created");
    } else if (fallbackAgentId) {
      api.logger.info(`openclaw-flair: auto mode — fallback agentId="${fallbackAgentId}" (from config/env)`);
    } else {
      api.logger.info("openclaw-flair: auto mode — agentId will be resolved from session context");
    }
    const maxRecall = cfg.maxRecallResults ?? DEFAULT_MAX_RECALL;
    const autoCapture = cfg.autoCapture ?? true;
    const autoRecall = cfg.autoRecall ?? true;

    // Per-session agentId — set from config, env, or session context.
    // IMPORTANT: Only update from before_agent_start if it matches our configured agent,
    // NOT from other agents' cron jobs sharing the same gateway.
    let currentAgentId: string | undefined = isAutoMode ? fallbackAgentId ?? undefined : cfg.agentId;
    const configuredAgentId = cfg.agentId && cfg.agentId !== "auto" ? cfg.agentId : fallbackAgentId;

    api.on("before_agent_start", async (event: any, ctx: any) => {
      const eventAgentId = ctx?.agentId || (event as any).agentId;
      // Only adopt the session agentId if we don't already have one configured,
      // or if it matches our configured agent. Don't let kern's cron overwrite flint's agentId.
      if (eventAgentId && (!configuredAgentId || eventAgentId === configuredAgentId)) {
        currentAgentId = eventAgentId;
      }

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

    function getCurrentClient(): FlairClient {
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
            const results = await client.memory.search(query, { limit });
            if (results.length === 0) {
              return { content: [{ type: "text", text: "No relevant memories found." }], details: { count: 0 } };
            }
            const text = results
              .map((r, i) => {
                const date = r.createdAt ? r.createdAt.slice(0, 10) : "";
                const meta = [date, r.type, r.durability].filter(Boolean).join(", ");
                return `${i + 1}. ${r.content}${meta ? ` (${meta})` : ""}`;
              })
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
            const client = getCurrentClient();
            const memId = `${client.agentId}-${Date.now()}`;
            const result = await client.memory.write(text, {
              id: memId,
              tags,
              durability: durability as any,
              type: type as any,
              dedup: true,
              dedupThreshold: 0.7,
            });
            const wasDeduped = result.id !== memId;
            return {
              content: [{ type: "text", text: wasDeduped
                ? `Similar memory already exists (id: ${result.id})`
                : `Memory stored (id: ${memId})` }],
              details: { id: result.id, deduplicated: wasDeduped },
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
            const mem = await client.memory.get(id);
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
          if (ctx?.agentId && !currentAgentId) currentAgentId = ctx.agentId;
          const client = getCurrentClient();
          const result = await client.bootstrap({ maxTokens: cfg.maxBootstrapTokens ?? DEFAULT_MAX_BOOTSTRAP_TOKENS });
          const context = result.context;
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
          const client = getCurrentClient();
          const messages = (event.messages ?? []) as Array<{ role: string; content?: string }>;
          let stored = 0;
          for (const msg of messages) {
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            const text = typeof msg.content === "string" ? msg.content : "";
            if (!text || !shouldCapture(text)) continue;
            const excerpt = excerptForCapture(text);
            await client.memory.write(excerpt, { type: "session", tags: ["auto-captured"] });
            stored++;
            if (stored >= 3) break;
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
