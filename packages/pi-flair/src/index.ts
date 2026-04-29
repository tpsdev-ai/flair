/**
 * Pi Extension for Flair Memory Access
 *
 * Adds Flair memory tools to pi sessions:
 *   - memory_search(agentId, query, limit)  — semantic search
 *   - memory_store(agentId, content, durability) — save memories
 *   - bootstrap(agentId, maxTokens) — cold-start context
 *
 * Configuration:
 *   - flair_url (default: http://127.0.0.1:9926)
 *   - agentId (required, via FLAIR_AGENT_ID env var)
 *   - max_recall_results (default: 5)
 *   - max_bootstrap_tokens (default: 4000)
 *   - auto_capture (default: false) — auto-save session context to memory
 *   - auto_recall (default: false) — auto-load bootstrap on session start
 *
 * Usage:
 *   1. Install: pi install npm:@tpsdev-ai/pi-flair
 *   2. Configure in ~/.pi/agent/settings.json or .pi/settings.json:
 *      {
 *        "extensions": ["npm:@tpsdev-ai/pi-flair"],
 *        "flair_url": "http://127.0.0.1:9926",
 *        "agentId": "my-project"
 *      }
 *   3. Or use environment variables:
 *      export FLAIR_AGENT_ID=my-agent
 *      export FLAIR_URL=http://127.0.0.1:9926
 *   4. Restart pi
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { FlairClient, FlairError, type FlairClientConfig, type BootstrapResult } from "@tpsdev-ai/flair-client";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface PluginConfig extends FlairClientConfig {
  max_recall_results?: number;
  max_bootstrap_tokens?: number;
  auto_capture?: boolean;
  auto_recall?: boolean;
}

interface MemorySearchParams {
  query: string;
  limit?: number;
}

interface MemoryStoreParams {
  content: string;
  durability?: "permanent" | "persistent" | "standard" | "ephemeral";
}

interface BootstrapParams {
  maxTokens?: number;
}

// ─── Secret Filtering for Auto-Capture ───────────────────────────────────────

// Secret patterns to filter from auto-capture
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]+/gu,                    // OpenAI keys
  /ghp_[a-zA-Z0-9]+/gu,                   // GitHub PATs
  /pat_[a-zA-Z0-9]+/gu,                   // Generic PATs
  /Bearer [a-zA-Z0-9_-]+/gu,              // Bearer tokens
  /-----BEGIN PRIVATE KEY-----/u,         // Private keys
  /-----BEGIN RSA PRIVATE KEY-----/u,     // RSA keys
  /-----BEGIN EC PRIVATE KEY-----/u,      // EC keys
];

function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

// ─── Config Resolution ───────────────────────────────────────────────────────

function getConfig(pi: ExtensionAPI): PluginConfig {
  // Try to load from settings
  // Note: pi doesn't expose settings.json directly in extension API
  // We rely on environment variables and defaults
  const flConfig: FlairClientConfig = {
    url: process.env.FLAIR_URL || "http://127.0.0.1:9926",
    agentId: process.env.FLAIR_AGENT_ID,
    keyPath: process.env.FLAIR_KEY_PATH,
  };
  
  return {
    ...flConfig,
    max_recall_results: parseInt(process.env.FLAIR_MAX_RECALL_RESULTS || "5", 10),
    max_bootstrap_tokens: parseInt(process.env.FLAIR_MAX_BOOTSTRAP_TOKENS || "4000", 10),
    auto_capture: process.env.FLAIR_AUTO_CAPTURE === "true",
    auto_recall: process.env.FLAIR_AUTO_RECALL === "true", // default false (user must explicitly opt-in)
  };
}

function getAgentId(config: PluginConfig, ctx: ExtensionContext): string {
  if (config.agentId) return config.agentId;
  // Try to infer from working directory
  const cwd = ctx.cwd;
  const lastSlash = cwd.lastIndexOf("/");
  if (lastSlash >= 0) {
    return cwd.slice(lastSlash + 1);
  }
  return cwd;
}

function createFlairClient(config: PluginConfig): FlairClient {
  if (!config.agentId) {
    throw new Error("FLAIR_AGENT_ID is required");
  }
  return new FlairClient({
    agentId: config.agentId,
    url: config.url || "http://127.0.0.1:9926",
    keyPath: config.keyPath,
  });
}

// ─── Error Classification ─────────────────────────────────────────────────────

function classifyError(err: unknown, flairUrl: string): string {
  if (err instanceof FlairError) {
    const { status, body } = err;
    if (status === 400) return `validation_error: ${body}`;
    if (status === 401 || status === 403) return `auth_error: ${body}`;
    if (status === 413) return `payload_too_large: ${body}`;
    if (status === 429) return "rate_limited — retry after a moment";
    if (status >= 500) return `server_error (retriable): ${body}`;
    return `http_error (${status}): ${body}`;
  }
  if (err instanceof Error) {
    if (err.name.includes("Abort") || err.name.includes("Timeout")) {
      return "timeout — the server took too long. Try shorter content or retry.";
    }
    if (err instanceof TypeError && err.message.includes("fetch")) {
      return `connection_error (retriable): could not reach Flair at ${flairUrl}. Is it running?`;
    }
    return `unexpected_error: ${err.message}`;
  }
  return `unexpected_error: ${String(err)}`;
}

function errorResult(err: unknown, flairUrl: string) {
  return { content: [{ type: "text" as const, text: classifyError(err, flairUrl) }], isError: true };
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const config = getConfig(pi);
  const flair = createFlairClient(config);

  // ─── Tools ───────────────────────────────────────────────────────────────────

  // memory_search tool
  pi.registerTool({
    name: "memory_search",
    label: "Search Flair Memories",
    description: "Search memories by meaning. Understands temporal queries like 'what happened today'.",
    promptSnippet: "Search Flair memories for relevant context.",
    promptGuidelines: [
      "Use memory_search when you need to recall past conversations, decisions, or lessons from this project.",
      "Use memory_search when the user asks about 'today', 'recently', or 'previously' in this session.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query — natural language, semantic matching" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 5)" }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const query = params.query as string;
        const limit = (params.limit as number | undefined) ?? config.max_recall_results;
        const results = await flair.memory.search(query, { limit });
        if (results.length === 0) {
          return { content: [{ type: "text", text: "No relevant memories found." }] };
        }
        const text = results
          .map((r, i) => {
            const date = r.createdAt ? r.createdAt.slice(0, 10) : "";
            const idStr = r.id ? `id:${r.id}` : "";
            const meta = [date, r.type, idStr].filter(Boolean).join(", ");
            return `${i + 1}. ${r.content}${meta ? ` (${meta})` : ""}`;
          })
          .join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err, flair.url);
      }
    },
  });

  // memory_store tool
  pi.registerTool({
    name: "memory_store",
    label: "Store Memory in Flair",
    description: "Save information to persistent memory. Use for lessons, decisions, preferences, facts.",
    promptSnippet: "Store memories for future recall.",
    promptGuidelines: [
      "Use memory_store to record important decisions, lessons learned, or preferences.",
      "Use memory_store before finishing a session to capture key insights.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "What to remember" }),
      durability: Type.Optional(
        Type.String({ 
          enum: ["permanent", "persistent", "standard", "ephemeral"] as const,
          description:
            "permanent — inviolable facts, identity, explicit never-forget (e.g., 'my name is Nathan')\n" +
            "persistent — key decisions and lessons to recall weeks later (e.g., 'PR review process')\n" +
            "standard — default working memory, recent context (e.g., 'discussed auth flow today')\n" +
            "ephemeral — scratch state, auto-expires 72h (e.g., 'currently debugging issue #42')",
        }),
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Array of tag strings" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const content = params.content as string;
        const durability = (params.durability as "permanent" | "persistent" | "standard" | "ephemeral") || "standard";
        
        const result = await flair.memory.write(content, {
          type: "session" as const,
          durability: durability,
          tags: params.tags as string[] | undefined,
          dedup: true,
          dedupThreshold: 0.95,
        });
        
        // Check if dedup returned an existing memory
        const agentId = getAgentId(config, ctx);
        const generatedPrefix = `${agentId}-`;
        const wasDeduped = result.id && !result.id.startsWith(generatedPrefix);
        
        if (wasDeduped) {
          return { content: [{ type: "text", text: `Similar memory already exists (id: ${result.id}): ${result.content?.slice(0, 200)}` }] };
        }
        
        const preview = content.length > 120 ? content.slice(0, 120) + "..." : content;
        const tagStr = (params.tags as string[] | undefined)?.length ? (params.tags as string[]).join(", ") : "none";
        const text = [
          `Memory stored (id: ${result.id})`,
          `Preview: ${preview}`,
          `Size: ${content.length} chars`,
          `Tags: ${tagStr}`,
          `Durability: ${durability}`,
        ].join("\n");
        
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err, flair.url);
      }
    },
  });

  // bootstrap tool
  pi.registerTool({
    name: "bootstrap",
    label: "Bootstrap Flair Context",
    description: "Get session context: soul + memories + predicted context. Run at session start.",
    promptSnippet: "Load session context from Flair.",
    promptGuidelines: [
      "Call bootstrap at the start of a new session to load relevant past memories.",
      "Only call bootstrap once per session — it's expensive.",
    ],
    parameters: Type.Object({
      maxTokens: Type.Optional(
        Type.Number({ description: "Max tokens in output (default 4000)" }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const maxTokens = (params.maxTokens as number | undefined) ?? config.max_bootstrap_tokens;
        const result = await flair.bootstrap({ maxTokens });
        if (!result.context) {
          return { content: [{ type: "text", text: "No context available." }] };
        }
        return { content: [{ type: "text", text: result.context }] };
      } catch (err) {
        return errorResult(err, flair.url);
      }
    },
  });

  // ─── Auto-Recall on Session Start ────────────────────────────────────────────

  if (config.auto_recall !== false) {
    pi.on("session_start", async (_event, ctx) => {
      // In auto_recall mode, inject bootstrap context via before_agent_start
      // This gives the LLM relevant memories at session start
      ctx.ui.notify("Flair: loading session context...", "info");
      
      try {
        const maxTokens = config.max_bootstrap_tokens ?? 4000;
        const result = await flair.bootstrap({ maxTokens });
        
        if (result.context) {
          // Inject a system message with the context
          pi.appendEntry("flair-bootstrap", {
            context: result.context,
            timestamp: Date.now(),
          });
          
          ctx.ui.notify("Flair: context loaded", "success");
        } else {
          ctx.ui.notify("Flair: no context available", "info");
        }
      } catch (err) {
        ctx.ui.notify(`Flair bootstrap failed: ${classifyError(err, flair.url)}`, "error");
      }
    });
  }

  // ─── Auto-Capture on Turn End (optional) ────────────────────────────────────

  if (config.auto_capture === true) {
    pi.on("turn_end", async (_event, ctx) => {
      // Extract key insights from the turn and store them
      // This is a simplified version — real implementation would parse the conversation
      const branch = ctx.sessionManager.getBranch();
      if (branch.length >= 2) {
        const lastEntry = branch[branch.length - 2];
        if (lastEntry.role === "assistant" && lastEntry.content) {
          // Convert to string for storage
          const content = JSON.stringify(lastEntry.content);
          
          // Filter out content containing secrets
          if (containsSecrets(content)) {
            console.warn("Auto-capture skipped: potential secrets detected");
            return;
          }
          
          if (content.length > 100) {
            try {
              await flair.memory.write(content.slice(0, 4000), {
                type: "session" as const,
                durability: "ephemeral" as const,
                dedup: false,
              });
            } catch (err) {
              // Silently fail — auto-capture is best-effort
              console.warn("Auto-capture failed:", classifyError(err, flair.url));
            }
          }
        }
      }
    });
  }
}

// ─── Helper for manual bootstrap injection ────────────────────────────────────

export async function manualBootstrap(
  config: PluginConfig,
  maxTokens = 4000,
): Promise<string> {
  const flair = createFlairClient(config);
  const result = await flair.bootstrap({ maxTokens });
  return result.context || "No context available.";
}
