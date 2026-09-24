/**
 * openclaw-flair — OpenClaw Memory Plugin backed by Flair
 *
 * Replaces the built-in MEMORY.md / memory-lancedb system with Flair as the
 * single source of truth for agent memory. Uses Flair's native Harper
 * embeddings — no OpenAI API key required.
 *
 * Identity core (slice 1): every agent acts only as itself. The serving agent
 * comes from immutable host context — the tool FACTORY `ctx.agentId`, or the
 * hook `ctx.agentId` — never from a module-level value, an env var, or plugin
 * config. A configured `agentId` may only RESTRICT which agents are served; it
 * never substitutes for one. Missing or mismatched identity refuses, and a
 * refusal makes zero outgoing requests. Runtime workspace→Soul sync is removed.
 *
 * Hooks used: `before_prompt_build` (bootstrap, returned via `prependContext`)
 * and `agent_end` / `llm_input` / `llm_output` (optional auto-capture). The
 * deprecated `before_agent_start` hook is not used and no context-engine slot
 * is selected — the host's own native memory section is left intact.
 */

import { createHash, type KeyObject } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import { FlairClient, loadPrivateKey, resolveKeyPath } from "@tpsdev-ai/flair-client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

/** The host tool-context fields this plugin reads. `agentId` is the identity. */
type ToolContext = { agentId?: string };

// ─── Host compatibility gate ──────────────────────────────────────────────────
//
// The tested host set is EXACT versions (flair#1751): hook contracts change
// between minors, so a wildcard range would register on an untested release.
// A plugin that half-registers poisons every turn, so outside the set we
// register NOTHING and say why. Adding a version is a deliberate change that
// re-runs the real-host drills.
export const TESTED_HOST_VERSIONS = ["2026.8.1", "2026.9.6"] as const;

/**
 * The running host version, or null when it cannot be determined.
 *
 * The ONLY source is the host API — `api.runtime.version` (`PluginRuntimeCore`,
 * "Core runtime helpers exposed to trusted native plugins"). Environment
 * variables are deliberately NOT consulted: any process can set
 * OPENCLAW_VERSION, so an env-sourced gate is an override anyone could use to
 * fake the tested set. The comparison is EXACT string equality against the
 * tested set (no prefix/range match: `2026.8.1-dev` is not `2026.8.1`). If the
 * runtime version is missing or not a string the host is unknown and the plugin
 * registers nothing.
 */
function hostVersionOf(api: OpenClawPluginApi): string | null {
  const raw = (api as any)?.runtime?.version;
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v || null;
}

// ─── Defense-in-depth: agentId path-traversal guard ──────────────────────────
// agentId flows into resolve() to compose workspace paths and key paths.
// resolve() normalizes "../" but doesn't reject — a malformed agentId of
// "../../../etc" could traverse out of a directory. A fail-closed regex guard
// surfaces invalid input rather than silently mangling it.
const AGENT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i;

export function isValidAgentId(agentId: string | null | undefined): boolean {
  return typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId);
}

