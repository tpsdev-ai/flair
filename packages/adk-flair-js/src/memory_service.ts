/**
 * FlairMemoryService — Flair as the memory backend for Google ADK (JS/TS).
 *
 * Implements @google/adk's `BaseMemoryService` interface (2 required methods)
 * plus the Vertex-parity extras (`addEventsToMemory`, `addMemory`) and the
 * Flair-specific `listMemories` browsing extension.
 *
 * Ported from the Python `adk-flair` package. See specs/ADK-FLAIR-ADAPTER.md
 * in the tpsdev-ai/cli repo for the full design; customMetadata/subject/
 * listMemories semantics mirror the Python package's flair#1332/#1333
 * implementation (#1334), and the create-verb semantics mirror flair#1336
 * (#1339).
 */

import type { BaseMemoryService, SearchMemoryRequest, SearchMemoryResponse } from "@google/adk";
import type { MemoryEntry } from "@google/adk";
import type { Session } from "@google/adk";
import type { Event } from "@google/adk";
import type { Content } from "@google/genai";
import * as crypto from "node:crypto";
import { loadEd25519Key, signRequest } from "./signing.js";
import { compoundTag } from "./tag.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const ALLOW_REMOTE_ENV = "FLAIR_ALLOW_REMOTE_URL";
const DEFAULT_FLAIR_URL = "http://localhost:19926";

// customMetadata caps (flair#1332, Sherlock hard requirements — mirrors the
// Python package). REJECT, never truncate — a truncated blob silently corrupts
// the store-and-return round-trip guarantee, which is the entire contract of
// the field.
//   - METADATA_MAX_BYTES: serialized JSON size cap. 64KB is generous for
//     structured attributes (merchant/price/category/media refs) while keeping
//     a single memory record from becoming a blob store.
//   - METADATA_MAX_DEPTH / METADATA_MAX_KEYS: cheap structural caps checked
//     BEFORE serialization (billion-laughs-adjacent guard — a pathologically
//     nested/wide object is refused without ever attempting to serialize it).
const METADATA_MAX_BYTES = 64 * 1024;
const METADATA_MAX_DEPTH = 16;
const METADATA_MAX_KEYS = 512;

// subject cap (flair#1332): subject is a short human-readable title promoted
// to the record's top-level indexed `subject` column — never a content field.
const SUBJECT_MAX_CHARS = 512;

// listMemories page-size hard cap (flair#1333). Reject-with-error (never
// clamp) — consistent with every other adk-flair validation: a silently
// clamped limit would make "I asked for 500, why did I get 200" a debugging
// session instead of an immediate, actionable error.
const LIST_MEMORIES_MAX_LIMIT = 200;

// Valid enum values for the explicit write knobs (mirrors the Python
// package's flair#1234/#1238 validation).
const VALID_DURABILITIES = new Set(["permanent", "persistent", "standard", "ephemeral"]);
const VALID_VISIBILITIES = new Set(["private", "shared"]);

// ─── Public types ───────────────────────────────────────────────────────────

/** Explicit write knobs accepted by the Memory schema. */
export type FlairDurability = "permanent" | "persistent" | "standard" | "ephemeral";
export type FlairVisibility = "private" | "shared";

/**
 * A MemoryEntry as returned by this service's read paths (searchMemory /
 * listMemories).
 *
 * @google/adk's `MemoryEntry` is a plain-object interface (content, author?,
 * timestamp?) — unlike the Python package's pydantic model it drops nothing at
 * runtime, so Flair surfaces its extra fields BOTH top-level and (for
 * `subject`) inside `customMetadata`:
 *
 * - `customMetadata` — the stored metadata blob parsed back to an object
 *   (fail-soft `{}` + warning on a malformed blob). When the record carries a
 *   top-level `subject` column it is ALSO surfaced as
 *   `customMetadata["subject"]` — the column is authoritative over any
 *   divergent blob key, and this channel keeps the return shape identical to
 *   the Python package (whose MemoryEntry has no subject attribute, making
 *   custom_metadata its only subject return channel).
 * - `subject` — the top-level subject column, surfaced directly as well
 *   (JS-only convenience; same value as `customMetadata["subject"]`).
 * - `id` — the Flair record id.
 */
