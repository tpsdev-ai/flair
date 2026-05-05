/**
 * openclaw-flair — OpenClaw Memory Plugin backed by Flair
 *
 * Replaces the built-in MEMORY.md / memory-lancedb system with Flair as the
 * single source of truth for agent memory. Uses Flair's native Harper
 * embeddings — no OpenAI API key required.
 *
 * Implements the OpenClaw "memory" plugin slot:
 *   - memory_search  → POST /SemanticSearch (semantic search)
 *   - memory_store   → PUT  /Memory/<id>  (write + embed)
 *   - memory_get     → GET  /Memory/<id>  (fetch by id)
 *   - before_agent_start hook → inject recent/relevant memories
 *   - agent_end hook → auto-capture from conversation
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
export declare function isValidAgentId(agentId: string | null | undefined): boolean;
export declare function assertValidAgentId(agentId: string | null | undefined): asserts agentId is string;
declare const _default: {
    kind: "memory";
    register(api: OpenClawPluginApi): void;
};
export default _default;
