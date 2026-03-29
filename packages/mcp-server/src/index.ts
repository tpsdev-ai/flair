#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const FLAIR_URL = (process.env.FLAIR_URL || "http://127.0.0.1:9926").replace(/\/$/, "");
const agentIdFromEnv = process.env.FLAIR_AGENT_ID;

if (!agentIdFromEnv) {
  console.error("FLAIR_AGENT_ID is required");
  process.exit(1);
}

const AGENT_ID: string = agentIdFromEnv;

type SearchResult = {
  id?: string;
  content?: string;
  type?: string;
  createdAt?: string;
  _score?: number;
  score?: number;
};

async function postJson(path: string, body: unknown): Promise<any> {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-tps-agent", AGENT_ID);

  const res = await fetch(`${FLAIR_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const server = new McpServer({ name: "flair-mcp-server", version: "0.1.0" });

server.tool(
  "memory_search",
  "Search Flair memories via /SemanticSearch",
  {
    query: z.string(),
    limit: z.number().int().positive().max(20).optional().default(5),
  },
  async ({ query, limit }) => {
    const results = (await postJson("/SemanticSearch", { query, limit, agentId: AGENT_ID })) as SearchResult[];
    if (!Array.isArray(results) || results.length === 0) {
      return { content: [{ type: "text", text: "No memories found." }] };
    }
    const text = results.map((r, i) => {
      const score = typeof (r._score ?? r.score) === "number" ? ` score:${(r._score ?? r.score)!.toFixed(3)}` : "";
      const date = r.createdAt ? ` ${r.createdAt.slice(0, 10)}` : "";
      const type = r.type ? ` ${r.type}` : "";
      const id = r.id ? ` id:${r.id}` : "";
      return `${i + 1}. ${r.content || ""}${date}${type}${id}${score}`.trim();
    }).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "memory_store",
  "Store a memory via /Memory",
  {
    content: z.string(),
    type: z.string().optional().default("session"),
    durability: z.string().optional().default("standard"),
  },
  async ({ content, type, durability }) => {
    const created = await postJson("/Memory", {
      agentId: AGENT_ID,
      content,
      type,
      durability,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return {
      content: [{
        type: "text",
        text: `Memory stored${created?.id ? ` (id: ${created.id})` : ""}`,
      }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