export interface FlairMemoryEntry extends MemoryEntry {
  /** Flair Memory record id. */
  id?: string;
  /** Top-level `subject` column value, when the record carries one. */
  subject?: string;
  /** Stored customMetadata blob, parsed back. Always present (possibly {}). */
  customMetadata: Record<string, unknown>;
}

/** searchMemory response with the Flair-typed entries. */
export interface FlairSearchMemoryResponse extends SearchMemoryResponse {
  memories: FlairMemoryEntry[];
}

/**
 * Options for `addMemory` (flair#1332 + Python-parity explicit knobs).
 *
 * All are trust-anchor opt-ins — never model-selected, never sourced from
 * `customMetadata` (except `subject`, which `customMetadata.subject` may also
 * supply; the explicit option is authoritative when both are present).
 */
export interface AddMemoryOptions {
  /**
   * Short human-readable title promoted to the record's top-level indexed
   * `subject` column. <= 512 chars (rejects beyond). Never auto-extracted
   * from content. Authoritative over `customMetadata["subject"]`.
   */
  subject?: string;
  /**
   * Explicit durability. Omitted → "standard" in the body (unchanged
   * behaviour). One of permanent | persistent | standard | ephemeral.
   */
  durability?: FlairDurability;
  /**
   * Explicit visibility. Omitted → no visibility key in the body (server
   * applies its durability-keyed default). One of private | shared.
   */
  visibility?: FlairVisibility;
}

/** Options for `listMemories` (flair#1333). */
export interface ListMemoriesOptions {
  /** Page size, 1..200. Over-cap REJECTS (never silently clamps). Default 50. */
  limit?: number;
  /** Number of newest records to skip (>= 0). Positional, not a live cursor. */
  offset?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isLocalhost(hostname: string): boolean {
  return LOCALHOST_HOSTS.has(hostname);
}

function resolveUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `FLAIR_URL: invalid URL: ${raw}`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `FLAIR_URL: unsupported protocol "${url.protocol}" — must be http or https`
    );
  }
  return url;
}

function epochMsToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function extractText(content: Content | undefined): string {
  if (!content || !content.parts) return "";
  return content.parts
    .map((p: { text?: string }) => p.text ?? "")
    .filter(Boolean)
    .join(" ");
}

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── customMetadata / subject (flair#1332 — mirrors the Python package) ─────

/**
 * Structural caps on customMetadata, checked BEFORE serialization.
 *
 * Rejects nesting deeper than METADATA_MAX_DEPTH levels or more than
 * METADATA_MAX_KEYS total object keys (counted across every level) with an
 * Error. Iterative traversal — no recursion, so adversarial nesting can't
 * blow the stack; a self-referencing structure terminates via the depth cap
 * (each revisit is pushed one level deeper), so a circular blob is rejected
 * here and never reaches JSON.stringify.
 */
function validateMetadataShape(customMetadata: Record<string, unknown>): void {
  const stack: Array<[unknown, number]> = [[customMetadata, 1]];
  let keyCount = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (depth > METADATA_MAX_DEPTH) {
      throw new Error(
        `customMetadata nesting exceeds ${METADATA_MAX_DEPTH} levels — ` +
        "flatten the structure, or store a reference to the data instead " +
        "of embedding it"
      );
    }
    let children: Iterable<unknown>;
    if (Array.isArray(node)) {
      children = node;
    } else if (isPlainObjectLike(node)) {
      const keys = Object.keys(node);
      keyCount += keys.length;
      if (keyCount > METADATA_MAX_KEYS) {
        throw new Error(
          `customMetadata carries more than ${METADATA_MAX_KEYS} keys ` +
          "in total — split the data across memories, or store a " +
          "reference to it instead"
        );
      }
      children = keys.map((k) => node[k]);
    } else {
      continue;
    }
    for (const child of children) {
      if (Array.isArray(child) || isPlainObjectLike(child)) {
        stack.push([child, depth + 1]);
      }
    }
  }
}

