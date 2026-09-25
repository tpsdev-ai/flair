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
 * Hooks used: `before_prompt_build` (bootstrap, returned via `prependContext`),
 * `agent_end` / `llm_input` / `llm_output` (optional auto-capture), and
 * `gateway_stop` / `model_call_ended` (abort of an in-flight capture). The
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

/**
 * Round 12: how much of an error's message is used when its class falls back to
 * the message (guarantee 6). The one-time-log set is already capped by
 * `logOnceCap`, so this is not a second bound — it only keeps the keys readable.
 */
const REFUSE_KEY_CLASS_MAX = 120;

/**
 * The CLASS of an error, not its instance (round 12, guarantee 6). A Flair HTTP
 * failure is classed by its status: its message embeds the client-assigned
 * memory id, so keying on the message would make every retry of one failure look
 * like a new failure. Everything else is classed by its name and as much of its
 * message as fits — a missing key reads the same on every callback.
 */
function errorClass(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; status?: unknown } | null | undefined;
  const name = typeof e?.name === "string" && e.name.length > 0 ? e.name : "Error";
  if (typeof e?.status === "number") return `${name}:${e.status}`;
  const message = typeof e?.message === "string" ? e.message : String(err);
  return `${name}:${message.slice(0, REFUSE_KEY_CLASS_MAX)}`;
}
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

/**
 * D5: the capture text of a host message `content` — a string, or an array of
 * content blocks. Text blocks are concatenated IN ORDER; image, thinking and
 * tool blocks contribute NOTHING (their contents are never read into a memory);
 * anything else returns "". Every capture path goes through this.
 */
export function captureText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) parts.push(b.text);
  }
  return parts.join("");
}

interface CaptureState {
  count: number;
  hashes: Set<string>;
}

/**
 * Injectable clock for the run-state retirement rule (D10). Production reads
 * `Date.now`; a test substitutes a fake so the 30 s window is exercised without
 * sleeping.
 */
export const captureClock: { now: () => number } = { now: () => Date.now() };

/** A successful run retires this long after its `agent_end`. */
export const RUN_RETIRE_AFTER_MS = 30_000;

/**
 * Bounds that keep the capture bookkeeping finite on a long-lived gateway
 * (flair#1884 round 2, F2). Exported so a test can drive them small; production
 * uses these values.
 */
export const captureBounds = {
  /** Retire a run that has seen NO `agent_end` after this much inactivity. */
  idleRunRetireMs: 30 * 60_000,
  /**
   * The ONE capacity budget (round 4): the number of records in the run map.
   * Round 5: a record holds its slot from admission until `removable()` is true
   * — it is retired or aborted, has no write in flight, and has aged past
   * `tombstoneMinAgeMs`.
   */
  capacityCap: 10_000,
  /**
   * A retired/aborted record is kept at least this long — the longest plausible
   * callback delay — so a late callback is dropped, never re-admitted. Only
   * `removable()` frees a slot, and it is the same predicate for the sweep and
   * for admission.
   */
  tombstoneMinAgeMs: 60 * 60_000,
  /**
   * Round 5: an abort for a run that was NEVER admitted must still be recorded,
   * or its next callback is admitted and captured (the failed-run re-admission
   * the round-4 review found). The abort path may therefore exceed
   * `capacityCap` by at most this many records. When even that overflow is
   * full, the abort records nothing and logs once — the documented residual.
   */
  abortOverflowCap: 1_000,
  /** Max distinct one-time log keys remembered; the oldest are evicted. */
  logOnceCap: 10_000,
  /** How often the unref'd sweep timer runs. */
  sweepIntervalMs: 30_000,
};

/** Test introspection into the ONE run map (see `captureBounds`). */
export const captureInternals: {
  /** Records in the map. The budget IS the map's size (round 5). */
  runCount: () => number;
  /** Alias of `runCount`, kept for the round-4 budget assertions. */
  budgetUsed: () => number;
  /** Records that can still capture: phase `live` or `ended`. */
  stateCount: () => number;
  /** Records waiting out `tombstoneMinAgeMs`: phase `retired` or `aborted`. */
  tombstoneCount: () => number;
  logOnceCount: () => number;
  /** The record for a run BY IDENTITY, or undefined (round-5 tests). */
  recordOf: (agentId: string, runId: string) => RunRecord | undefined;
} = {
  runCount: () => 0,
  budgetUsed: () => 0,
  stateCount: () => 0,
  tombstoneCount: () => 0,
  logOnceCount: () => 0,
  recordOf: () => undefined,
};

