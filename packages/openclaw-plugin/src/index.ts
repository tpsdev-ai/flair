/**
 * @tps/memory-flair — OpenClaw Memory Plugin backed by Flair
 *
 * Replaces the built-in MEMORY.md / memory-lancedb system with Flair as the
 * single source of truth for agent memory. Uses Flair's native Harper
 * embeddings — no OpenAI API key required.
 *
 * Implements the OpenClaw "memory" plugin slot:
 *   - memory_recall  → POST /SemanticSearch (semantic + recency ranked)
 *   - memory_store   → PUT  /Memory/<id>    (write + embed)
 *   - memory_get     → GET  /Memory/<id>    (fetch by id)
 *   - before_agent_start hook → inject recent/relevant memories via bootstrap
 *   - agent_end hook → auto-capture from conversation turns
 *
 * Auth: TPS-Ed25519 — raw 32-byte seed or PKCS8 DER private key.
 * Key path defaults to ~/.tps/secrets/flair/<agentId>-priv.key
 *
 * Fallback: if Flair is unreachable, all ops degrade gracefully (warn + empty).
 */

import { createPrivateKey, randomUUID, sign as ed25519Sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FlairMemoryConfig {
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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Build TPS-Ed25519 Authorization header for a given method + path.
 * Supports raw 32-byte seed keys and PKCS8 DER keys.
 * Returns empty object on any auth failure (soft degrade).
 */
export function buildAuthHeader(
  keyPath: string,
  agentId: string,
  method: string,
  path: string,
): Record<string, string> {
  if (!existsSync(keyPath)) return {};
  try {
    const raw = readFileSync(keyPath).toString("utf-8").trim();
    const rawBuf = Buffer.from(raw, "base64");
    let privateKey: ReturnType<typeof createPrivateKey>;
    if (rawBuf.length === 32) {
      // Raw Ed25519 seed — wrap in PKCS8 DER envelope
      const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
      privateKey = createPrivateKey({
        key: Buffer.concat([pkcs8Header, rawBuf]),
        format: "der",
        type: "pkcs8",
      });
    } else {
      privateKey = createPrivateKey({ key: rawBuf, format: "der", type: "pkcs8" });
    }
    const ts = Date.now().toString();
    const nonce = randomUUID();
    const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
    const sig = ed25519Sign(null, Buffer.from(payload), privateKey);
    return { Authorization: `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig.toString("base64")}` };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Flair HTTP client
// ---------------------------------------------------------------------------

interface MemoryRecord {
  id: string;
  agentId: string;
  content: string;
  durability?: string;
  type?: string;
  tags?: string[];
  supersedes?: string;
  createdAt: string;
}

interface SearchResult {
  id: string;
  content: string;
  score: number;
  tags?: string[];
}

export class FlairMemoryClient {
  private readonly baseUrl: string;
  readonly agentId: string;
  private readonly keyPath: string | null;

  constructor(config: FlairMemoryConfig) {
    this.baseUrl = (config.url ?? DEFAULT_URL).replace(/\/$/, "");
    this.agentId = config.agentId;
    this.keyPath = config.keyPath
      ? resolve(config.keyPath.replace(/^~/, homedir()))
      : this.resolveDefaultKey(config.agentId);
  }

  private resolveDefaultKey(agentId: string): string | null {
    const candidates = [
      resolve(homedir(), ".tps", "secrets", "flair", `${agentId}-priv.key`),
      resolve(homedir(), ".tps", "secrets", `${agentId}-flair.key`),
    ];
    return candidates.find(existsSync) ?? null;
  }

  private getAuthHeader(method: string, path: string): Record<string, string> {
    if (!this.keyPath) return {};
    return buildAuthHeader(this.keyPath, this.agentId, method, path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...this.getAuthHeader(method, path),
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

  async writeMemory(
    id: string,
    content: string,
    opts: { durability?: string; type?: string; tags?: string[]; supersedes?: string } = {},
  ): Promise<void> {
    const record: MemoryRecord = {
      id,
      agentId: this.agentId,
      content,
      durability: opts.durability ?? "standard",
      type: opts.type ?? "session",
      createdAt: new Date().toISOString(),
    };
    if (opts.tags?.length) record.tags = opts.tags;
    if (opts.supersedes) record.supersedes = opts.supersedes;
    await this.request<void>("PUT", `/Memory/${id}`, record);
  }

  async searchMemories(query: string, limit: number): Promise<SearchResult[]> {
    type RawResult = {
      id?: string;
      content?: string;
      score?: number;
      similarity?: number;
      tags?: string[];
      memory?: { id?: string; content?: string; tags?: string[] };
    };
    const result = await this.request<{ results?: RawResult[] }>(
      "POST",
      "/SemanticSearch",
      { agentId: this.agentId, q: query, limit },
    );
    return (result.results ?? []).map((r) => ({
      id: r.id ?? r.memory?.id ?? "",
      content: r.content ?? r.memory?.content ?? "",
      score: r.score ?? r.similarity ?? 0,
      tags: r.tags ?? r.memory?.tags,
    }));
  }

  async getMemory(id: string): Promise<MemoryRecord | null> {
    try {
      return await this.request<MemoryRecord>("GET", `/Memory/${id}`);
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
}

// ---------------------------------------------------------------------------
// Auto-capture heuristics
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  kind: "memory" as const,

  register(api: OpenClawPluginApi): void {
    try {
      const cfg = api.pluginConfig as unknown as FlairMemoryConfig;
      if (!cfg?.agentId) {
        api.logger.error("memory-flair: missing required config field: agentId");
        return;
      }

      const client = new FlairMemoryClient(cfg);
      const maxRecall = cfg.maxRecallResults ?? DEFAULT_MAX_RECALL;
      const autoCapture = cfg.autoCapture ?? true;
      const autoRecall = cfg.autoRecall ?? true;

      api.logger.info(`memory-flair: ready (agent=${cfg.agentId}, url=${cfg.url ?? DEFAULT_URL})`);

      // ── memory_recall ───────────────────────────────────────────────────

      api.registerTool(
        {
          name: "memory_recall",
          label: "Memory Recall",
          description:
            "Search long-term memory via Flair semantic search. Use when you need context about user preferences, past decisions, or previously discussed topics.",
          parameters: Type.Object({
            query: Type.String({ description: "Search query" }),
            limit: Type.Optional(
              Type.Number({ description: "Max results (default: 5)" }),
            ),
          }),
          async execute(_id, params) {
            const { query, limit = maxRecall } = params as {
              query: string;
              limit?: number;
            };
            try {
              const results = await client.searchMemories(query, limit);
              if (results.length === 0) {
                return {
                  content: [{ type: "text", text: "No relevant memories found." }],
                  details: { count: 0 },
                };
              }
              const text = results
                .map((r, i) => `${i + 1}. ${r.content} (${(r.score * 100).toFixed(0)}%)`)
                .join("\n");
              return {
                content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
                details: { count: results.length, memories: results },
              };
            } catch (err: unknown) {
              api.logger.warn(`memory-flair: recall failed: ${(err as Error).message}`);
              return {
                content: [{ type: "text", text: `Memory recall unavailable: ${(err as Error).message}` }],
                details: { count: 0 },
              };
            }
          },
        },
        { name: "memory_recall" },
      );

      // ── memory_store ────────────────────────────────────────────────────

      api.registerTool(
        {
          name: "memory_store",
          label: "Memory Store",
          description:
            "Save important information in long-term memory via Flair. Use for preferences, facts, decisions, and key context.",
          parameters: Type.Object({
            text: Type.String({ description: "Information to remember" }),
            importance: Type.Optional(
              Type.Number({ description: "Importance 0-1 (default: 0.7)" }),
            ),
            tags: Type.Optional(
              Type.Array(Type.String(), { description: "Optional tags" }),
            ),
            durability: Type.Optional(
              Type.Union(
                [
                  Type.Literal("permanent"),
                  Type.Literal("persistent"),
                  Type.Literal("standard"),
                  Type.Literal("ephemeral"),
                ],
                {
                  description:
                    "Memory durability: permanent (inviolable), persistent (key decisions), standard (default), ephemeral (auto-expires)",
                },
              ),
            ),
            type: Type.Optional(
              Type.Union(
                [
                  Type.Literal("session"),
                  Type.Literal("lesson"),
                  Type.Literal("decision"),
                  Type.Literal("preference"),
                  Type.Literal("fact"),
                  Type.Literal("goal"),
                ],
                { description: "Memory type for categorization" },
              ),
            ),
            supersedes: Type.Optional(
              Type.String({ description: "ID of memory this replaces (creates version chain)" }),
            ),
          }),
          async execute(_id, params) {
            const { text, tags, durability, type, supersedes } = params as {
              text: string;
              importance?: number;
              tags?: string[];
              durability?: string;
              type?: string;
              supersedes?: string;
            };
            // Agents cannot write permanent — silently downgrade to persistent
            const effectiveDurability =
              durability === "permanent" ? "persistent" : durability;
            const memId = `${cfg.agentId}-${Date.now()}`;
            try {
              await client.writeMemory(memId, text, {
                tags,
                durability: effectiveDurability,
                type,
                supersedes,
              });
              return {
                content: [{ type: "text", text: `Memory stored (id: ${memId})` }],
                details: { id: memId },
              };
            } catch (err: unknown) {
              api.logger.warn(`memory-flair: store failed: ${(err as Error).message}`);
              return {
                content: [
                  {
                    type: "text",
                    text: `Memory store unavailable: ${(err as Error).message}`,
                  },
                ],
                details: {},
              };
            }
          },
        },
        { name: "memory_store" },
      );

      // ── memory_get ──────────────────────────────────────────────────────

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
              const mem = await client.getMemory(id);
              if (!mem) {
                return {
                  content: [{ type: "text", text: `Memory ${id} not found.` }],
                  details: {},
                };
              }
              return {
                content: [{ type: "text", text: mem.content }],
                details: mem,
              };
            } catch (err: unknown) {
              return {
                content: [
                  { type: "text", text: `Memory get failed: ${(err as Error).message}` },
                ],
                details: {},
              };
            }
          },
        },
        { name: "memory_get" },
      );

      // ── Lifecycle: auto-recall on session start ─────────────────────────

      if (autoRecall) {
        api.on("before_agent_start", async (event) => {
          try {
            const context = await client.bootstrap({ days: 7 });
            if (context?.trim()) {
              const maxChars = (cfg.maxBootstrapTokens ?? DEFAULT_MAX_BOOTSTRAP_TOKENS) * 4;
              const truncated = context.slice(0, maxChars);
              (event as unknown as { injectContext?: (ctx: string) => void }).injectContext?.(
                `\n## Memory Context (from Flair)\n\n${truncated}\n`,
              );
              api.logger.info(
                `memory-flair: injected bootstrap context (${context.length} chars)`,
              );
            }
          } catch (err: unknown) {
            api.logger.warn(
              `memory-flair: bootstrap failed: ${(err as Error).message}`,
            );
          }
        });
      }

      // ── Lifecycle: auto-capture on session end ──────────────────────────

      if (autoCapture) {
        api.on("agent_end", async (event) => {
          try {
            const messages = (event.messages ?? []) as Array<{
              role: string;
              content?: string;
            }>;
            let stored = 0;
            for (const msg of messages) {
              if (msg.role !== "user" && msg.role !== "assistant") continue;
              const text = typeof msg.content === "string" ? msg.content : "";
              if (!text || !shouldCapture(text)) continue;
              const excerpt = excerptForCapture(text);
              const memId = `${cfg.agentId}-${Date.now()}-${stored}`;
              await client.writeMemory(memId, excerpt, {
                type: "session",
                tags: ["auto-captured"],
              });
              stored++;
              if (stored >= 3) break; // cap at 3 per session end
            }
            if (stored > 0) {
              api.logger.info(`memory-flair: auto-captured ${stored} memories`);
            }
          } catch (err: unknown) {
            api.logger.warn(
              `memory-flair: auto-capture failed: ${(err as Error).message}`,
            );
          }
        });
      }
    } catch (err: unknown) {
      api.logger.error(`memory-flair register error: ${(err as Error).message}`);
      throw err;
    }
  },
};

export default plugin;
