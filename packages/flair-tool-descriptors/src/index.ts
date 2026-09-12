/**
 * Transport-agnostic MCP tool descriptors (flair#1580).
 *
 * Pure data + types: name, description, inputSchema, output shape, and
 * reviewed surface flags. No Harper, no FlairClient, no Zod, no HTTP.
 *
 * The server TOOLS registry binds each native descriptor to its Harper impl.
 * The flair-mcp stdio adapter binds each stdio descriptor to a FlairClient
 * call. Both tool sets are DERIVED from this list — a new descriptor appears
 * on every surface that lists it, with zero hand-wiring.
 */

/** JSON Schema object used as MCP tools/list inputSchema. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type?: string };
  default?: unknown;
}

/** MCP tool descriptor as returned by tools/list. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations?: Record<string, unknown>;
}

/**
 * One MCP-facing tool. `native` / `stdio` default true — omit both and the
 * tool appears on every surface. Set false for a reviewed one-sided tool
 * (the #1578 exemption list is derived from these flags).
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  /** One-line output shape (MCP metadata). Native conformance contracts pin this as `summary`. */
  outputShape: string;
  annotations?: Record<string, unknown>;
  /** When false, native /mcp does not bind this tool. Default true. */
  native?: boolean;
  /** When false, the stdio adapter does not bind this tool. Default true. */
  stdio?: boolean;
  /** Stdio-only description when the HTTP path differs from native /mcp policy. */
  stdioDescription?: string;
  /** Properties advertised on native /mcp only (reviewed, e.g. flair#1579). */
  stdioOmitProperties?: readonly string[];
  /** Properties advertised on the stdio adapter only (reviewed). */
  stdioExtraProperties?: Record<string, JsonSchemaProperty>;
}

export function isNativeTool(d: ToolDescriptor): boolean {
  return d.native !== false;
}

export function isStdioTool(d: ToolDescriptor): boolean {
  return d.stdio !== false;
}

export function toMcpToolDef(d: ToolDescriptor): McpToolDef {
  return {
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
    ...(d.annotations ? { annotations: d.annotations } : {}),
  };
}

/** Native tools/list def, minus reviewed stdio-only omissions. */
export function toStdioMcpToolDef(d: ToolDescriptor): McpToolDef {
  const omit = new Set(d.stdioOmitProperties ?? []);
  const properties = { ...d.inputSchema.properties, ...(d.stdioExtraProperties ?? {}) };
  for (const key of omit) delete properties[key];
  const required = (d.inputSchema.required ?? []).filter((k) => !omit.has(k));
  return {
    name: d.name,
    description: d.stdioDescription ?? d.description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    ...(d.annotations ? { annotations: d.annotations } : {}),
  };
}

export function descriptorNames(descriptors: readonly ToolDescriptor[]): string[] {
  return descriptors.map((d) => d.name);
}