/** Round 5: a run's phase in the ONE run map. */
export type RunPhase = "live" | "ended" | "aborted" | "retired";

/**
 * ONE record per run (round 5). The capture state, the retired/aborted
 * tombstone and the capacity accounting are the SAME structure — the budget is
 * the size of the run map. A record holds its slot from admission until
 * `removable()` is true, so retiring or aborting a run changes its phase IN
 * PLACE and never adds an entry.
 *
 * Keyed by agent + runId — never by agent alone, or two concurrent runs of one
 * agent would share a budget and a dedup set and collide. The record carries
 * the run's AbortController (item 5) and the reservation: the per-session cap
 * slot (`count`) and the dedup set (`hashes`).
 *
 * Lifecycle: a SUCCESSFUL `agent_end` moves the run to `ended` but does NOT
 * delete it — the host can dispatch `agent_end` BEFORE `llm_output` for the
 * same run, and that later capture must still land. An `ended` run retires
 * after `RUN_RETIRE_AFTER_MS` with no in-flight writes; a run that never saw
 * `agent_end` retires after `idleRunRetireMs` idle. Phase `retired` or
 * `aborted` is terminal: a callback for such a record is dropped with a
 * one-time log naming the run id, and the record leaves the map only through
 * `removable()`.
 */
export interface RunRecord extends CaptureState {
  agentId: string;
  runId: string;
  phase: RunPhase;
  /** In-flight capture writes for this run. */
  inFlight: number;
  /** `captureClock.now()` of the last callback for this run (idle-retire clock). */
  lastActivityAt: number;
  /** `captureClock.now()` of the successful `agent_end`, or null. */
  endedAt: number | null;
  /** `captureClock.now()` at retirement/abort — the age clock for `removable()`. */
  retiredAt: number | null;
  /** One AbortController per run, owned by the plugin (agent hooks carry none). */
  controller: AbortController;
}

