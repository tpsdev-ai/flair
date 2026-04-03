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
import { FlairClient } from "@tpsdev-ai/flair-client";
import { z } from "zod";

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
  },
);

server.tool(
  "memory_store",
  "Save information to persistent memory. Use for lessons, decisions, preferences, facts.",
  {
    content: z.string().describe("What to remember"),
    type: z.enum(["session", "lesson", "decision", "preference", "fact", "goal"]).optional().default("session"),
    durability: z.enum(["permanent", "persistent", "standard", "ephemeral"]).optional().default("standard")
      .describe("permanent=inviolable, persistent=key decisions, standard=default, ephemeral=auto-expires 72h"),
    tags: z.union([
      z.array(z.string()),
      z.string().transform(s => s.startsWith("[") ? JSON.parse(s) : s.split(",").map(t => t.trim()).filter(Boolean)),
    ]).optional().describe("Optional tags — array or comma-separated string"),
  },
  async ({ content, type, durability, tags }) => {
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
    return { content: [{ type: "text", text: `Memory stored (id: ${result.id})` }] };
  },
);

server.tool(
  "memory_get",
  "Retrieve a specific memory by ID.",
  {
    id: z.string().describe("Memory ID"),
  },
  async ({ id }) => {
    const mem = await flair.memory.get(id);
    if (!mem) return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
    return { content: [{ type: "text", text: `${mem.content}\n\n(type: ${mem.type}, durability: ${mem.durability}, created: ${mem.createdAt})` }] };
  },
);

server.tool(
  "memory_delete",
  "Delete a memory by ID.",
  {
    id: z.string().describe("Memory ID to delete"),
  },
  async ({ id }) => {
    await flair.memory.delete(id);
    return { content: [{ type: "text", text: `Memory ${id} deleted.` }] };
  },
);

server.tool(
  "bootstrap",
  "Get cold-start context: soul + recent memories. Run this at the start of every session.",
  {
    maxTokens: z.coerce.number().optional().default(4000).describe("Max tokens in output"),
  },
  async ({ maxTokens }) => {
    const result = await flair.bootstrap({ maxTokens });
    if (!result.context) {
      return { content: [{ type: "text", text: "No context available." }] };
    }
    return { content: [{ type: "text", text: result.context }] };
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
    await flair.soul.set(key, value);
    return { content: [{ type: "text", text: `Soul entry '${key}' set.` }] };
  },
);

server.tool(
  "soul_get",
  "Get a personality or project context entry.",
  {
    key: z.string().describe("Entry key"),
  },
  async ({ key }) => {
    const entry = await flair.soul.get(key);
    if (!entry) return { content: [{ type: "text", text: `No soul entry for '${key}'.` }] };
    return { content: [{ type: "text", text: entry.value }] };
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
