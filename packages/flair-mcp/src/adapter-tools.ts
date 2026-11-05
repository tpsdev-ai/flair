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
import { encodeRecordId } from "./record-id-path.js";
import {
  STDIO_TOOL_DESCRIPTORS,
  toStdioMcpToolDef,
} from "./tool-descriptors/index.js";
import { buildCatchupRequest, summarizeCatchup, type CatchupPage } from "./catchup.js";
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

/** The redaction count a write result reports (flair#2407), 0 when absent. */
function redactedValuesOf(result: unknown): number {
  const value = (result as { redactedValues?: unknown } | null)?.redactedValues;
  return typeof value === "number" && value > 0 ? value : 0;
}

/**
 * flair#2467 — the text a write reply previews, or null for no preview. The
 * reply shows the first 120 characters of it, followed by `...` when
 * truncated (previewOf).
 *
 * With a positive redaction count, the text is only the result's `content`:
 * the post-redaction content the write response returned in `stored` (equal
 * to the input when the redaction changed only another field). A result
 * marked `contentWithheld`, or with no `content` string, gets null: the reply
 * states the redacted-value count and that the stored text was not returned,
 * and never shows the input. With no count (the server reported no
 * replacement), the text is the result's `content`, else the input.
 *
 * flair#2541 — `field` "trigger" applies the same rule to a skill's trigger:
 * with a count, only the result's stored `trigger` (null when the result is
 * withheld or carries none), never the input.
 */
function storedTextOf(
  result: unknown,
  input: string,
  redactedValues: number,
  field: "content" | "trigger" = "content",
): string | null {
  const written = result as { content?: unknown; trigger?: unknown; contentWithheld?: unknown } | null;
  const value = written?.[field];
  if (redactedValues > 0) {
    return written?.contentWithheld !== true && typeof written?.content === "string" && typeof value === "string"
      ? value
      : null;
  }
  return typeof value === "string" ? value : input;
}

/**
 * flair#2541 — skill_store writes with a raw PUT /Memory (flair.request), so
 * its result is the server's response, where a redacted write's stored text
 * sits in `stored` rather than at the top level of a flair.memory.write
 * result. This returns that text in the shape storedTextOf reads, as
 * flair-client does for memory_store: `stored.content` and `stored.trigger`,
 * plus the skill's `stored.name`/`stored.description`/`stored.tags`
 * (flair#2575), or `contentWithheld: true` when `stored` carries no `content`
 * string. With no redaction count it returns null, so the reply previews the
 * input as before.
 */
function storedWriteOf(response: unknown, redactedValues: number): Record<string, unknown> | null {
  if (redactedValues <= 0) return null;
  const stored = (response as { stored?: unknown } | null)?.stored;
  const text = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : null;
  if (typeof text?.content !== "string") return { contentWithheld: true };
  const out: Record<string, unknown> = { content: text.content };
  for (const field of ["trigger", "name", "description"] as const) {
    if (typeof text[field] === "string") out[field] = text[field];
  }
  if (Array.isArray(text.tags)) out.tags = text.tags;
  return out;
}

/** The skill_store reply's `Name:` line after a redaction comes from the stored
 *  `name` (never the input); with no count, from the input as before. */
function storedNameOf(written: Record<string, unknown> | null, inputName: unknown, redactedValues: number): string | null {
  if (redactedValues > 0) return typeof written?.name === "string" ? (written.name as string) : null;
  return typeof inputName === "string" && inputName.length > 0 ? inputName : null;
}

/** The preview line for a counted redaction whose stored text was not
 *  returned. It states only what the response says: how many values were
 *  replaced in this write, not which field held them. */
function withheldPreview(redactedValues: number): string {
  return `Preview: none. The server redacted ${redactedValues} value(s) in this write; the stored text was not returned.`;
}