export function assertValidAgentId(agentId: string | null | undefined): asserts agentId is string {
  if (!isValidAgentId(agentId)) {
    throw new Error(
      `openclaw-flair: invalid agentId ${JSON.stringify(agentId)} — must match ${AGENT_ID_PATTERN} (1-64 chars, alphanumeric + underscore + hyphen)`,
    );
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface FlairMemoryConfig {
  url?: string;
  /**
   * OPTIONAL allow-list. When set, only this agent may be served; serving any
   * other agent refuses. It is never used as a fallback identity.
   */
  agentId?: string;
  /**
   * Explicit private-key path. Valid ONLY when a single agent is allowed
   * (`agentId` set and not "auto"); otherwise it is refused at startup, because
   * one key cannot bind every agent on a gateway.
   */
  keyPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  maxRecallResults?: number;
  maxBootstrapTokens?: number;
  autoCaptureMaxPerSession?: number;
}

const DEFAULT_URL = "http://127.0.0.1:19926";
const DEFAULT_MAX_RECALL = 5;
const DEFAULT_MAX_BOOTSTRAP_TOKENS = 4000;
const DEFAULT_AUTO_CAPTURE_MAX_PER_SESSION = 3;
/** Capture is OFF by default in slice 1 and turns on with slice 2. */
const DEFAULT_AUTO_CAPTURE = false;

// ─── Auto-capture helpers ─────────────────────────────────────────────────────

const CAPTURE_TRIGGERS = [
  /\b(remember this|note for future|important lesson|key decision|for the record)\b/i,
  /\b(my name is|call me|i go by)\b/i,
  /\b(we decided|final decision|agreed to|commitment:)\b/i,
];

const MIN_CAPTURE_LENGTH = 30; // skip very short messages

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function shouldCapture(text: string): boolean {
  if (text.length < MIN_CAPTURE_LENGTH) return false;
  return CAPTURE_TRIGGERS.some((re) => re.test(text));
}

function excerptForCapture(text: string, maxChars = 500): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

interface CaptureState {
  count: number;
  hashes: Set<string>;
}

function createCaptureState(): CaptureState {
  return { count: 0, hashes: new Set() };
}

/**
 * Pure decision: given a candidate text and the current per-session capture
 * state, decide whether it should be captured. Returns the excerpt + content
 * hash to write, or null if the text doesn't match a trigger, the session cap
 * is already spent, or this exact excerpt was already captured. Does not mutate
 * state or perform I/O — callers apply the decision.
 */
export function evaluateAutoCapture(
  text: string,
  state: Pick<CaptureState, "count" | "hashes">,
  maxPerSession: number = DEFAULT_AUTO_CAPTURE_MAX_PER_SESSION,
): { excerpt: string; hash: string } | null {
  if (!shouldCapture(text)) return null;
  if (state.count >= maxPerSession) return null;
  const excerpt = excerptForCapture(text);
  const hash = hashContent(excerpt);
  if (state.hashes.has(hash)) return null;
  return { excerpt, hash };
}

function recordCapture(state: CaptureState, hash: string): void {
  state.count++;
  state.hashes.add(hash);
}

// ─── Entity detection ────────────────────────────────────────────────────────

interface DetectedEntity {
  name: string;
  kind: "person" | "project" | "service" | "org" | "concept";
  confidence: number;
}

const PERSON_PATTERNS = [
  /\b([A-Z][a-z]{2,})\s+(?:said|asked|mentioned|decided|approved|rejected|thinks|wants|needs|prefers)\b/g,
  /\b(?:ask|ping|tell|check with|talk to)\s+(?:@)?([A-Z][a-z]{2,})\b/g,
  /\b(?:my name is|i'm|call me)\s+([A-Z][a-z]{2,})\b/gi,
  /\b([A-Z][a-z]{2,})\s+(?:is the|is our|is a|was the|was our)\s+(\w+(?:\s+\w+)?)\b/g,
];

const PROJECT_PATTERNS = [
  /\b(?:tpsdev-ai|github\.com)\/([a-z0-9-]+)\b/g,
  /\b(?:the|our)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:project|repo|service|system|app|tool|plugin)\b/g,
];

const ENTITY_STOPWORDS = new Set([
  "the", "this", "that", "with", "from", "into", "also", "just", "here",
  "there", "what", "when", "where", "which", "while", "should", "would",
  "could", "will", "does", "have", "been", "being", "make", "made",
  "take", "taken", "like", "look", "good", "well", "much", "many",
  "some", "each", "every", "both", "other", "such", "only", "same",
  "than", "then", "now", "how", "all", "any", "few", "most", "very",
  "after", "before", "between", "under", "over", "through", "during",
  "about", "against", "above", "below", "off", "down", "out",
  "let", "set", "get", "put", "run", "use", "try", "see", "new",
  "old", "big", "end", "way", "day", "man", "did", "got", "had",
  "yes", "not", "but", "for", "are", "was", "can", "may", "one",
  "two", "its", "his", "her", "our", "has", "him", "her", "per",
  "via", "bug", "fix", "add", "api", "url", "cli", "tcp", "ssh",
  "keep", "next", "last", "best", "sure", "okay", "done", "want",
  "need", "know", "think", "start", "stop", "check", "update",
  "instead", "currently", "actually", "already", "however", "because",
  "since", "until", "still", "right", "first", "great", "sounds",
  "interesting", "important", "note", "issue", "pull", "push",
  "merge", "branch", "commit", "deploy", "build", "test", "spec",
]);

function isValidEntity(name: string): boolean {
  if (name.length < 3 || name.length > 30) return false;
  if (ENTITY_STOPWORDS.has(name.toLowerCase())) return false;
  if (/^\d+$/.test(name)) return false;
  return true;
}

function detectEntities(text: string): DetectedEntity[] {
  const entities = new Map<string, DetectedEntity>();

  for (const pattern of PERSON_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      if (!isValidEntity(name)) continue;
      const key = name.toLowerCase();
      if (!entities.has(key) || entities.get(key)!.confidence < 0.7) {
        entities.set(key, { name, kind: "person", confidence: 0.7 });
      }
    }
  }

  for (const pattern of PROJECT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      if (!isValidEntity(name)) continue;
      const key = name.toLowerCase();
      if (!entities.has(key)) {
        entities.set(key, { name, kind: "project", confidence: 0.8 });
      }
    }
  }

  return [...entities.values()];
}