/**
 * Serialize customMetadata to the JSON string stored in Memory.metadata.
 *
 * Store-and-return contract (flair#1202): the blob is opaque to the server —
 * stored verbatim, returned verbatim, no key in it influences any server
 * decision.
 *
 * - Structural caps (depth/key-count) and the serialized 64KB cap REJECT
 *   with an Error — never truncate (truncation corrupts the round-trip
 *   guarantee; Sherlock hard requirement, mirrored from the Python package).
 * - A non-serializable VALUE skips that key with a warning naming the
 *   session key — one bad value must not discard the caller's whole blob.
 *   (In JS "non-serializable" means JSON.stringify yields undefined —
 *   functions, symbols, bare undefined — or throws: BigInt. Object keys are
 *   always strings in JS, so the Python non-string-key skip has no analogue.)
 *
 * Returns null when there is nothing to store (no metadata, or every key
 * was skipped).
 */
function serializeCustomMetadata(
  customMetadata: Record<string, unknown> | undefined,
  contextKey: string,
): string | null {
  if (!customMetadata || Object.keys(customMetadata).length === 0) return null;

  validateMetadataShape(customMetadata);

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(customMetadata)) {
    let probe: string | undefined;
    try {
      probe = JSON.stringify(value);
    } catch {
      probe = undefined;
    }
    if (probe === undefined) {
      console.warn(
        `[adk-flair] customMetadata key "${key}" skipped — value is not ` +
        `JSON-serializable (session=${contextKey})`
      );
      continue;
    }
    clean[key] = value;
  }

  if (Object.keys(clean).length === 0) return null;

  const serialized = JSON.stringify(clean);
  const size = Buffer.byteLength(serialized, "utf8");
  if (size > METADATA_MAX_BYTES) {
    throw new Error(
      `customMetadata serializes to ${size} bytes, over the ` +
      `${METADATA_MAX_BYTES}-byte cap — store large payloads elsewhere ` +
      "and keep a reference here. Rejected rather than truncated: a " +
      "truncated blob would silently corrupt the store-and-return " +
      "round-trip guarantee."
    );
  }
  return serialized;
}

/**
 * Resolve the top-level `subject` column value (flair#1332).
 *
 * Precedence: an explicit subject option is authoritative over
 * customMetadata["subject"] when both are supplied. NEVER auto-extracted
 * from content. Rejects non-string or over-cap (512 chars) values with an
 * Error — subject is a short human-readable title promoted to an indexed
 * column, not a content field. Returns null when neither source supplies
 * one (empty strings resolve to null — nothing to promote).
 */
function resolveSubject(
  explicitSubject: string | undefined,
  customMetadata: Record<string, unknown> | undefined,
): string | null {
  let subject: unknown = explicitSubject;
  let source = "subject option";
  if ((subject === undefined || subject === null) && customMetadata !== undefined) {
    subject = customMetadata["subject"];
    source = 'customMetadata["subject"]';
  }
  if (subject === undefined || subject === null) return null;
  if (typeof subject !== "string") {
    throw new Error(
      `${source} must be a string (got: ${typeof subject}) — ` +
      "subject is promoted to the record's top-level subject column"
    );
  }
  if (subject.length > SUBJECT_MAX_CHARS) {
    throw new Error(
      `${source} is ${subject.length} characters, over the ` +
      `${SUBJECT_MAX_CHARS}-char cap — subject is a short ` +
      "human-readable title; put longer text in content or customMetadata"
    );
  }
  return subject || null;
}

// ─── FlairMemoryService ─────────────────────────────────────────────────────

