/**
 * Stdio adapter bindings (flair#1580).
 *
 * The tool SET is derived from STDIO_TOOL_DESCRIPTORS. This module only
 * supplies FlairClient HTTP handlers — one per stdio descriptor. A new
 * descriptor with no handler (or a handler with no descriptor) fails at
 * registration, so the surfaces cannot drift by omission.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { FlairClient } from "@tpsdev-ai/flair-client";
import {
  STDIO_TOOL_DESCRIPTORS,
  toStdioMcpToolDef,
} from "@tpsdev-ai/flair-tool-descriptors";
import { classifyError } from "./errors.js";
import { jsonSchemaToZodShape } from "./json-schema-zod.js";
import { deriveActivity, type PresenceActivity } from "./presence.js";
import { buildRecordUsageBody, citationIds, withCiteNudge } from "./usage.js";
import {
  buildSkillSearchBody,
  buildSkillStoreBody,
  formatSkillCatalog,
  isSkillRecord,
  projectSkillSearchResponse,
  stripInternalMemoryFields,
} from "./skills.js";

export interface AdapterContext {
  flair: FlairClient;
  agentId: string;
  heartbeat: (activity?: PresenceActivity) => void;
  rememberTask: (task: string | undefined) => void;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

type StdioHandler = (args: Record<string, any>, ctx: AdapterContext) => Promise<ToolResult>;

function errorResult(err: unknown, flairUrl: string): ToolResult {
  return { content: [{ type: "text", text: classifyError(err, flairUrl) }], isError: true };
}

const memory_search: StdioHandler = async ({ query, limit }, { flair, heartbeat }) => {
  heartbeat();
  try {
    const results = await flair.memory.search(query, { limit: limit ?? 5 });
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
    return { content: [{ type: "text", text: withCiteNudge(text) }] };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const memory_store: StdioHandler = async (
  { content, type, durability, tags, visibility, usedMemoryIds },
  { flair, heartbeat },
) => {
  heartbeat();
  try {
    const result = await flair.memory.write(content, {
      type: (type ?? "session") as any,
      durability: (durability ?? "standard") as any,
      tags,
      visibility: visibility as any,
      dedup: true,
      dedupThreshold: 0.95,
      usedMemoryIds: citationIds(usedMemoryIds),
    });
    const deduplicated = (result as any).deduplicated === true;
    const matchedId = (result as any).matchedId as string | undefined;
    const effectiveVisibility = (result as any).visibility as string | undefined;
    const preview = content.length > 120 ? content.slice(0, 120) + "..." : content;
    const tagStr = tags && tags.length > 0 ? tags.join(", ") : "none";
    const lines = [
      `Memory stored (id: ${result.id})`,
      `Preview: ${preview}`,
      `Size: ${content.length} chars`,
      `Tags: ${tagStr}`,
      `Type: ${type ?? "session"}, Durability: ${durability ?? "standard"}, Visibility: ${effectiveVisibility ?? "(server default)"}`,
    ];
    if (deduplicated && matchedId) {
      lines.push(
        "",
        `Note: similar to existing memory id=${matchedId} — both are kept. ` +
          `If this was meant to UPDATE that memory rather than add a new one, use memory_update instead.`,
      );
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { deduplicated, id: result.id, written: true, ...(deduplicated ? { matchedId } : {}) },
    };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const memory_update: StdioHandler = async (
  { id, content, preserveHistory, usedMemoryIds },
  { flair, heartbeat },
) => {
  heartbeat();
  try {
    const result = await flair.memory.update(id, content, {
      preserveHistory,
      usedMemoryIds: citationIds(usedMemoryIds),
    });
    const text = preserveHistory
      ? `Memory updated: new version stored (id: ${result.id}), supersedes ${id}.`
      : `Memory updated (id: ${id}).`;
    return {
      content: [{ type: "text", text }],
      structuredContent: { id: result.id, supersedes: preserveHistory ? id : undefined, written: true },
    };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const memory_get: StdioHandler = async ({ id }, { flair, heartbeat }) => {
  heartbeat();
  try {
    const mem = await flair.memory.get(id);
    if (!mem) return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
    return { content: [{ type: "text", text: `${mem.content}\n\n(type: ${mem.type}, durability: ${mem.durability}, created: ${mem.createdAt})` }] };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const memory_delete: StdioHandler = async ({ id }, { flair, heartbeat }) => {
  heartbeat();
  try {
    await flair.memory.delete(id);
    return { content: [{ type: "text", text: `Memory ${id} deleted.` }] };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const relationship_store: StdioHandler = async (
  { subject, predicate, object, confidence, validFrom, validTo, source },
  { flair, heartbeat },
) => {
  heartbeat();
  try {
    const result = await flair.relationship.write({ subject, predicate, object, confidence, validFrom, validTo, source });
    const confStr = confidence !== undefined ? ` (confidence: ${confidence})` : "";
    return {
      content: [{ type: "text", text: `Relationship recorded: ${subject} → ${predicate} → ${object}${confStr} (id: ${result.id})` }],
      structuredContent: { id: result.id, subject, predicate, object, written: true },
    };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const bootstrap: StdioHandler = async (
  { maxTokens, currentTask, channel, surface, subjects },
  { flair, heartbeat, rememberTask },
) => {
  if (currentTask) rememberTask(currentTask);
  heartbeat(deriveActivity({ channel, surface }));
  try {
    const result = await flair.bootstrap({ maxTokens, currentTask, channel, surface, subjects });
    if (!result.context) {
      return { content: [{ type: "text", text: "No context available." }] };
    }
    return { content: [{ type: "text", text: withCiteNudge(result.context) }] };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const soul_set: StdioHandler = async ({ key, value }, { flair, heartbeat }) => {
  heartbeat();
  try {
    await flair.soul.set(key, value);
    return { content: [{ type: "text", text: `Soul entry '${key}' set.` }] };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const soul_get: StdioHandler = async ({ key }, { flair, heartbeat }) => {
  heartbeat();
  try {
    const entry = await flair.soul.get(key);
    if (!entry) return { content: [{ type: "text", text: `No soul entry for '${key}'.` }] };
    return { content: [{ type: "text", text: entry.value }] };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const flair_workspace_set: StdioHandler = async (
  { ref, label, provider, task, phase, summary },
  { flair, agentId, heartbeat },
) => {
  heartbeat();
  try {
    const body: Record<string, unknown> = {
      id: `${agentId}:${ref}`,
      ref,
      provider: provider ?? "mcp",
      timestamp: new Date().toISOString(),
    };
    if (label) body.label = label;
    if (task) body.taskId = task;
    if (phase) body.phase = phase;
    if (summary) body.summary = summary;
    await flair.request("POST", "/WorkspaceState", body);
    return { content: [{ type: "text", text: `Workspace state set: ref=${ref}${phase ? `, phase=${phase}` : ""} (attributed to ${agentId}).` }] };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const flair_orgevent: StdioHandler = async (
  { kind, summary, detail, scope, targets },
  { flair, agentId, heartbeat },
) => {
  heartbeat();
  try {
    const body: Record<string, unknown> = { kind, summary };
    if (detail) body.detail = detail;
    if (scope) body.scope = scope;
    if (targets && targets.length > 0) body.targetIds = targets;
    const result = await flair.request<{ id?: string }>("POST", "/OrgEvent", body);
    const targetStr = targets && targets.length > 0 ? ` → ${targets.join(", ")}` : "";
    const idStr = result?.id ? ` (id: ${result.id})` : "";
    return { content: [{ type: "text", text: `OrgEvent published: kind=${kind}${targetStr} (attributed to ${agentId})${idStr}.` }] };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const record_usage: StdioHandler = async ({ memoryId, memoryIds, attribution }, { flair, heartbeat }) => {
  heartbeat();
  try {
    const body = buildRecordUsageBody({ memoryId, memoryIds, attribution });
    if (!body) {
      return {
        content: [{ type: "text", text: "record_usage requires memoryId or memoryIds." }],
        isError: true,
      };
    }
    const result = await flair.request<{ recorded?: boolean }>("POST", "/RecordUsage", body);
    const text = result?.recorded === true ? "Usage recorded." : "Usage request accepted.";
    return {
      content: [{ type: "text", text }],
      structuredContent: { recorded: result?.recorded === true },
    };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const skill_store: StdioHandler = async (
  { content, trigger, name, description, tags },
  { flair, heartbeat },
) => {
  heartbeat();
  try {
    const { id, body } = buildSkillStoreBody({
      agentId: flair.agentId,
      content,
      trigger,
      name,
      description,
      tags,
      claimedClient: flair.claimedClient,
    });
    const result = await flair.request<Record<string, unknown>>("PUT", `/Memory/${id}`, body);
    const writtenId = typeof result?.id === "string" && result.id.length > 0 ? result.id : id;
    const preview = content.length > 120 ? content.slice(0, 120) + "..." : content;
    const lines = [
      `Skill stored (id: ${writtenId})`,
      `Preview: ${preview}`,
      name ? `Name: ${name}` : undefined,
      trigger ? `Trigger: ${trigger}` : undefined,
    ].filter((line): line is string => line != null);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { id: writtenId, written: true },
    };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const skill_search: StdioHandler = async ({ task, limit }, { flair, heartbeat }) => {
  heartbeat();
  try {
    const raw = await flair.request("POST", "/SemanticSearch", buildSkillSearchBody({ task, limit: limit ?? 5 }));
    const projected = projectSkillSearchResponse(raw);
    if (!projected || typeof projected !== "object" || !Array.isArray((projected as { results?: unknown }).results)) {
      return { content: [{ type: "text", text: "No matching skills found." }] };
    }
    const results = (projected as { results: Array<Record<string, unknown>> }).results;
    return {
      content: [{ type: "text", text: formatSkillCatalog(results) }],
      structuredContent: { results },
    };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

const skill_get: StdioHandler = async ({ id }, { flair, heartbeat }) => {
  heartbeat();
  try {
    const mem = await flair.memory.get(id);
    if (!mem || !isSkillRecord(mem)) {
      return { content: [{ type: "text", text: `Skill ${id} not found.` }] };
    }
    const record = stripInternalMemoryFields(mem as unknown as Record<string, unknown>);
    const trigger = typeof record.trigger === "string" && record.trigger.length > 0 ? record.trigger : "";
    const text = [
      record.content,
      "",
      `(id: ${record.id}${trigger ? `, trigger: ${trigger}` : ""}, tags: ${Array.isArray(record.tags) ? record.tags.join(", ") : "skill"}, created: ${record.createdAt ?? ""})`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: record,
    };
  } catch (err) {
    return errorResult(err, flair.url);
  }
};

/** FlairClient bindings keyed by descriptor name — the adapter-side impl map. */
export const STDIO_TOOL_HANDLERS: Record<string, StdioHandler> = {
  memory_search,
  memory_store,
  memory_update,
  memory_get,
  memory_delete,
  relationship_store,
  bootstrap,
  soul_set,
  soul_get,
  flair_workspace_set,
  flair_orgevent,
  record_usage,
  skill_store,
  skill_search,
  skill_get,
};