// ─── Plugin export ────────────────────────────────────────────────────────────

/** A stable fingerprint of a loaded private key (never the raw seed). */
function keyFingerprint(key: KeyObject): string {
  return createHash("sha256").update(key.export({ type: "pkcs8", format: "der" })).digest("hex");
}

/**
 * Injectable key probes for the pre-fetch re-verification. Production uses the
 * real functions; a test substitutes them to simulate a key file that changes
 * AFTER the client was built but BEFORE the fetch (the window a re-read would
 * otherwise paper over).
 */
export const signingKeyProbe: {
  resolve: (agentId: string, keyPath?: string) => string | null;
  load: (keyFile: string) => KeyObject;
} = {
  resolve: (agentId, keyPath) => resolveKeyPath(agentId, keyPath),
  load: (keyFile) => loadPrivateKey(keyFile),
};

/**
 * The gateway's agent set, from host config.
 *
 * - `implicit` — no roster property at all: a valid config with no
 *   `agents.entries` and no `agents.list` means the host's IMPLICIT SOLE AGENT,
 *   so registration proceeds.
 * - `ids` — a present, non-empty roster (entries keyed by agent id, or a list of
 *   `{ id }`).
 * - `unknown` — the config is unreadable, or a roster property is present but
 *   empty or malformed: identity cannot be guaranteed, so register nothing.
 */
type AgentSet =
  | { kind: "implicit" }
  | { kind: "ids"; ids: string[] }
  | { kind: "unknown" };

function gatewayAgentSet(api: OpenClawPluginApi): AgentSet {
  const config = api.config as any;
  if (!config || typeof config !== "object") return { kind: "unknown" };
  const agents = config.agents;
  if (agents === undefined || agents === null) return { kind: "implicit" };
  if (typeof agents !== "object") return { kind: "unknown" };
  const entries = (agents as any).entries;
  if (entries !== undefined) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { kind: "unknown" };
    const ids = Object.keys(entries).filter((k) => typeof k === "string" && k.length > 0);
    if (ids.length === 0) return { kind: "unknown" };
    return { kind: "ids", ids: [...new Set(ids)] };
  }
  const list = (agents as any).list;
  if (list !== undefined) {
    if (!Array.isArray(list)) return { kind: "unknown" };
    const ids = list
      .map((a: any) => (typeof a === "string" ? a : a?.id))
      .filter((id: any): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return { kind: "unknown" };
    return { kind: "ids", ids: [...new Set(ids)] };
  }
  return { kind: "implicit" };
}

/**
 * Whether THIS process can READ an agent's key file. Ownership of the
 * containing directory does not establish readability, so the check is the file
 * itself: `true` when `accessSync(path, R_OK)` succeeds; `false` when the key
 * does not resolve or cannot be read (EACCES/ENOENT — not ours); `null` for any
 * other error (readability cannot be determined — "cannot guarantee").
 */
export function keyReadableByThisProcess(
  agentId: string,
  keyPath?: string,
  access: (path: string) => void = (p) => accessSync(p, fsConstants.R_OK),
): boolean | null {
  const keyFile = resolveKeyPath(agentId, keyPath);
  if (!keyFile) return false;
  try {
    access(keyFile);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "ENOENT") return false;
    return null;
  }
}