export class FlairMemoryService implements BaseMemoryService {
  private readonly _url: string;
  private readonly _agentId: string;
  private readonly _privateKey: crypto.KeyObject;
  private readonly _timeoutMs: number;

  /**
   * @param url - Flair HTTP URL (default: FLAIR_URL env or http://localhost:19926)
   * @param agentId - Flair agent ID (default: FLAIR_AGENT_ID env)
   * @param keyfile - Path to Ed25519 PKCS8 base64 keyfile (default: FLAIR_KEYFILE env)
   * @param timeoutMs - Total request timeout in ms (default: 2000)
   */
  constructor(opts?: {
    url?: string;
    agentId?: string;
    keyfile?: string;
    timeoutMs?: number;
  }) {
    const rawUrl = opts?.url ?? process.env["FLAIR_URL"] ?? DEFAULT_FLAIR_URL;
    const parsed = resolveUrl(rawUrl);

    // URL gate: non-localhost requires explicit opt-in
    if (!isLocalhost(parsed.hostname)) {
      if (process.env[ALLOW_REMOTE_ENV] !== "1") {
        throw new Error(
          `FLAIR_URL: refused non-localhost URL "${rawUrl}" — ` +
          `set ${ALLOW_REMOTE_ENV}=1 to allow remote Flair instances`
        );
      }
    }

    this._url = parsed.origin;

    const agentId = opts?.agentId ?? process.env["FLAIR_AGENT_ID"];
    if (!agentId) {
      throw new Error(
        "FLAIR_AGENT_ID: missing — set FLAIR_AGENT_ID or pass agentId to constructor"
      );
    }
    this._agentId = agentId;

    const keyfile = opts?.keyfile ?? process.env["FLAIR_KEYFILE"];
    if (!keyfile) {
      throw new Error(
        "FLAIR_KEYFILE: missing — set FLAIR_KEYFILE or pass keyfile to constructor"
      );
    }
    this._privateKey = loadEd25519Key(keyfile);

    this._timeoutMs = opts?.timeoutMs ?? 2000;
  }

  // ─── BaseMemoryService required methods ───────────────────────────────────

  async addSessionToMemory(session: Session): Promise<void> {
    const { appName, userId, events } = session;
    if (!events || events.length === 0) return;

    const tag = compoundTag(appName, userId);
    let written = 0;

    for (const event of events) {
      const text = extractText(event.content);
      if (!text) continue; // filter no-text events (Vertex parity)

      const recordId = `${appName}:${userId}:${session.id}:${event.id}`;
      const body: Record<string, unknown> = {
        id: recordId,
        agentId: this._agentId,
        content: text,
        type: "session",
        durability: "standard",
        tags: [tag],
        createdAt: epochMsToIso(event.timestamp),
      };

      try {
        await this._writeRecord(recordId, body);
        written++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[adk-flair] write failed for session ${session.id} event ${event.id} ` +
          `(written=${written}/${events.length}): ${msg}`
        );
      }
    }

    if (written === 0) return;
  }

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<FlairSearchMemoryResponse> {
    const { appName, userId, query } = request;

    // Mandatory userId: empty ⇒ return empty, never search unscoped
    if (!userId) {
      return { memories: [] };
    }

    const tag = compoundTag(appName, userId);
    const path = "/SemanticSearch";
    const body = JSON.stringify({
      agentId: this._agentId,
      q: query,
      tag,
      limit: 20,
      // flair#1332: opt into the `metadata` blob in each hit.
      // /SemanticSearch's default projection deliberately omits it (other
      // consumers must not pay result-size for a blob they never read);
      // this flag widens the projection for THIS request only. `subject`
      // is in the default projection.
      includeMetadata: true,
    });

    const start = Date.now();
    let phase = "connect";

    try {
      const authHeader = signRequest(
        this._privateKey,
        this._agentId,
        "POST",
        path,
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this._timeoutMs);

      try {
        phase = "connect";
        const resp = await fetch(`${this._url}${path}`, {
          method: "POST",
          headers: {
            "Authorization": authHeader,
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
        });

        phase = "read";
        if (!resp.ok) {
          const elapsed = Date.now() - start;
          console.warn(
            `[adk-flair] searchMemory HTTP ${resp.status}: ` +
            `host=${this._url} elapsed=${elapsed}ms phase=${phase}`
          );
          return { memories: [] };
        }

        const data = (await resp.json()) as {
          results?: Array<Record<string, unknown>>;
        };

        const results = Array.isArray(data.results) ? data.results : [];
        const memories: FlairMemoryEntry[] = [];

        for (const hit of results) {
          if (!isPlainObjectLike(hit)) continue;

          // Per-hit tag re-verification: drop hits missing the compound tag.
          // Client-side analogue of Flair's isAllowed defense-in-depth.
          const hitTags = Array.isArray(hit["tags"]) ? (hit["tags"] as unknown[]) : [];
          if (!hitTags.includes(tag)) continue;

          memories.push(this._hitToMemoryEntry(hit));
        }

        return { memories };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: unknown) {
      const elapsed = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[adk-flair] searchMemory failed: host=${this._url} ` +
        `elapsed=${elapsed}ms phase=${phase} error="${msg}"`
      );
      return { memories: [] };
    }
  }

