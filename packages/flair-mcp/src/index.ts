#!/usr/bin/env node

/**
 * Flair MCP Server — persistent memory for Claude Code and any MCP client.
 *
 * Tools:
 *   - memory_search  — semantic search across memories
 *   - memory_store   — save a memory with type + durability
 *   - memory_get     — retrieve a specific memory by ID
 *   - memory_delete  — delete a memory
 *   - bootstrap      — cold-start context (soul + recent memories)
 *   - soul_set       — set a personality/context entry
 *   - soul_get       — get a personality/context entry
 *
 * Usage:
 *   npx @tpsdev-ai/flair-mcp
 *
 * Claude Code .mcp.json:
 *   { "mcpServers": { "flair": { "command": "npx", "args": ["@tpsdev-ai/flair-mcp"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FlairClient, FlairError } from "@tpsdev-ai/flair-client";
import { z } from "zod";

// ─── Error helpers ──────────────────────────────────────────────────────────

function classifyError(err: unknown, flairUrl: string): string {
  if (err instanceof FlairError) {
    const { status, body } = err;
    if (status === 400) return `validation_error: ${body}`;
    if (status === 401 || status === 403) {
      // Auth failure on a previously-working session usually means the daemon
      // restarted (config reload, Harper alter_user, port change). Tell the
      // operator how to recover instead of just surfacing the raw 401 body.
      return `auth_error: ${body}\n` +
        `(Hint: this often follows a Flair daemon restart. Try:\n` +
        `  1. Restart your MCP host (Claude Code, Cursor, etc) to spawn a fresh flair-mcp.\n` +
        `  2. Check daemon: 'flair status' or 'curl ${flairUrl}/Health'.\n` +
        `  3. Verify your agent key still matches the registered Agent record.)`;
    }
    if (status === 413) return `payload_too_large: ${body}`;
    if (status === 429) return "rate_limited — retry after a moment";
    if (status >= 500) return `server_error (retriable): ${body}`;
    return `http_error (${status}): ${body}`;
  }
  if (err instanceof Error) {
    if (err.name.includes("Abort") || err.name.includes("Timeout")) {
      return "timeout — the server took too long. This often happens with large content that requires embedding. Try shorter content or retry.";
    }
    if (err instanceof TypeError && err.message.includes("fetch")) {
      return `connection_error (retriable): could not reach Flair at ${flairUrl}. Is it running?\n` +
        `(Diagnostics:\n` +
        `  - 'curl ${flairUrl}/Health' — if this responds 200 or 401, daemon is up + this is an auth issue not a connection one.\n` +
        `  - 'launchctl list | grep flair' (macOS) or 'systemctl status flair' (Linux).)`;
    }
    return `unexpected_error: ${err.message}`;
  }
  return `unexpected_error: ${String(err)}`;
}

function errorResult(err: unknown, flairUrl: string) {
  return { content: [{ type: "text" as const, text: classifyError(err, flairUrl) }], isError: true };
}

// ─── Parent-exit watcher ────────────────────────────────────────────────────
//
// flair-mcp runs as a child of an MCP host (Claude Code, Cursor, etc) over
// stdio. When the host exits cleanly it should close stdin/stdout — but in
// practice we've seen flair-mcp processes orphaned for weeks (PID 1 as
// parent), holding stale tokens and consuming RAM.
//
// Poll process.ppid every 5s. If it drops to 1 (init), the parent died and
// we got reparented — exit cleanly. Cheap, cross-platform, no native deps.

// Clamp the poll interval to a safe range. `process.env.FOO ?? 5000` is NOT
// safe on its own: `??` only falls through on null/undefined, so an empty-string
// override (`FLAIR_MCP_PARENT_POLL_MS=`) yields `Number("") === 0` and creates
// a tight CPU-busy loop. Validate explicitly. (Sherlock review on #315.)
const PARENT_POLL_INTERVAL_MS = (() => {
  const raw = process.env.FLAIR_MCP_PARENT_POLL_MS;
  const parsed = raw != null ? Number(raw) : NaN;
  const FLOOR_MS = 100;
  const CEILING_MS = 30_000;
  return Number.isFinite(parsed) && parsed >= FLOOR_MS && parsed <= CEILING_MS
    ? parsed
    : 5000;
})();
const initialPpid = process.ppid;
setInterval(() => {
  // ppid === 1 means init/launchd has adopted us — original parent died.
  if (process.ppid === 1 && initialPpid !== 1) {
    console.error("flair-mcp: parent process died (re-parented to init); exiting cleanly.");
    process.exit(0);
  }
}, PARENT_POLL_INTERVAL_MS).unref();

// Also handle stdin EOF — MCP host closing the pipe means session ended.
// (StdioServerTransport handles this internally for the MCP protocol, but
// belt-and-suspenders: if stdin closes we exit, full stop.)
process.stdin.on("close", () => {
  console.error("flair-mcp: stdin closed; exiting cleanly.");
  process.exit(0);
});
process.stdin.on("end", () => {
  console.error("flair-mcp: stdin EOF; exiting cleanly.");
  process.exit(0);
});

// ─── Client setup ────────────────────────────────────────────────────────────

const agentId = process.env.FLAIR_AGENT_ID;
if (!agentId) {
  console.error("FLAIR_AGENT_ID is required. Set it in your .mcp.json env or shell.");
  process.exit(1);
}

const flair = new FlairClient({
  agentId,
  url: process.env.FLAIR_URL,
  keyPath: process.env.FLAIR_KEY_PATH,
});

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "flair",
  version: "0.1.0",
});

// ─── Tools ───────────────────────────────────────────────────────────────────

server.tool(
  "memory_search",
  "Search memories by meaning. Understands temporal queries like 'what happened today'.",
  {
    query: z.string().describe("Search query — natural language, semantic matching"),
    limit: z.coerce.number().optional().default(5).describe("Max results (default 5)"),
  },
  async ({ query, limit }) => {
    try {
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
);

server.tool(
  "memory_store",
  "Save information to persistent memory. Use for lessons, decisions, preferences, facts.",
  {
    content: z.string().describe("What to remember"),
    type: z.enum(["session", "lesson", "decision", "preference", "fact", "goal"]).optional().default("session"),
    durability: z.enum(["permanent", "persistent", "standard", "ephemeral"]).optional().default("standard")
      .describe(
        "permanent — inviolable facts, identity, explicit never-forget (e.g., 'my name is Nathan')\n" +
        "persistent — key decisions and lessons to recall weeks later (e.g., 'PR review process')\n" +
        "standard — default working memory, recent context (e.g., 'discussed auth flow today')\n" +
        "ephemeral — scratch state, auto-expires 72h (e.g., 'currently debugging issue #42')",
      ),
    tags: z.array(z.string()).optional().describe("Array of tag strings"),
  },
  async ({ content, type, durability, tags }) => {
    try {
      const result = await flair.memory.write(content, {
        type: type as any,
        durability: durability as any,
        tags,
        dedup: true,
        dedupThreshold: 0.95,
      });
      // Check if dedup returned an existing memory (different ID than what we generated)
      const generatedPrefix = `${agentId}-`;
      const wasDeduped = result.id && !result.id.startsWith(generatedPrefix);
      if (wasDeduped) {
        return { content: [{ type: "text", text: `Similar memory already exists (id: ${result.id}): ${result.content?.slice(0, 200)}` }] };
      }
      const preview = content.length > 120 ? content.slice(0, 120) + "..." : content;
      const tagStr = tags && tags.length > 0 ? tags.join(", ") : "none";
      const text = [
        `Memory stored (id: ${result.id})`,
        `Preview: ${preview}`,
        `Size: ${content.length} chars`,
        `Tags: ${tagStr}`,
        `Type: ${type}, Durability: ${durability}`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return errorResult(err, flair.url);
    }
  },
);

server.tool(
  "memory_get",
  "Retrieve a specific memory by ID.",
  {
    id: z.string().describe("Memory ID"),
  },
  async ({ id }) => {
    try {
      const mem = await flair.memory.get(id);
      if (!mem) return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
      return { content: [{ type: "text", text: `${mem.content}\n\n(type: ${mem.type}, durability: ${mem.durability}, created: ${mem.createdAt})` }] };
    } catch (err) {
      return errorResult(err, flair.url);
    }
  },
);

server.tool(
  "memory_delete",
  "Delete a memory by ID.",
  {
    id: z.string().describe("Memory ID to delete"),
  },
  async ({ id }) => {
    try {
      await flair.memory.delete(id);
      return { content: [{ type: "text", text: `Memory ${id} deleted.` }] };
    } catch (err) {
      return errorResult(err, flair.url);
    }
  },
);

server.tool(
  "bootstrap",
  "Get session context: soul + memories + predicted context. Run at session start. Pass subjects for predictive loading.",
  {
    maxTokens: z.coerce.number().optional().default(4000).describe("Max tokens in output"),
    currentTask: z.string().optional().describe("Current task description — enables semantic search for relevant memories"),
    channel: z.string().optional().describe("Channel name (discord, tps-mail, claude-code) — shapes context prediction"),
    surface: z.string().optional().describe("Surface name (tps-build, tps-review, cli-session) — narrows prediction"),
    subjects: z.array(z.string()).optional().describe("Entity names to preload context for (e.g., ['flair', 'auth'])"),
  },
  async ({ maxTokens, currentTask, channel, surface, subjects }) => {
    try {
      const result = await flair.bootstrap({ maxTokens, currentTask, channel, surface, subjects });
      if (!result.context) {
        return { content: [{ type: "text", text: "No context available." }] };
      }
      return { content: [{ type: "text", text: result.context }] };
    } catch (err) {
      return errorResult(err, flair.url);
    }
  },
);

server.tool(
  "soul_set",
  "Set a personality or project context entry. Included in every bootstrap.",
  {
    key: z.string().describe("Entry key (e.g., 'role', 'standards', 'project')"),
    value: z.string().describe("Entry value — personality trait, project context, coding standards, etc."),
  },
  async ({ key, value }) => {
    try {
      await flair.soul.set(key, value);
      return { content: [{ type: "text", text: `Soul entry '${key}' set.` }] };
    } catch (err) {
      return errorResult(err, flair.url);
    }
  },
);

server.tool(
  "soul_get",
  "Get a personality or project context entry.",
  {
    key: z.string().describe("Entry key"),
  },
  async ({ key }) => {
    try {
      const entry = await flair.soul.get(key);
      if (!entry) return { content: [{ type: "text", text: `No soul entry for '${key}'.` }] };
      return { content: [{ type: "text", text: entry.value }] };
    } catch (err) {
      return errorResult(err, flair.url);
    }
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