export default {
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    // ── 1. Host version gate: the FIRST statement of registration. ──────────
    // Nothing above this line touched the host: no api.on, no registerTool, no
    // registerContextEngine. Outside the tested set we register NOTHING.
    const hostVersion = hostVersionOf(api);
    const tested = TESTED_HOST_VERSIONS as readonly string[];
    if (!hostVersion || !tested.includes(hostVersion)) {
      api.logger.warn(
        `openclaw-flair disabled: host ${hostVersion ?? "unknown"} not in tested set ${tested.join(", ")}`,
      );
      return;
    }

    const cfg = (api.pluginConfig ?? {}) as unknown as FlairMemoryConfig;

    // ── 2. Identity config: optional allow-list, never a fallback. ──────────
    // Parsed BEFORE the shared-OS-user check: an explicit keyPath is only valid
    // together with a single allowed agent, and that refusal must be the reason
    // reported — not a readability verdict the keyPath itself would distort.
    const allowAgentId = cfg.agentId && cfg.agentId !== "auto" ? cfg.agentId : null;
    if (allowAgentId) assertValidAgentId(allowAgentId);
    if (cfg.keyPath && !allowAgentId) {
      // One explicit key cannot bind every agent on the gateway.
      api.logger.warn(
        "openclaw-flair disabled: keyPath is only valid with a single allowed agent (set agentId); refusing to bind one key to every agent",
      );
      return;
    }

    // ── 3. Shared-OS-user detection, fail closed. ───────────────────────────
    // The property that matters is whether THIS gateway process can read every
    // agent's key. An implicit sole agent is fine. An unreadable/empty roster,
    // or a roster where any agent's key owner cannot be determined, is refused.
    // When every agent's key directory is owned by this process's uid, the
    // process can read them all, so identity cannot be guaranteed.
    //
    // Each agent's OWN key decides. An explicit keyPath applies ONLY to the
    // allowed agent; it must never make a second roster agent "resolve" to the
    // allowed agent's key and read as if it shared this process's key. Every
    // other roster agent resolves its own keys/<id>.key.
    const agentSet = gatewayAgentSet(api);
    if (agentSet.kind === "unknown") {
      api.logger.warn(
        "openclaw-flair disabled: cannot determine the gateway agent set; identity cannot be guaranteed",
      );
      return;
    }
    const agentIds = agentSet.kind === "ids" ? agentSet.ids : ["(implicit)"];
    if (agentIds.length > 1) {
      const readable = agentIds.map((id) =>
        keyReadableByThisProcess(id, id === allowAgentId ? cfg.keyPath : undefined),
      );
      if (readable.some((r) => r === null)) {
        api.logger.warn(
          "openclaw-flair disabled: cannot determine whether this process can read every agent key; identity cannot be guaranteed",
        );
        return;
      }
      // Readability, not ownership: if this process can read MORE THAN ONE
      // agent's key, they share an OS user and identity cannot be guaranteed.
      if (readable.filter((r) => r === true).length > 1) {
        api.logger.warn(
          "openclaw-flair disabled: agents share an OS user; identity cannot be guaranteed",
        );
        return;
      }
    }

    // ── 4. Permission gates (host policy). ─────────────────────────────────
    const entryHooks = ((api.config as any)?.plugins?.entries?.[api.id]?.hooks ?? {}) as {
      allowConversationAccess?: boolean;
      allowPromptInjection?: boolean;
    };
    const allowPromptInjection = entryHooks.allowPromptInjection === true;
    const allowConversationAccess = entryHooks.allowConversationAccess === true;

    // ── 5. Per-agent clients + key resolution (fail closed). ────────────────
    const clients = new Map<string, FlairClient>();

    /** Thrown (never returned) so callers refuse before any I/O. */
    class IdentityRefusal extends Error {}

    function clientFor(agentId: string | null | undefined): FlairClient {
      if (!agentId) {
        throw new IdentityRefusal(
          "no agent identity in host context — refusing rather than inheriting one",
        );
      }
      if (!isValidAgentId(agentId)) {
        throw new IdentityRefusal(`invalid agent identity ${JSON.stringify(agentId)}`);
      }
      if (allowAgentId && agentId !== allowAgentId) {
        throw new IdentityRefusal(
          `agent "${agentId}" is not in the configured allow-list (${allowAgentId})`,
        );
      }
      // Per-agent key: `keys/<X>.key` from the host-given X. Explicit keyPath is
      // permitted only in the single-allowed-agent case (enforced at startup).
      const keyPath = allowAgentId ? cfg.keyPath : undefined;
      if (!resolveKeyPath(agentId, keyPath)) {
        throw new IdentityRefusal(
          `no private key for agent "${agentId}" — refusing (no Basic/admin, no unsigned fallback)`,
        );
      }
      let client = clients.get(agentId);
      if (!client) {
        client = makeSigningOnlyClient(agentId, keyPath);
        clients.set(agentId, client);
      }
      return client;
    }

    /**
     * A FlairClient that signs with a key LOADED ONCE, in memory. The client is
     * constructed with that KeyObject and with EMPTY admin credentials, so
     * request() never reads the key file and Basic auth is impossible by
     * construction. A pre-fetch re-verification still refuses if the file has
     * disappeared or drifted from the in-memory key — but the request can only
     * ever be signed with the key this wrapper loaded, never a later one, and
     * never unauthenticated. Errors name the agent, never key bytes.
     */
    function makeSigningOnlyClient(agentId: string, keyPath?: string): FlairClient {
      const keyFile = resolveKeyPath(agentId, keyPath);
      if (!keyFile) {
        throw new IdentityRefusal(
          `no private key for agent "${agentId}" — refusing (no Basic/unsigned fallback)`,
        );
      }
      let keyObject: KeyObject;
      try {
        keyObject = loadPrivateKey(keyFile);
      } catch {
        throw new IdentityRefusal(
          `private key for agent "${agentId}" is unusable — refusing (no Basic/unsigned fallback)`,
        );
      }
      const fingerprint = keyFingerprint(keyObject);
      const client = new FlairClient({
        url: cfg.url ?? DEFAULT_URL,
        agentId,
        privateKey: keyObject,
        adminUser: "",
        adminPassword: "",
      });
      const original = client.request.bind(client) as typeof client.request;
      (client as any).request = async (method: string, path: string, body?: unknown) => {
        const current = signingKeyProbe.resolve(agentId, keyPath);
        if (!current) {
          throw new IdentityRefusal(
            `the private key for agent "${agentId}" disappeared before the request — refusing (no Basic/unsigned fallback)`,
          );
        }
        let nowFingerprint: string;
        try {
          nowFingerprint = keyFingerprint(signingKeyProbe.load(current));
        } catch {
          throw new IdentityRefusal(
            `the private key for agent "${agentId}" is unusable — refusing (no Basic/unsigned fallback)`,
          );
        }
        if (nowFingerprint !== fingerprint) {
          throw new IdentityRefusal(
            `the private key for agent "${agentId}" changed while running — refusing until the gateway is restarted so identity is re-established`,
          );
        }
        return original(method, path, body);
      };
      return client;
    }

    const maxRecall = cfg.maxRecallResults ?? DEFAULT_MAX_RECALL;
    const maxBootstrapTokens = cfg.maxBootstrapTokens ?? DEFAULT_MAX_BOOTSTRAP_TOKENS;
    const autoRecall = cfg.autoRecall ?? true;
    const autoCapture = cfg.autoCapture ?? DEFAULT_AUTO_CAPTURE;
    const autoCaptureMaxPerSession = Math.max(
      1,
      cfg.autoCaptureMaxPerSession ?? DEFAULT_AUTO_CAPTURE_MAX_PER_SESSION,
    );

    const captureStatePool = new Map<string, CaptureState>();
    function getCaptureState(agentId: string): CaptureState {
      let state = captureStatePool.get(agentId);
      if (!state) {
        state = createCaptureState();
        captureStatePool.set(agentId, state);
      }
      return state;
    }
    function resetCaptureState(agentId: string): void {
      captureStatePool.delete(agentId);
    }

    async function tryAutoCapture(client: FlairClient, agentId: string, text: string): Promise<boolean> {
      const state = getCaptureState(agentId);
      const decision = evaluateAutoCapture(text, state, autoCaptureMaxPerSession);
      if (!decision) return false;
      const entities = detectEntities(text);
      const subject = entities.length > 0 ? entities[0].name.toLowerCase() : undefined;
      await client.memory.write(decision.excerpt, {
        type: "session",
        tags: ["auto-captured"],
        subject,
      });
      recordCapture(state, decision.hash);
      return true;
    }

    const displayAgent = allowAgentId ?? "host-provided (per invocation)";
    api.logger.info(`openclaw-flair: registered (agent=${displayAgent}, url=${cfg.url ?? DEFAULT_URL})`);

    // ── 6. Tools — registered as FACTORIES closing over ctx.agentId. ────────
    // Every tool resolves its client from the immutable host context at call
    // time. There is no module-level current agent.

    api.registerTool(
      (ctx: ToolContext) => ({
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search long-term memory via Flair semantic search. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_id: string, params: { query: string; limit?: number }) {
          const { query, limit = maxRecall } = params;
          try {
            const client = clientFor(ctx.agentId);
            const results = await client.memory.search(query, { limit });
            if (results.length === 0) {
              return { content: [{ type: "text", text: "No relevant memories found." }], details: { count: 0 } };
            }
            const text = results
              .map((r, i) => `${i + 1}. ${r.content} (${(r.score * 100).toFixed(0)}%)`)
              .join("\n");
            return {
              content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
              details: { count: results.length, memories: results },
            };
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: search refused/failed: ${err.message}`);
            return { content: [{ type: "text", text: `Memory search unavailable: ${err.message}` }], details: { count: 0 } };
          }
        },
      }),
      { name: "memory_search" },
    );

    api.registerTool(
      (ctx: ToolContext) => ({
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
          ], { description: "Memory durability" })),
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
        async execute(_id: string, params: any) {
          const { text, tags, durability, type, supersedes } = params;
          try {
            const client = clientFor(ctx.agentId);
            const memId = `${client.agentId}-${Date.now()}`;
            const result = await client.memory.write(text, {
              id: memId,
              tags,
              durability,
              type,
              dedup: !supersedes,
              dedupThreshold: 0.7,
            });
            if (supersedes) {
              try {
                const old = await client.memory.get(supersedes);
                if (old) {
                  await client.request("PUT", `/Memory/${supersedes}`, {
                    ...old,
                    archived: true,
                    archivedAt: new Date().toISOString(),
                    supersededBy: memId,
                  });
                } else {
                  api.logger.warn(
                    `openclaw-flair: supersede target ${supersedes} not found — new memory ${memId} written; nothing to close`,
                  );
                }
              } catch (closeErr: any) {
                api.logger.warn(
                  `openclaw-flair: failed to close superseded memory ${supersedes} after writing ${memId}: ${closeErr.message} ` +
                  `(not lost — new record is safely written; old record remains active until retried)`,
                );
              }
            }
            const wasDeduplicated = (result as any).deduplicated === true;
            return {
              content: [{
                type: "text",
                text: wasDeduplicated
                  ? `Memory stored (id: ${memId}) — similar to existing memory id=${(result as any).matchedId}: ${result.content?.slice(0, 200)}`
                  : `Memory stored (id: ${memId})`,
              }],
              details: {
                id: result.id,
                deduplicated: wasDeduplicated,
                written: true,
                ...(wasDeduplicated ? { matchedId: (result as any).matchedId } : {}),
              },
            };
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: store refused/failed: ${err.message}`);
            return { content: [{ type: "text", text: `Memory store unavailable: ${err.message}` }], details: {} };
          }
        },
      }),
      { name: "memory_store" },
    );

    api.registerTool(
      (ctx: ToolContext) => ({
        name: "memory_get",
        label: "Memory Get",
        description: "Retrieve a specific memory by ID from Flair.",
        parameters: Type.Object({
          id: Type.String({ description: "Memory ID" }),
        }),
        async execute(_toolId: string, params: { id: string }) {
          const { id } = params;
          try {
            const client = clientFor(ctx.agentId);
            const mem = await client.memory.get(id);
            if (!mem) return { content: [{ type: "text", text: `Memory ${id} not found.` }], details: {} };
            return { content: [{ type: "text", text: mem.content }], details: mem };
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: memory_get refused/failed: ${err.message}`);
            return { content: [{ type: "text", text: `Memory get failed: ${err.message}` }], details: {} };
          }
        },
      }),
      { name: "memory_get" },
    );

    // ── 7. Bootstrap — before_prompt_build, RETURNING prependContext. ───────
    // Never `injectContext` (it does not exist); logs say "returned". Without
    // the host's prompt-policy opt-in we contribute nothing and say so once.
    if (autoRecall) {
      if (!allowPromptInjection) {
        api.logger.warn("openclaw-flair: prompt context disabled: policy");
      } else {
        api.on("before_prompt_build", async (_event: any, ctx: any) => {
          const agentId = ctx?.agentId;
          try {
            const client = clientFor(agentId);
            const result = await client.bootstrap({ maxTokens: maxBootstrapTokens });
            const context = result.context;
            if (context && typeof context === "string" && context.trim().length > 0) {
              const truncated = context.slice(0, maxBootstrapTokens * 4);
              api.logger.info(`openclaw-flair: returned bootstrap context (${context.length} chars)`);
              return { prependContext: `\n## Memory Context (from Flair)\n\n${truncated}\n` };
            }
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: bootstrap recall refused/failed: ${err.message}`);
          }
          return;
        });
      }
    }

    // ── 8. Capture — permission-gated, OFF by default. ─────────────────────
    // Capture reads conversation content ONLY through the permission-gated
    // hooks; a missing permission produces a visible status line and no reads.
    if (!allowConversationAccess) {
      // R8: reported whenever the permission is withheld, whether or not
      // capture is enabled.
      api.logger.warn("openclaw-flair: capture disabled (permission)");
    } else if (autoCapture) {
        api.on("agent_end", async (event: any, ctx: any) => {
          const agentId = ctx?.agentId;
          if (!agentId) {
            api.logger.warn("openclaw-flair: agent_end refused: no agent identity in host context — refusing rather than inheriting one");
            return;
          }
          try {
            const client = clientFor(agentId);
            const messages = (event?.messages ?? []) as Array<{ role: string; content?: string }>;
            let stored = 0;
            for (const msg of messages) {
              if (msg.role !== "user" && msg.role !== "assistant") continue;
              const text = typeof msg.content === "string" ? msg.content : "";
              if (!text) continue;
              if (await tryAutoCapture(client, agentId, text)) stored++;
            }
            if (stored > 0) api.logger.info(`openclaw-flair: auto-captured ${stored} memories`);
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: auto-capture refused/failed: ${err.message}`);
          } finally {
            resetCaptureState(agentId);
          }
        });

        api.on("llm_input", async (event: any, ctx: any) => {
          const agentId = ctx?.agentId;
          if (!agentId) {
            api.logger.warn("openclaw-flair: llm_input refused: no agent identity in host context — refusing rather than inheriting one");
            return;
          }
          const text = typeof event?.prompt === "string" ? event.prompt : "";
          if (!text) return;
          try {
            const client = clientFor(agentId);
            const captured = await tryAutoCapture(client, agentId, text);
            if (captured) api.logger.info("openclaw-flair: auto-captured 1 memory from live turn (llm_input)");
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: live auto-capture (llm_input) refused/failed: ${err.message}`);
          }
        });

        api.on("llm_output", async (event: any, ctx: any) => {
          const agentId = ctx?.agentId;
          if (!agentId) {
            api.logger.warn("openclaw-flair: llm_output refused: no agent identity in host context — refusing rather than inheriting one");
            return;
          }
          const texts = Array.isArray(event?.assistantTexts) ? event.assistantTexts : [];
          const text = texts.filter((t: unknown) => typeof t === "string").join("\n");
          if (!text) return;
          try {
            const client = clientFor(agentId);
            const captured = await tryAutoCapture(client, agentId, text);
            if (captured) api.logger.info("openclaw-flair: auto-captured 1 memory from live turn (llm_output)");
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: live auto-capture (llm_output) refused/failed: ${err.message}`);
          }
        });
    }

    // ── 9. Slot safety. ────────────────────────────────────────────────────
    // Slice 1 does NOT select a context-engine slot and does not suppress the
    // host's native memory section; anchors stay off until slice 3. The host's
    // own workspace files already load each agent's SOUL/AGENTS.

    // ── 10. Status surface (R5). ───────────────────────────────────────────
    // The 2026.7.1 plugin SDK offers `registerService` (plus `internalDiagnostics`
    // on the service context) but no dedicated status-line hook, so the enabled
    // plugin exposes its state through a registered service; each gate's refusal
    // is its startup log line (a gate that refuses must register nothing, and the
    // version gate must stay the first statement).
    api.registerService({
      id: "openclaw-flair-status",
      start: (ctx: any) => {
        const line =
          "openclaw-flair status: " +
          `host=${hostVersion} prompt=${allowPromptInjection ? "allowed" : "withheld"} ` +
          `capture=${allowConversationAccess ? "allowed" : "withheld"} ` +
          `agents=${agentIds.length > 1 ? "multiple" : "sole"} ` +
          `mode=${allowAgentId ? "allow-list" : "host-identity"}`;
        (ctx?.logger ?? api.logger).info(line);
        try {
          ctx?.internalDiagnostics?.emit?.({ kind: "openclaw-flair-status", detail: line });
        } catch { /* diagnostics are best-effort */ }
      },
    });
  },
};