  // ─── Vertex-parity extras (not called by ADK, documented for direct use) ──

  /**
   * Add events to memory incrementally (the quickstart's after_agent_callback path).
   * Not called by ADK — use in after_agent_callback or directly.
   *
   * customMetadata (flair#1332) is stored on every record this call writes,
   * as an opaque JSON blob on the Memory record's `metadata` field, and
   * round-trips back on `FlairMemoryEntry.customMetadata` from searchMemory /
   * listMemories. Store-and-return only — no key in it has any server-side
   * effect. Caps (Error before any write): 64KB serialized, nesting depth
   * <= 16, <= 512 total keys. customMetadata["subject"] (a string) is
   * additionally promoted to the record's top-level `subject` column
   * (<= 512 chars).
   */
  async addEventsToMemory(
    appName: string,
    userId: string,
    events: Event[],
    sessionId: string,
    customMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const tag = compoundTag(appName, userId);

    // customMetadata → opaque JSON blob + optional promoted subject
    // (flair#1332). Validated/serialized ONCE, before any write — a cap
    // violation throws here and zero events are written, never a partial
    // batch with silently-dropped metadata.
    const sessionKey = `${appName}:${userId}:${sessionId}`;
    const metadataJson = serializeCustomMetadata(customMetadata, sessionKey);
    const subjectValue = resolveSubject(undefined, customMetadata);

    let written = 0;
    const eventList = events ?? [];

    for (const event of eventList) {
      const text = extractText(event.content);
      if (!text) continue;

      const recordId = `${appName}:${userId}:${sessionId}:${event.id}`;
      const body: Record<string, unknown> = {
        id: recordId,
        agentId: this._agentId,
        content: text,
        type: "session",
        durability: "standard",
        tags: [tag],
        createdAt: epochMsToIso(event.timestamp),
      };
      if (metadataJson !== null) body["metadata"] = metadataJson;
      if (subjectValue !== null) body["subject"] = subjectValue;

      try {
        await this._writeRecord(recordId, body);
        written++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[adk-flair] write failed for session ${sessionId} event ${event.id} ` +
          `(written=${written}/${eventList.length}): ${msg}`
        );
      }
    }

    if (written === 0) return;
  }

  /**
   * Add memory entries directly.
   * Not called by ADK — use for direct memory writes.
   *
   * customMetadata (flair#1332) is stored on every record this call writes,
   * as an opaque JSON blob on the Memory record's `metadata` field, and
   * round-trips back on `FlairMemoryEntry.customMetadata` from searchMemory /
   * listMemories. Store-and-return only (the ADK contract, flair#1202): no
   * key inside the blob has ANY server-side effect — {"visibility":"shared"}
   * in here does not share the memory (use the explicit `visibility` option
   * for that). Caps (Error before any write; reject, never truncate): 64KB
   * serialized, nesting depth <= 16, <= 512 total keys. Non-JSON-serializable
   * values skip that key with a warning.
   *
   * opts.subject (flair#1332, Flair-specific extension): short human-readable
   * title promoted to the record's top-level indexed `subject` column.
   * Sourced from this option or customMetadata["subject"]; the explicit
   * option is authoritative when both are present. <= 512 chars (Error
   * beyond). Never auto-extracted from content.
   *
   * opts.durability / opts.visibility: trust-anchor opt-ins (Python-parity
   * explicit knobs), validated against the schema enums. Omitted durability →
   * "standard"; omitted visibility → no key in the body (server default).
   *
   * Record ids mirror the Python package: `entry.id` when the caller supplies
   * one (FlairMemoryEntry input), else the first 32 hex chars of the content's
   * SHA-256 — deterministic, so re-adding identical content replaces rather
   * than duplicates.
   */
  async addMemory(
    appName: string,
    userId: string,
    memories: Array<MemoryEntry & { id?: string }>,
    customMetadata?: Record<string, unknown>,
    opts?: AddMemoryOptions,
  ): Promise<void> {
    const tag = compoundTag(appName, userId);

    // Validate explicit durability / visibility (mirrors Python flair#1238).
    if (opts?.durability !== undefined && !VALID_DURABILITIES.has(opts.durability)) {
      throw new Error(
        `durability must be one of ${[...VALID_DURABILITIES].sort().join(", ")} ` +
        `(got: ${JSON.stringify(opts.durability)})`
      );
    }
    if (opts?.visibility !== undefined && !VALID_VISIBILITIES.has(opts.visibility)) {
      throw new Error(
        `visibility must be one of ${[...VALID_VISIBILITIES].sort().join(", ")} ` +
        `(got: ${JSON.stringify(opts.visibility)})`
      );
    }

    // customMetadata → opaque JSON blob + optional promoted subject
    // (flair#1332). Validated/serialized ONCE, before any write — a cap
    // violation throws here and zero records are written.
    const metadataJson = serializeCustomMetadata(
      customMetadata, `${appName}:${userId}:direct`,
    );
    const subjectValue = resolveSubject(opts?.subject, customMetadata);

    let written = 0;
    const memoryList = memories ?? [];

    for (const mem of memoryList) {
      const text = extractText(mem.content);
      if (!text) continue;

      const recordId =
        mem.id ??
        crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
      const body: Record<string, unknown> = {
        id: recordId,
        agentId: this._agentId,
        content: text,
        type: "session",
        durability: opts?.durability ?? "standard",
        tags: [tag],
        createdAt: mem.timestamp || new Date().toISOString(),
      };
      if (opts?.visibility !== undefined) body["visibility"] = opts.visibility;
      if (metadataJson !== null) body["metadata"] = metadataJson;
      if (subjectValue !== null) body["subject"] = subjectValue;
      if (mem.author) {
        body["author"] = mem.author;
      }

      try {
        await this._writeRecord(recordId, body);
        written++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[adk-flair] direct memory write failed for id ${recordId} ` +
          `(written=${written}/${memoryList.length}): ${msg}`
        );
      }
    }