function createRunRecord(agentId: string, runId: string, now: number): RunRecord {
  return {
    agentId,
    runId,
    count: 0,
    hashes: new Set(),
    phase: "live",
    inFlight: 0,
    lastActivityAt: now,
    endedAt: null,
    retiredAt: null,
    controller: new AbortController(),
  };
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

/**
 * Injectable entity scan (round 6). Production uses the real `detectEntities`;
 * a test substitutes it to make the scan THROW. That throw must leave the run's
 * reservation untouched: nothing that can throw may sit between taking the
 * reservation and the `try` whose failure path releases it, or `inFlight`
 * strands above 0 and the record is never removable.
 */
export const captureProbe: {
  detectEntities: (text: string) => Array<{ name: string; kind: string; confidence: number }>;
} = {
  detectEntities: (text) => detectEntities(text),
};

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
      (client as any).request = async (method: string, path: string, body?: unknown, opts?: { signal?: AbortSignal }) => {
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
        return original(method, path, body, opts);
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

    // ── Round 5: ONE record per run; the budget IS the map's size ─────────
    // Four rounds of fixes kept leaking at the boundary between the live-state
    // map, the tombstone set and the budget counters, so they are now ONE map.
    // A run holds a slot from admission until `removable()` is true.
    // State is keyed by agent + runId: keying by agent alone made two concurrent
    // runs share a budget and a dedup set and collide. The run's AbortController
    // is created with the record.
    const runs = new Map<string, RunRecord>();
    const loggedOnce = new Set<string>();
    /**
     * Round 13: set by `gateway_stop` BEFORE it aborts anything or clears the
     * map, and never cleared here — a later registration builds a new map and
     * its own gate. `gateway_stop` clears the map, so without this flag a late
     * callback that finds no record is re-admitted as a NEW run and starts a
     * write after the abort, with the sweep timer already stopped and nothing
     * left to retire it. `captureGate` refuses while it is set, which is what
     * makes clearing the map safe.
     */
    let captureStopped = false;
    const runKeyOf = (agentId: string, runId: string): string => `${agentId}\u0000${runId}`;

    function countWhere(p: (r: RunRecord) => boolean): number {
      let n = 0;
      for (const r of runs.values()) if (p(r)) n++;
      return n;
    }

    // Wire the test introspection once this registration owns the map.
    captureInternals.runCount = () => runs.size;
    captureInternals.budgetUsed = () => runs.size;
    captureInternals.stateCount = () => countWhere((r) => r.phase === "live" || r.phase === "ended");
    captureInternals.tombstoneCount = () => countWhere((r) => r.phase === "retired" || r.phase === "aborted");
    captureInternals.logOnceCount = () => loggedOnce.size;
    captureInternals.recordOf = (agentId, runId) => runs.get(runKeyOf(agentId, runId));

    /** Evict the oldest entries of an insertion-ordered Set down to `cap`. */
    function capSet(set: Set<string>, cap: number): void {
      while (set.size > cap) {
        const oldest = set.values().next().value as string | undefined;
        if (oldest === undefined) break;
        set.delete(oldest);
      }
    }

    function logOnce(key: string, line: string): void {
      if (loggedOnce.has(key)) return;
      loggedOnce.add(key);
      if (loggedOnce.size > captureBounds.logOnceCap) capSet(loggedOnce, captureBounds.logOnceCap);
      api.logger.warn(line);
    }

    /**
     * Round 10 (guarantee 6): a callback that carried no agent identity used to
     * warn on EVERY occurrence — an unbounded run of identical lines. It goes
     * through the bounded one-time path now. On this path there is no agent
     * identity to key by, so the key is the callback source: at most one line per
     * hook, however many identity-less callbacks the host delivers.
     */
    function refuseIdentity(hook: string): void {
      logOnce(
        `no-identity:${hook}`,
        `openclaw-flair: ${hook} refused: no agent identity in host context — refusing rather than inheriting one`,
      );
    }

    /**
     * Round 11 (guarantee 6): a callback that carried a VALID identity but no
     * usable key refuses on EVERY occurrence — the same line, unbounded. Those
     * refusals go through the bounded one-time path too. With no identity to key
     * by (the prompt hook can be delivered without one) the key says so.
     *
     * Round 12 (guarantee 6): the key is the agent AND the site AND the error
     * CLASS (`errorClass`, above) — a failure's KIND, not its instance. Keying by
     * agent ALONE silenced a LATER, DIFFERENT failure for the same agent: a
     * missing key at 10:00 hid an HTTP 500 on a capture write at 11:00, which is
     * exactly the line an operator needs. Now every distinct failure logs once,
     * and repeats of it do not. The key set stays bounded by `logOnceCap`.
     */
    function refuseKey(agentId: string | undefined, site: string, err: unknown): void {
      const who = typeof agentId === "string" && agentId.length > 0 ? agentId : "no-identity";
      const message = (err as any)?.message ?? String(err);
      logOnce(`refused-callback:${who}:${site}:${errorClass(err)}`, `openclaw-flair: ${site} refused/failed: ${message}`);
    }

    /**
     * THE removal predicate (round 5) — the ONLY thing that frees a slot, used
     * by the sweep and by admission alike: a record may be removed when it is
     * retired or aborted, has NO write in flight, and has aged past
     * `tombstoneMinAgeMs`. A record with a write still in flight is never
     * removed, so a later abort can still discard its late result.
     */
    function removable(r: RunRecord, now: number): boolean {
      return (
        (r.phase === "retired" || r.phase === "aborted") &&
        r.inFlight === 0 &&
        r.retiredAt !== null &&
        now - r.retiredAt >= captureBounds.tombstoneMinAgeMs
      );
    }

    /** Drop every removable record — the sweep's and admission's shared step. */
    function purgeRemovable(now: number): void {
      for (const [key, r] of runs) if (removable(r, now)) runs.delete(key);
    }

    /** The run id for a callback, from the event or the hook context. */
    function runIdOf(event: any, ctx: any): string | null {
      const raw = event?.runId ?? ctx?.runId;
      return typeof raw === "string" && raw.length > 0 ? raw : null;
    }

    /**
     * Retire a run IN PLACE (round 5): the SAME record keeps the SAME slot, so
     * retirement never adds an entry and never needs new room.
     */
    function retire(r: RunRecord, now: number): void {
      if (r.phase === "retired" || r.phase === "aborted") return;
      r.phase = "retired";
      r.retiredAt = now;
    }

    /**
     * The time-based sweep, unchanged in its rules (round 4 adjudicated the
     * "refusal mutates state" finding NOT a defect: retirement that is due is
     * not eviction to make room). It runs on each callback and on the unref'd
     * interval timer, retires (a) ended runs by the 30 s rule and (b) runs that
     * have seen NO `agent_end` after the idle bound — both IN PLACE — and then
     * drops whatever `removable()` allows. It NEVER evicts a live record to
     * make room: the budget is enforced at admission.
     */
    function sweep(): void {
      const now = captureClock.now();
      for (const [key, r] of runs) {
        if (r.phase === "ended" && r.inFlight === 0 && r.endedAt !== null && now - r.endedAt >= RUN_RETIRE_AFTER_MS) {
          retire(r, now);
        }
        if (r.phase === "live" && now - r.lastActivityAt >= captureBounds.idleRunRetireMs) {
          retire(r, now);
        }
        if (removable(r, now)) runs.delete(key);
      }
    }

    /**
     * The record a callback should use, or null when it must not capture. A
     * record is ADDED only here:
     *   0. `gateway_stop` has run: NOTHING is admitted (round 13) — the map it
     *      cleared is gone, so a record-less callback would otherwise be
     *      re-admitted as a new run and start a write after the abort;
     *   1. a record for the key exists: serve it (phase `live`/`ended`) or drop
     *      the callback (phase `retired`/`aborted`) with the one-time log — a
     *      retired or aborted run is NEVER re-admitted;
     *   2. a key with NO record: purge what is removable, then admit ONLY when
     *      the map is below `capacityCap` — the abort overflow is never counted
     *      as room;
     *   3. otherwise refuse (`capture-capacity: full`, logged once) and change
     *      nothing else.
     */
    function captureGate(agentId: string, runId: string | null): RunRecord | null {
      if (captureStopped) {
        logOnce(
          "capture-stopped",
          `openclaw-flair: refused capture: the gateway is stopping (gateway_stop) — no new run is admitted and no write starts for agent ${agentId}`,
        );
        return null;
      }
      if (!runId) {
        logOnce(
          `no-run-id:${agentId}`,
          `openclaw-flair: refused capture for agent ${agentId}: the host hook carried no runId (capture state is per run)`,
        );
        return null;
      }
      const key = runKeyOf(agentId, runId);
      const now = captureClock.now();

      // The time-based sweep runs on every callback, so a retirement that is due
      // happens before this callback decides (the timer covers the callbacks
      // that return early).
      sweep();

      const existing = runs.get(key);
      if (existing) {
        if (existing.phase === "aborted" || existing.phase === "retired") {
          logOnce(`dropped:${key}`, `openclaw-flair: dropped a callback for retired run ${runId} (agent ${agentId})`);
          return null;
        }
        existing.lastActivityAt = now;
        return existing;
      }

      purgeRemovable(now);
      if (runs.size >= captureBounds.capacityCap) {
        logOnce(
          "capacity-full",
          `openclaw-flair: capture skipped: capture-capacity: full — ${runs.size} runs hold the whole budget of ${captureBounds.capacityCap}; refusing new run ${runId} (agent ${agentId})`,
        );
        return null;
      }

      const fresh = createRunRecord(agentId, runId, now);
      runs.set(key, fresh);
      return fresh;
    }

    /**
     * Abort a run: cancel its in-flight capture fetches, discard late results
     * and make every later callback for the run a no-op. An ADMITTED run changes
     * phase IN PLACE — its slot becomes its own tombstone, so an abort never
     * needs room. A run that was NEVER admitted ALWAYS gets an aborted record
     * (round 5), even at the cap, using an overflow of at most
     * `abortOverflowCap`: recording nothing there would let the run's next
     * callback be admitted and captured — exactly the failed-run re-admission
     * the round-4 review found. If even the overflow is full the record is not
     * inserted and the line is logged once (the documented residual); it is safe
     * because admission is refused while the budget AND its overflow are full.
     *
     * Round 13 guard: while `captureStopped` is set there is no registration to
     * record into — `gateway_stop` has cleared the map and nothing more is
     * admitted — so an abort for a run the registry never saw inserts NOTHING and
     * returns after the rate-limited line. An abort that still inserted would
     * leave the stopped registration holding a record no later callback can use.
     */
    function abortRun(agentId: string, runId: string | null, why: string): void {
      if (!runId) {
        logOnce(
          `no-run-id-abort:${agentId}`,
          `openclaw-flair: could not abort a run for agent ${agentId}: the host hook carried no runId`,
        );
        return;
      }
      const key = runKeyOf(agentId, runId);
      const now = captureClock.now();
      const existing = runs.get(key);
      if (existing) {
        if (existing.phase === "aborted") return; // already aborted (idempotent)
        // An abort acts on ANY record still in the map, retired or not: a run
        // idle-retired with a write in flight is still aborted here, so its late
        // result is discarded. The phase changes IN PLACE — no new entry.
        existing.phase = "aborted";
        existing.retiredAt = now;
        try {
          existing.controller.abort(why);
        } catch { /* an abort listener must not break the hook */ }
        return;
      }
      // Never admitted, and the gateway is stopping: there is no live
      // registration left to record into, so this abort inserts nothing. It is
      // rate-limited like the other refusal lines (round 13).
      if (captureStopped) {
        logOnce(
          "abort-stopped",
          `openclaw-flair: refused to record an abort: the gateway is stopping (gateway_stop) — aborted run ${runId} (agent ${agentId}) is not recorded`,
        );
        return;
      }
      // Never admitted: record the abort so no later callback can re-admit it.
      // Round 6: this path ASKS FOR ROOM, so it purges first — the same rule as
      // admission. Without the purge, a map full of AGED aborted records reads
      // as full and the abort records nothing; the run's next callback is then
      // admitted by admission's own purge, so a capture write starts AFTER the
      // abort.
      purgeRemovable(now);
      if (runs.size >= captureBounds.capacityCap + captureBounds.abortOverflowCap) {
        logOnce(
          "abort-overflow",
          `openclaw-flair: capture skipped: capture-capacity: abort-overflow — the abort overflow of ${captureBounds.abortOverflowCap} above the budget of ${captureBounds.capacityCap} is full; aborted run ${runId} (agent ${agentId}) is not recorded`,
        );
        return;
      }
      const aborted = createRunRecord(agentId, runId, now);
      aborted.phase = "aborted";
      aborted.retiredAt = now;
      runs.set(key, aborted);
    }

    async function tryAutoCapture(client: FlairClient, agentId: string, runId: string | null, text: string): Promise<boolean> {
      const state = captureGate(agentId, runId);
      if (!state) return false;
      const decision = evaluateAutoCapture(text, state, autoCaptureMaxPerSession);
      if (!decision) return false;
      // Round 6: the entity scan is COMPUTED BEFORE the reservation. It must not
      // sit between the reservation and the `try` below — a throw there would
      // strand `inFlight` above 0, and the record would never become removable
      // again (a slot held for the life of the process). Nothing that can throw
      // may sit between taking the reservation and the block that releases it.
      // The scan is synchronous, so the reservation stays synchronous too.
      const entities = captureProbe.detectEntities(text);
      const subject = entities.length > 0 ? entities[0].name.toLowerCase() : undefined;
      // D10: take the cap slot and claim the excerpt SYNCHRONOUSLY, before any
      // await, so a concurrent callback (or the agent_end rescan) that sees the
      // same excerpt dedups against the reservation instead of writing twice.
      state.count++;
      state.hashes.add(decision.hash);
      state.inFlight++;
      try {
        await client.memory.write(decision.excerpt, {
          type: "session",
          tags: ["auto-captured"],
          subject,
          // Item 5: the run's signal reaches the fetch, so an abort cancels an
          // in-flight capture rather than letting it finish.
          signal: state.controller.signal,
        });
      } catch (err) {
        // The write failed: release the reservation so a later rescan may retry.
        state.inFlight--;
        state.count--;
        state.hashes.delete(decision.hash);
        throw err;
      }
      state.inFlight--;
      if (state.phase === "aborted") {
        // Item 5: a result that resolves after the abort is DISCARDED — release
        // the reservation and never report it as a capture. This cannot UNWRITE
        // a request Flair already received (see the README's abort guarantee).
        state.count--;
        state.hashes.delete(decision.hash);
        logOnce(
          `discarded:${runKeyOf(agentId, runId as string)}`,
          `openclaw-flair: discarded a capture for run ${runId} (agent ${agentId}) that completed after the run was aborted`,
        );
        return false;
      }
      // Round 5: nothing to finalize — a settled write leaves the record in
      // place, and only `removable()` frees its slot.
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
          let memId: string | null = null;
          try {
            const client = clientFor(ctx.agentId);
            // D11: no hand-built id. The client's canonical UUID path owns
            // memory ids (`agentId-<uuid>`), so two writes in the same
            // millisecond never address the same record.
            const result = await client.memory.write(text, {
              tags,
              durability,
              type,
              dedup: !supersedes,
              dedupThreshold: 0.7,
            });
            memId = typeof (result as any).id === "string" ? (result as any).id : null;
            const errors: string[] = [];
            let supersedeClosed: true | false | "not-found" = false;
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
                  supersedeClosed = true;
                } else {
                  supersedeClosed = "not-found";
                  api.logger.warn(
                    `openclaw-flair: supersede target ${supersedes} not found — new memory ${memId} written; nothing to close`,
                  );
                }
              } catch (closeErr: any) {
                errors.push(`supersede-close failed for ${supersedes}: ${closeErr.message}`);
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
              // D14: machine-readable and honest. `written` is true only after the
              // PRIMARY write succeeded; a partial success (memory written,
              // supersede-close failed) is reported as exactly that via `errors`.
              details: {
                written: true,
                id: memId,
                supersedeClosed,
                errors,
                deduplicated: wasDeduplicated,
                ...(wasDeduplicated ? { matchedId: (result as any).matchedId } : {}),
              },
            };
          } catch (err: any) {
            api.logger.warn(`openclaw-flair: store refused/failed: ${err.message}`);
            // D14: an unresolved identity is its own outcome, never a silent
            // return and never written:true.
            const noIdentity = /no agent identity|invalid agent identity|not in the configured allow-list/i.test(String(err?.message ?? ""));
            return {
              content: [{ type: "text", text: `Memory store unavailable: ${err.message}` }],
              details: noIdentity
                ? { written: false, reason: "no-identity", id: null, supersedeClosed: false, errors: [err.message] }
                : { written: false, id: null, supersedeClosed: false, errors: [err.message] },
            };
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
            refuseKey(agentId, "bootstrap recall", err);
          }
          return;
        });
      }
    }

    // ── 8. Capture — permission-gated, OFF by default. ─────────────────────
    // Capture reads conversation content ONLY through the permission-gated
    // hooks; a missing permission produces a visible status line and no reads.
    //
    // Which callbacks capture, and why BOTH shapes are needed: `agent_end` is
    // the full-session rescan for a discrete run, and `llm_input` / `llm_output`
    // cover a live turn — the only shape that fires in a long-lived persistent
    // gateway session, where a run never ends and `agent_end` never arrives.
    // Both feed the same per-run record and the same gate; the unref'd sweep
    // timer below covers the callbacks that return early.
    if (!allowConversationAccess) {
      // R8: reported whenever the permission is withheld, whether or not
      // capture is enabled.
      api.logger.warn("openclaw-flair: capture disabled (permission)");
    } else if (autoCapture) {
        // F2: an unref'd interval sweeps ALL states even when no callback is
        // arriving — an idle run that never saw `agent_end` would otherwise
        // live forever. unref() so the timer never keeps the process alive; it
        // is cleared on gateway_stop.
        const sweepTimer = setInterval(() => {
          try { sweep(); } catch { /* a timer callback must never throw */ }
        }, captureBounds.sweepIntervalMs);
        (sweepTimer as any).unref?.();

        api.on("agent_end", async (event: any, ctx: any) => {
          const agentId = ctx?.agentId;
          if (!agentId) {
            refuseIdentity("agent_end");
            return;
          }
          const runId = runIdOf(event, ctx);
          // Item 5(a): a failed run is ABORTED — no capture, and every in-flight
          // capture for the run is cancelled and discarded. A successful
          // agent_end never aborts.
          if (event?.success === false) {
            abortRun(agentId, runId, "agent_end reported the run failed");
            return;
          }
          const state = captureGate(agentId, runId);
          if (!state) return;
          // A successful agent_end ENDS the run but does NOT delete its record:
          // the host can dispatch agent_end BEFORE llm_output for this run, and
          // that later capture must still land. An `ended` record retires (30 s,
          // no in-flight writes) via the sweep on a later callback.
          state.phase = "ended";
          state.endedAt = captureClock.now();
          try {
            const client = clientFor(agentId);
            const messages = (event?.messages ?? []) as Array<{ role: string; content?: unknown }>;
            let stored = 0;
            for (const msg of messages) {
              if (msg.role !== "user" && msg.role !== "assistant") continue;
              const text = captureText(msg.content);
              if (!text) continue;
              if (await tryAutoCapture(client, agentId, runId, text)) stored++;
            }
            if (stored > 0) api.logger.info(`openclaw-flair: auto-captured ${stored} memories`);
          } catch (err: any) {
            refuseKey(agentId, "auto-capture", err);
          }
        });

        api.on("llm_input", async (event: any, ctx: any) => {
          const agentId = ctx?.agentId;
          if (!agentId) {
            refuseIdentity("llm_input");
            return;
          }
          const text = captureText(event?.prompt);
          // No text → no capture, and no sweep here either; the unref'd sweep
          // timer covers these early returns.
          if (!text) return;
          try {
            const client = clientFor(agentId);
            const captured = await tryAutoCapture(client, agentId, runIdOf(event, ctx), text);
            if (captured) api.logger.info("openclaw-flair: auto-captured 1 memory from live turn (llm_input)");
          } catch (err: any) {
            refuseKey(agentId, "live auto-capture (llm_input)", err);
          }
        });

        api.on("llm_output", async (event: any, ctx: any) => {
          const agentId = ctx?.agentId;
          if (!agentId) {
            refuseIdentity("llm_output");
            return;
          }
          const texts = Array.isArray(event?.assistantTexts) ? event.assistantTexts : [];
          const text = captureText(texts.map((t: unknown) => (typeof t === "string" ? { type: "text", text: t } : t)));
          // No text → no capture (the unref'd sweep timer covers the sweep here).
          if (!text) return;
          try {
            const client = clientFor(agentId);
            const captured = await tryAutoCapture(client, agentId, runIdOf(event, ctx), text);
            if (captured) api.logger.info("openclaw-flair: auto-captured 1 memory from live turn (llm_output)");
          } catch (err: any) {
            refuseKey(agentId, "live auto-capture (llm_output)", err);
          }
        });

        // Item 5(b): gateway_stop aborts every in-flight run and stops the
        // sweep timer (F2).
        api.on("gateway_stop", async () => {
          // Round 13: the stop flag goes FIRST — before the aborts and before the
          // clear. While it is set `captureGate` admits nothing, and that is
          // what makes `runs.clear()` safe: a late callback that finds no record
          // is refused instead of being admitted as a NEW run (the failed-run
          // re-admission the abort tombstones exist to prevent), which would
          // start a write after the abort with the sweep timer stopped.
          captureStopped = true;
          try { clearInterval(sweepTimer); } catch { /* already cleared */ }
          for (const record of [...runs.values()]) {
            abortRun(record.agentId, record.runId, "gateway_stop");
          }
          // Round 6: stopping the gateway drops the map as well. The aborts above
          // cancel every live controller; clearing the records stops them being
          // reachable through `captureInternals` until the next registration.
          runs.clear();
        });

        // Item 5(c): model_call_ended with failureKind "aborted". Used only
        // because PluginHookModelCallBaseEvent carries `runId`; the SDK type for
        // that base event includes it, so the abort can be correlated to a run.
        api.on("model_call_ended", async (event: any, ctx: any) => {
          if (event?.failureKind !== "aborted") return;
          const agentId = ctx?.agentId;
          if (!agentId) return;
          abortRun(agentId, runIdOf(event, ctx), "model_call_ended reported the call was aborted");
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