export function stdioHandlerNames(): string[] {
  return Object.keys(STDIO_TOOL_HANDLERS).sort();
}

/**
 * Register every stdio descriptor on the MCP server. The advertised set is
 * STDIO_TOOL_DESCRIPTORS — not a hand-written per-tool literal list.
 */
export function registerStdioTools(server: McpServer, ctx: AdapterContext): string[] {
  const registered: string[] = [];
  const missing: string[] = [];
  for (const d of STDIO_TOOL_DESCRIPTORS) {
    const handler = STDIO_TOOL_HANDLERS[d.name];
    if (!handler) {
      missing.push(d.name);
      continue;
    }
    const def = toStdioMcpToolDef(d);
    const shape = jsonSchemaToZodShape(def.inputSchema);
    const cb = async (args: Record<string, any>) => handler(args, ctx);
    if (d.annotations) {
      server.tool(d.name, def.description, shape, d.annotations as ToolAnnotations, cb);
    } else {
      server.tool(d.name, def.description, shape, cb);
    }
    registered.push(d.name);
  }
  if (missing.length > 0) {
    throw new Error(`stdio adapter missing FlairClient bindings for descriptors: ${missing.join(", ")}`);
  }
  const extra = Object.keys(STDIO_TOOL_HANDLERS).filter((n) => !registered.includes(n)).sort();
  if (extra.length > 0) {
    throw new Error(`stdio adapter bindings have no stdio descriptor: ${extra.join(", ")}`);
  }
  return registered;
}