    if (written === 0) return;
  }

  // ─── listMemories (flair#1333 — Flair-specific extension) ─────────────────

  /**
   * List recent memories for an app+user, newest first.
   *
   * Flair-specific extension — NOT part of ADK's BaseMemoryService (which
   * specifies only searchMemory). Useful for memory review UIs, dashboards,
   * and agent contextual browsing where there is no query to search with.
   *
   * Scope: the same compound tag (adk:<app>:<user>) searchMemory uses, AND
   * agentId === this service's agent identity — both pushed down as
   * server-side query conditions and re-verified client-side on every
   * returned row (defense in depth).
   *
   * Pagination: `offset` is POSITIONAL over a point-in-time snapshot ordered
   * by createdAt descending — not a live cursor. Memories written between
   * two pages shift positions, so a record can appear twice or be skipped
   * across page boundaries. For a consistent view, take one page, or dedupe
   * by id across pages.
   *
   * Throws on invalid arguments, and — unlike searchMemory (whose
   * empty-on-error contract is ADK's) — PROPAGATES transport and HTTP
   * failures: a browsing UI must be able to tell "no memories" from
   * "Flair is down".
   */
  async listMemories(
    appName: string,
    userId: string,
    opts?: ListMemoriesOptions,
  ): Promise<FlairMemoryEntry[]> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    if (!appName) {
      throw new Error("appName is required");
    }
    if (!userId) {
      throw new Error("userId is required — listMemories never lists unscoped");
    }
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      throw new Error(`limit must be a positive integer (got: ${JSON.stringify(limit)})`);
    }
    if (limit > LIST_MEMORIES_MAX_LIMIT) {
      throw new Error(
        `limit ${limit} exceeds the hard cap of ${LIST_MEMORIES_MAX_LIMIT} ` +
        "— page with offset instead"
      );
    }
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
      throw new Error(`offset must be a non-negative integer (got: ${JSON.stringify(offset)})`);
    }

    const tag = compoundTag(appName, userId);

    // Harper REST collection query (signed like every other request — the
    // signature covers path+query). The tag value is percent-encoded
    // WHOLESALE: compound tags legitimately contain literal %XX escapes from
    // sanitizeTagSegment, which must survive the server's URL decode.
    // limit(start,end) is Harper's offset window: start=offset,
    // end=offset+limit.
    const path =
      `/Memory/?tags=${encodeURIComponent(tag)}` +
      `&agentId=${encodeURIComponent(this._agentId)}` +
      `&select(id,agentId,content,metadata,subject,tags,createdAt)` +
      `&sort(-createdAt)` +
      `&limit(${offset},${offset + limit})`;

    const authHeader = signRequest(this._privateKey, this._agentId, "GET", path);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._timeoutMs);

    let rows: unknown;
    try {
      const resp = await fetch(`${this._url}${path}`, {
        method: "GET",
        headers: { "Authorization": authHeader },
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `Flair GET /Memory/ → HTTP ${resp.status}` +
          `${text ? `: ${text.slice(0, 200)}` : ""}`
        );
      }
      rows = await resp.json();
    } finally {
      clearTimeout(timeoutId);
    }

    if (!Array.isArray(rows)) {
      return [];
    }

    const entries: FlairMemoryEntry[] = [];
    for (const row of rows) {
      if (!isPlainObjectLike(row)) continue;
      // Defense in depth: re-verify both scope conditions client-side,
      // mirroring searchMemory's tag re-verification.
      const rowTags = Array.isArray(row["tags"]) ? (row["tags"] as unknown[]) : [];
      if (!rowTags.includes(tag)) continue;
      if (row["agentId"] !== this._agentId) continue;
      entries.push(this._hitToMemoryEntry(row));
    }
    return entries;
  }

  // ─── Hit → MemoryEntry mapping ─────────────────────────────────────────────

  /**
   * Map a Flair Memory record/hit onto a FlairMemoryEntry.
   *
   * author derives from the record's agentId — the writing Flair agent
   * (flair#1332 incidental fix, mirrored: records carry no "author" field,
   * so reading hit.author was always undefined). timestamp derives from the
   * record's createdAt for the same reason.
   */
  private _hitToMemoryEntry(hit: Record<string, unknown>): FlairMemoryEntry {
    const contentText = typeof hit["content"] === "string" ? hit["content"] : "";
    const customMetadata = this._hitCustomMetadata(hit);
    const subject = hit["subject"];

    const entry: FlairMemoryEntry = {
      content: {
        role: "model",
        parts: [{ text: contentText }],
      } as Content,
      customMetadata,
    };
    if (typeof hit["id"] === "string") entry.id = hit["id"];
    if (typeof hit["agentId"] === "string") entry.author = hit["agentId"];
    if (typeof hit["createdAt"] === "string") entry.timestamp = hit["createdAt"];
    if (typeof subject === "string" && subject) entry.subject = subject;
    return entry;
  }

  /**
   * Rebuild FlairMemoryEntry.customMetadata from a record's stored fields.
   *
   * - `metadata` (the opaque JSON blob) parses back to an object. FAIL-SOFT:
   *   malformed JSON (or JSON that isn't an object) yields {} plus a warning
   *   naming the record id — a corrupt blob on one record must never take
   *   the whole read path down.
   * - A top-level `subject` column is surfaced as customMetadata["subject"].
   *   The COLUMN is authoritative (flair#1332 ruling): when the blob carries
   *   a divergent "subject" key, the column value overwrites it in the
   *   returned object. This keeps the customMetadata return shape identical
   *   to the Python package — a subject written via the explicit option
   *   (never in the blob) still round-trips through customMetadata.
   */
  private _hitCustomMetadata(hit: Record<string, unknown>): Record<string, unknown> {
    let parsed: Record<string, unknown> = {};
    const raw = hit["metadata"];
    if (raw) {
      let loaded: unknown;
      let malformed = false;
      if (typeof raw === "string") {
        try {
          loaded = JSON.parse(raw);
        } catch {
          malformed = true;
        }
      } else {
        malformed = true;
      }
      if (malformed) {
        console.warn(
          `[adk-flair] malformed metadata JSON on record ${String(hit["id"])} — ` +
          "returning empty customMetadata for it"
        );
      } else if (isPlainObjectLike(loaded)) {
        parsed = loaded;
      } else {
        console.warn(
          `[adk-flair] metadata on record ${String(hit["id"])} is JSON but not ` +
          "an object — returning empty customMetadata for it"
        );
      }
    }
    const subject = hit["subject"];
    if (typeof subject === "string" && subject) {
      parsed["subject"] = subject;
    }
    return parsed;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Send one signed JSON-bodied request. The signing payload covers the full
   * path (METHOD:pathname), so the path passed here is the one signed.
   */
  private async _sendJson(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const authHeader = signRequest(this._privateKey, this._agentId, method, path);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      return await fetch(`${this._url}${path}`, {
        method,
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Create-or-replace one Memory record.
   *
   * Creates via `POST /Memory/` — Harper's collection create verb — with the
   * id in the body. The previous shape, `PUT /Memory/{id}`, is update-only on
   * some Harper deployments and 404s when the record does not exist yet
   * (flair#1336, observed on hosted Harper Fabric; not reproducible on stock
   * Harper 5.2.x, where PUT upserts). Mirrors the Python package's #1339 fix.
   *
   * A 409 from POST means the record already exists — re-ingestion of a
   * deterministic id (addSessionToMemory re-saves a growing session's earlier
   * events every time) or a caller-supplied id being rewritten. Fall back to
   * `PUT /Memory/{id}` for exactly that case, preserving the pre-#1336
   * replace/refresh semantics for existing rows. Any other error propagates
   * unchanged (the write-path warning logs carry the real HTTP status).
   */
  private async _writeRecord(
    recordId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const resp = await this._sendJson("POST", "/Memory/", body);
    if (resp.ok) return;
    if (resp.status !== 409) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`
      );
    }
    const putResp = await this._sendJson("PUT", `/Memory/${recordId}`, body);
    if (!putResp.ok) {
      const text = await putResp.text().catch(() => "");
      throw new Error(
        `HTTP ${putResp.status}${text ? `: ${text.slice(0, 200)}` : ""}`
      );
    }
  }

  /**
   * Close the service. No-op for the HTTP-based implementation;
   * provided for API compatibility with the Python package.
   */
  async close(): Promise<void> {
    // no-op: no persistent connections to close
  }
}