function previewOf(text: string): string {
  return text.length > 120 ? text.slice(0, 120) + "..." : text;
}

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
    const redactedValues = redactedValuesOf(result);
    // flair#2467 — with a redaction count, the preview comes only from the
    // stored content the write response returned (storedTextOf).
    const stored = storedTextOf(result, content, redactedValues);
    const tagStr = tags && tags.length > 0 ? tags.join(", ") : "none";
    const lines = [
      `Memory stored (id: ${result.id})`,
      ...(stored === null ? [withheldPreview(redactedValues)] : [`Preview: ${previewOf(stored)}`, `Size: ${stored.length} chars`]),
      `Tags: ${tagStr}`,
      `Type: ${type ?? "session"}, Durability: ${durability ?? "standard"}, Visibility: ${effectiveVisibility ?? "(server default)"}`,
    ];
    if (redactedValues > 0) {
      lines.push(`Redacted ${redactedValues} credential-shaped value(s) before storing.`);
    }
    if (deduplicated && matchedId) {
      lines.push(
        "",
        `Note: similar to existing memory id=${matchedId} — both are kept. ` +
          `If this was meant to UPDATE that memory rather than add a new one, use memory_update instead.`,
      );
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        deduplicated,
        id: result.id,
        written: true,
        ...(redactedValues > 0 ? { redactedValues } : {}),
        ...(stored === null ? { contentWithheld: true } : {}),
        ...(deduplicated ? { matchedId } : {}),
      },
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
    const redactedValues = redactedValuesOf(result);
    // flair#2467 — with a redaction count, the preview comes only from the
    // stored content the write response returned (storedTextOf).
    const stored = storedTextOf(result, content, redactedValues);
    const lines = [
      preserveHistory
        ? `Memory updated: new version stored (id: ${result.id}), supersedes ${id}.`
        : `Memory updated (id: ${id}).`,
      stored === null ? withheldPreview(redactedValues) : `Preview: ${previewOf(stored)}`,
    ];
    if (redactedValues > 0) {
      lines.push(`Redacted ${redactedValues} credential-shaped value(s) before storing.`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        id: result.id,
        supersedes: preserveHistory ? id : undefined,
        written: true,
        ...(redactedValues > 0 ? { redactedValues } : {}),
        ...(stored === null ? { contentWithheld: true } : {}),
      },
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

const flair_catchup: StdioHandler = async (args, { flair, agentId, heartbeat }) => {
  heartbeat();
  try {
    // Owner-scope by construction: the request path is built from the CALLER's
    // own agentId (identity), never a tool argument — `args` is consulted only
    // for after/limit/ack. There is deliberately no agentId/participantId
    // parameter, so a caller cannot name another feed (the server also refuses
    // a cross-agent read with 403).
    const request = buildCatchupRequest(agentId, args);
    if (request.ackPosition) {
      // Advance-on-ack (monotonic, re-ack safe) BEFORE the read, so a caller
      // draining page N while acking page N-1 reads page N — and an ack never
      // hides an event that was in the same response.
      await flair.request("POST", request.ackPath, { position: request.ackPosition });
    }
    const page = await flair.request<CatchupPage>("GET", request.getPath);
    const { text, structuredContent } = summarizeCatchup(page, request.ackPosition);
    return { content: [{ type: "text", text }], structuredContent };
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
    const result = await flair.request<Record<string, unknown>>("PUT", `/Memory/${encodeRecordId(id)}`, body);
    const writtenId = typeof result?.id === "string" && result.id.length > 0 ? result.id : id;
    const redactedValues = redactedValuesOf(result);
    // flair#2541 — with a redaction count, the preview and the trigger line
    // come only from the stored text the write response returned
    // (storedWriteOf, storedTextOf), never the input; flair#2575 — the name
    // line comes from the stored `name` the same way.
    const written = storedWriteOf(result, redactedValues);
    const stored = storedTextOf(written, content, redactedValues);
    const storedTrigger = storedTextOf(written, trigger ?? "", redactedValues, "trigger");
    const storedName = storedNameOf(written, name, redactedValues);
    const lines = [
      `Skill stored (id: ${writtenId})`,
      stored === null ? withheldPreview(redactedValues) : `Preview: ${previewOf(stored)}`,
      storedName ? `Name: ${storedName}` : undefined,
      storedTrigger ? `Trigger: ${storedTrigger}` : undefined,
      redactedValues > 0 ? `Redacted ${redactedValues} credential-shaped value(s) before storing.` : undefined,
    ].filter((line): line is string => line != null);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        id: writtenId,
        written: true,
        ...(redactedValues > 0 ? { redactedValues } : {}),
        ...(stored === null ? { contentWithheld: true } : {}),
      },
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

const team_directory: StdioHandler = async ({ id, name, cursor, limit }, { flair, heartbeat }) => {
  heartbeat();
  try {
    const result = await flair.teamDirectory.list({ id, name, cursor, limit });
    const entries: any[] = Array.isArray(result?.entries) ? result.entries : [];
    if (entries.length === 0) {
      return {
        content: [{ type: "text", text: "No published team contacts found." }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
    const text = entries
      .map((e) => `- ${e.name} (id: ${e.agentId}) — ${e.platform}: ${e.email}`)
      .join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: result as unknown as Record<string, unknown>,
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
  flair_catchup,
  record_usage,
  skill_store,
  skill_search,
  skill_get,
  team_directory,
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