export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    "name": "memory_search",
    "description": "Search memories by meaning. Understands temporal queries like 'what happened today'. Scoped to your agent's own + granted memories.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Search query — natural language, semantic matching"
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 5)"
        },
        "includeTrust": {
          "type": "boolean",
          "description": "Attach a per-result trust-evidence block (provenance, author, usage, freshness, supersession). Default false."
        },
        "abstain": {
          "type": "boolean",
          "description": "Opt into first-class abstention: when the best match is below a global confidence threshold, return { abstained: true, reason, bestScore } with no weak matches instead of the N weakest results. Default false."
        },
        "includeArchived": {
          "type": "boolean",
          "description": "Include basemented (archived) memories in results. Default false — archived memories are excluded from normal search. When true, archived memories are returned under the SAME read-scope gate as a normal search (never a wider scope)."
        }
      },
      "required": [
        "query"
      ]
    },
    "outputShape": "{ results: MemoryRecord[] } — semantic hits scoped to the caller's own + granted memories; each hit carries content, never the raw embedding.",
    "annotations": {
      "readOnlyHint": true
    },
    "stdioOmitProperties": [
      "includeTrust",
      "abstain",
      "includeArchived"
    ]
  },
  {
    "name": "memory_store",
    "description": "Save information to persistent memory. Use for lessons, decisions, preferences, facts. Attributed to your authenticated agent.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "content": {
          "type": "string",
          "description": "What to remember"
        },
        "type": {
          "type": "string",
          "enum": [
            "session",
            "lesson",
            "decision",
            "preference",
            "fact",
            "goal"
          ],
          "description": "Memory type (default session)"
        },
        "durability": {
          "type": "string",
          "enum": [
            "permanent",
            "persistent",
            "standard",
            "ephemeral"
          ],
          "description": "permanent > persistent > standard > ephemeral (default standard)"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tag strings"
        },
        "visibility": {
          "type": "string",
          "enum": [
            "private",
            "shared"
          ],
          "description": "Writer-controlled sharing intent. Omit to use the server's durability-keyed default: permanent/persistent -> shared, standard/ephemeral -> private. private — owner-only, never visible to another agent, even one holding a memory grant. shared — visible to the owner and every other agent on this instance. The visibility the write actually landed on is returned in the result."
        },
        "usedMemoryIds": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "IDs of memories that informed this write (citation-on-write). Credited via the same deduped usage ledger as record_usage. Optional."
        }
      },
      "required": [
        "content"
      ]
    },
    "outputShape": "Write echo { id, written:true, deduplicated } — the new id + confirmation. No internal embedding fields; round-trips via memory_get."
  },
  {
    "name": "skill_store",
    "description": "Write a skill (a reusable capability/procedure) as a skill-tagged memory. The `trigger` text is what the skill embeds from (the recall signal — 'when to use this'), and `content` is the full procedure. Skills are forced durability=persistent and are SkillScan-gated before the embed (a dangerous shell/network payload is rejected).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "content": {
          "type": "string",
          "description": "The full procedure (markdown body of the SKILL.md)"
        },
        "trigger": {
          "type": "string",
          "description": "The 'when to use' text — the recall signal the skill embeds from"
        },
        "name": {
          "type": "string",
          "description": "Skill name (SKILL.md frontmatter; stored in metadata)"
        },
        "description": {
          "type": "string",
          "description": "Skill description (SKILL.md frontmatter; stored in metadata)"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Additional tags (the 'skill' tag is added automatically)"
        }
      },
      "required": [
        "content"
      ]
    },
    "outputShape": "Write echo { id, written:true, deduplicated } for the skill-tagged memory. No internal embedding fields; round-trips via memory_get."
  },
  {
    "name": "skill_search",
    "description": "Find skills (reusable capabilities/procedures) that apply to a task. Ranks skill-tagged memories by their `trigger` ('when to use') against your task text. Returns a lightweight CATALOG — id, name, trigger, description, tags, agentId — NOT the full procedure (fetch that with skill_get). Scoped to your own + shared skills; another agent's private skill is never returned.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task": {
          "type": "string",
          "description": "The task/context to match skills against — natural language; ranked against each skill's trigger"
        },
        "limit": {
          "type": "number",
          "description": "Max skills to return (default 5)"
        }
      },
      "required": [
        "task"
      ]
    },
    "outputShape": "{ results: SkillCard[] } — the skill catalog (lightweight id/name/trigger/description/tags/agentId, ranked by trigger match); the full procedure and the raw embedding are never on a card. Scoped to the caller's own + non-private skills; another agent's private skill is never returned.",
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "skill_get",
    "description": "Retrieve a full skill by ID — the complete procedure (`content`) plus trigger and metadata. The disclosure step after skill_search's catalog. Read-scoped: you can only get your own or a shared skill, never another agent's private skill. A non-skill id returns not-found. The raw embedding vector is never returned.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Skill (memory) ID"
        }
      },
      "required": [
        "id"
      ]
    },
    "outputShape": "The full skill record { id, agentId, content, trigger, tags, durability, metadata, createdAt, ... } for a skill readable under the caller's read-scope — embedding + embeddingModel always stripped. A non-owner cannot read another agent's private skill, and a readable non-skill id is not found (both 404).",
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "memory_update",
    "description": "Update an existing memory by ID. Dedup-bypassed (this is an intentional overwrite, not a new write). Default: overwrites the same id in place. Pass preserveHistory=true to instead write a new version linked via `supersedes`, closing the old one's validity window.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "ID of the memory to update"
        },
        "content": {
          "type": "string",
          "description": "New content"
        },
        "preserveHistory": {
          "type": "boolean",
          "description": "Write a new version (supersedes-linked) instead of overwriting in place (default false)"
        }
      },
      "required": [
        "id",
        "content"
      ]
    },
    "outputShape": "Write echo { id, written:true } for the in-place overwrite (or supersede). No internal embedding fields; the change round-trips via memory_get.",
    "stdioExtraProperties": {
      "usedMemoryIds": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "IDs of memories that informed this update (citation-on-write). Credited via the same deduped usage ledger as record_usage. Optional."
      }
    }
  },
  {
    "name": "memory_basement",
    "description": "Send a memory to the basement (archive it). Sets archived=true and stamps archivedAt. The memory is removed from bootstrap and default search but remains retrievable via memory_get and memory_search(includeArchived:true). Deliberate and GLOBAL — this is a visibility flag, not a deletion: provenance and history are untouched. Scoped to your own memories only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "ID of the memory to basement (archive)"
        }
      },
      "required": [
        "id"
      ]
    },
    "outputShape": "Write echo of the archived record { id, archived:true, archivedAt, ... }. No internal embedding fields; the flip round-trips via memory_get.",
    "stdio": false
  },
  {
    "name": "memory_restore",
    "description": "Restore a basemented (archived) memory. Clears archived and archivedAt. Deliberate and GLOBAL — this un-retires the memory for EVERY session, not a session-local view (per-session reuse is drawers, which do not exist yet). Scoped to your own memories only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "ID of the memory to restore (un-archive)"
        }
      },
      "required": [
        "id"
      ]
    },
    "outputShape": "Write echo of the restored record { id, archived:false, ... }. No internal embedding fields; the flip round-trips via memory_get.",
    "stdio": false
  },
  {
    "name": "memory_get",
    "description": "Retrieve a specific memory by ID. The record's raw embedding vector is omitted by default (it is large and not useful to a caller); pass includeEmbedding=true to include it.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Memory ID"
        },
        "includeTrust": {
          "type": "boolean",
          "description": "Attach a trust-evidence block (provenance, author, usage, freshness, supersession) to the record. Default false."
        },
        "includeEmbedding": {
          "type": "boolean",
          "description": "Include the raw embedding vector (hundreds of floats) in the returned record. Omitted by default because it is large and rarely useful to a caller. Default false."
        }
      },
      "required": [
        "id"
      ]
    },
    "outputShape": "The full memory record { id, agentId, content, durability, createdAt, ... } for the caller's own id — embedding + embeddingModel stripped by default.",
    "annotations": {
      "readOnlyHint": true
    },
    "stdioOmitProperties": [
      "includeTrust",
      "includeEmbedding"
    ]
  },
  {
    "name": "memory_delete",
    "description": "Delete a memory by ID. You can only delete your own memories.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Memory ID to delete"
        }
      },
      "required": [
        "id"
      ]
    },
    "outputShape": "Deletes the caller's own memory at any durability tier (success echo is thin). Cross-owner deletion returns { error, status:403 } for a non-admin; a deleted row round-trips as gone via memory_get.",
    "annotations": {
      "destructiveHint": true
    }
  },
  {
    "name": "relationship_store",
    "description": "Record that <subject> <predicate> <object> — an explicit entity-to-entity relationship triple (e.g. 'nathan manages flair', 'flint reviews cli'), distinct from a free-text memory. ASSERT/UPSERT semantics: writing the SAME triple again (same subject/predicate/object) updates the existing row in place (confidence/validTo/source refresh) rather than creating a duplicate — safe to re-assert. Predicate is free text (no fixed enum) but prefer a small, consistent vocabulary so the graph stays queryable: manages, works_on, reviews, depends_on, replaces, owns, reports_to, advises. TO CONTRADICT a prior relationship: (a) re-asserting the identical triple just updates it — fine. (b) changing validTo on the SAME subject/predicate/object overwrites the old validTo (the graph tracks current state, not full history). (c) changing the PREDICATE (e.g. 'nathan manages flair' -> 'nathan advises flair') creates a SEPARATE relationship — it does NOT automatically close the old one. Close it yourself first: re-assert the OLD triple with a validTo set to now (or call relationship's delete), THEN store the new one.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "subject": {
          "type": "string",
          "description": "Source entity — a person, project, or service (e.g. 'nathan')"
        },
        "predicate": {
          "type": "string",
          "description": "Relationship type, free text. Recommended vocabulary: manages, works_on, reviews, depends_on, replaces, owns, reports_to, advises — consistency helps recall, but any short verb phrase works."
        },
        "object": {
          "type": "string",
          "description": "Target entity — a person, project, or service (e.g. 'flair')"
        },
        "confidence": {
          "type": "number",
          "description": "0.0-1.0, how certain (default 1.0 = explicitly stated)"
        },
        "validFrom": {
          "type": "string",
          "description": "ISO timestamp this relationship became true (default: now)"
        },
        "validTo": {
          "type": "string",
          "description": "ISO timestamp this relationship ended. Leave unset for an active relationship; set it (via a re-assert of this SAME subject/predicate/object) to close out a relationship you're contradicting with a new predicate."
        },
        "source": {
          "type": "string",
          "description": "Where this was learned from (a memory ID, conversation, etc.)"
        }
      },
      "required": [
        "subject",
        "predicate",
        "object"
      ]
    },
    "outputShape": "Write echo { id, subject, predicate, object, written:true } for the asserted triple. Persistence is verified in storage.",
    "native": false
  },
  {
    "name": "bootstrap",
    "description": "Get session context: soul + memories + predicted context. Run at session start. Pass subjects for predictive loading.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "maxTokens": {
          "type": "number",
          "description": "Content-selection budget in tokens (default 4000): the hard cap on how much soul/memory/finding CONTENT is selected. The actual serialized response (reported by tokenEstimate) may exceed this by the structured-container JSON scaffolding — maxTokens bounds what is selected, not the raw output size. Raise it to include more content."
        },
        "currentTask": {
          "type": "string",
          "description": "Current task — enables semantic search for relevant memories"
        },
        "channel": {
          "type": "string",
          "description": "Channel name (discord, tps-mail, claude-code)"
        },
        "surface": {
          "type": "string",
          "description": "Surface name (tps-build, tps-review, cli-session)"
        },
        "subjects": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Entity names to preload context for"
        },
        "entities": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Your declared attention-plane vocabulary strings (e.g. \"issue:owner/repo#123\") for collision surfacing's 'Others in the room' block — teammates with overlapping active work. Falls back to your own most-recent workspace-state entities when omitted."
        },
        "includeTrust": {
          "type": "boolean",
          "description": "Also return a `trust` array with a per-included-memory trust-evidence block (provenance, author, usage, freshness, supersession). Default false."
        },
        "abstain": {
          "type": "boolean",
          "description": "Opt into a task-relevance abstention verdict: also return an `abstention` object ({ abstained, bestScore, threshold }) reporting whether any memory covered `currentTask` above a global confidence threshold. Default false."
        },
        "includeContext": {
          "type": "boolean",
          "description": "Also return the prose `context` string — a human-readable mirror of the structured soul/memories/predicted/teammateFindings containers (which are the canonical payload). Default false here: the structured fields already carry everything, so shipping the prose too would double the payload."
        },
        "maxEvents": {
          "type": "number",
          "description": "Display cap on how many org events to return (default 10). Not a silent drop: leftover events set eventsHasMore/eventsRemaining so the caller can page GET /OrgEventCatchup. Counted against maxTokens like every other content section."
        },
        "includeEventDetail": {
          "type": "boolean",
          "description": "Also include each org event's verbose `detail` JSON (migration internals, etc.). Default false: bootstrap ships lean events (id/kind/summary/createdAt/targetIds/scope); `detail` mostly restates the summary and is pure bloat for a connector."
        }
      }
    },
    "outputShape": "Session context: { agentId, soul, memories, predicted, teammateFindings, events, sections, tokenEstimate, memoriesIncluded, ..., context, flairVersion }. Structured containers are canonical and always present; prose `context` is a pointer at the /mcp default (includeContext opt-in).",
    "annotations": {
      "readOnlyHint": true
    },
    "stdioOmitProperties": [
      "entities",
      "includeTrust",
      "abstain",
      "includeContext",
      "maxEvents",
      "includeEventDetail"
    ]
  },
  {
    "name": "soul_set",
    "description": "Soul changes require operator credentials through the REST API or CLI; runtime tool calls are refused.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Entry key (e.g. 'role', 'standards', 'project')"
        },
        "value": {
          "type": "string",
          "description": "Entry value"
        }
      },
      "required": [
        "key",
        "value"
      ]
    },
    "outputShape": "Refuses runtime Soul writes, including admin-agent delegation, with { error, status:403 }. Operators use the authenticated REST or CLI path.",
    "stdioDescription": "Set a personality or project context entry. Included in every bootstrap."
  },
  {
    "name": "soul_get",
    "description": "Get a personality or project context entry.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Entry key"
        }
      },
      "required": [
        "key"
      ]
    },
    "outputShape": "The soul entry { id, agentId, key, value, createdAt } for the caller's own `${agentId}:${key}`.",
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "flair_workspace_set",
    "description": "Set your agent's current workspace state in the Office Space coordination layer. Attributed to you — you can only write your own state.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "ref": {
          "type": "string",
          "description": "Workspace ref — branch, worktree, or task ref"
        },
        "label": {
          "type": "string",
          "description": "Human-readable label"
        },
        "provider": {
          "type": "string",
          "description": "Provider/runtime (default mcp)"
        },
        "task": {
          "type": "string",
          "description": "Task/issue id"
        },
        "phase": {
          "type": "string",
          "description": "Current phase (design, implement, review)"
        },
        "summary": {
          "type": "string",
          "description": "Short summary of current state"
        }
      },
      "required": [
        "ref"
      ]
    },
    "outputShape": "Writes the caller's workspace state keyed `${agentId}:${ref}`, attributed to the caller (never the body). The echo is thin; persistence is verified in storage."
  },
  {
    "name": "flair_orgevent",
    "description": "Publish an org-wide coordination event (claim/release/status) to the Office Space. Attributed to you — you cannot publish as another agent.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "description": "Event kind (coord.claim, coord.release, status)"
        },
        "summary": {
          "type": "string",
          "description": "Short summary of the event"
        },
        "detail": {
          "type": "string",
          "description": "Longer detail payload"
        },
        "scope": {
          "type": "string",
          "description": "Scope (an agent id, repo, or 'org')"
        },
        "targets": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Recipient agent ids"
        }
      },
      "required": [
        "kind",
        "summary"
      ]
    },
    "outputShape": "Publishes an org event attributed to the caller (authorId from identity, never the body). The echo is thin; persistence is verified in storage."
  },
  {
    "name": "flair_catchup",
    "description": "Drain YOUR OWN catch-up feed — org events directed to you (or broadcast) after your durable watermark. Returns a page plus a `nextAfter` cursor: page with `after`, then advance the watermark with `ack`. Owner-scoped: the participant is your signed identity, so you can only ever read your own feed — there is no agentId parameter and any other feed is refused (403). At-least-once: an event may arrive twice (re-delivery is safe), an acked event does not re-deliver, and an un-acked event survives a restart.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "after": {
          "type": "string",
          "description": "Exclusive position cursor to read from. Omit to start at your durable watermark. Pass a prior page's `nextAfter` to continue a drain WITHOUT advancing the watermark."
        },
        "limit": {
          "type": "number",
          "description": "Max events per page (server default 50, max 500)."
        },
        "ack": {
          "type": "string",
          "description": "Position to acknowledge — advances your durable watermark, monotonically (never rewinds). Pass the last event position you processed, or `nextAfter` once a page is drained. Omit to read without advancing: events stay queued and survive a restart. Re-acking is safe."
        }
      }
    },
    "outputShape": "{ events: OrgEvent[], after, nextAfter, watermark, hasMore, pageSize, acked? } — the caller's own directed + broadcast events after its durable watermark, paged; `ack` advances the watermark monotonically (at-least-once — re-delivery is safe).",
    "native": false
  },
  {
    "name": "attention",
    "description": "What's touching entity E in the last N days? A unified, grouped-by-source view across memories, relationships, active work (WorkspaceState), teammate presence, and org events. Entity must be a vocabulary string (e.g. 'repo:owner/name', 'issue:owner/repo#123', 'subsystem:embeddings').",
    "inputSchema": {
      "type": "object",
      "properties": {
        "entity": {
          "type": "string",
          "description": "Vocabulary string, exact match (type:value — e.g. 'repo:tpsdev-ai/flair')"
        },
        "days": {
          "type": "number",
          "description": "Window size in days (default 7)"
        }
      },
      "required": [
        "entity"
      ]
    },
    "outputShape": "Grouped-by-source view { entity, windowDays, since, groups:{memory,relationship,workspaceState,presence,orgEvent}, counts } for entity E over N days.",
    "annotations": {
      "readOnlyHint": true
    },
    "stdio": false
  },
  {
    "name": "record_usage",
    "description": "Report that one or more memories were actually USED — cited or relied on to ground an answer or decision. Distinct from search (surfacing a memory is not usage). Drives the recall-quality usage signal; dedup'd (you can only count once per memory) and rate-limited. When both memoryId and memoryIds are supplied they are merged (union, then deduped) — a caller who passes both means both.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "memoryIds": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "IDs of the memories that were used (max 20 per call). Merged with memoryId when both are supplied."
        },
        "memoryId": {
          "type": "string",
          "description": "Convenience alias for a single memory id. Merged with memoryIds when both are supplied — not dropped."
        },
        "attribution": {
          "type": "string",
          "description": "Optional free-text note on what used it (opaque — stored for audit only, max 500 chars)"
        }
      }
    },
    "outputShape": "Invariant acknowledgement { recorded:true } — byte-identical regardless of how many ids counted (no id enumeration, Sherlock)."
  },
] as const satisfies readonly ToolDescriptor[];

export const NATIVE_TOOL_DESCRIPTORS: readonly ToolDescriptor[] =
  TOOL_DESCRIPTORS.filter(isNativeTool);

export const STDIO_TOOL_DESCRIPTORS: readonly ToolDescriptor[] =
  TOOL_DESCRIPTORS.filter(isStdioTool);

/** Derived #1578 exemption list — one-sided by construction, not hand-synced. */
export const SURFACE_EXEMPTIONS = {
  registryOnly: descriptorNames(TOOL_DESCRIPTORS.filter((d) => isNativeTool(d) && !isStdioTool(d))),
  adapterOnly: descriptorNames(TOOL_DESCRIPTORS.filter((d) => isStdioTool(d) && !isNativeTool(d))),
} as const;
