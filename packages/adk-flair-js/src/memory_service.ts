/**
 * FlairMemoryService — Flair as the memory backend for Google ADK (JS/TS).
 *
 * Implements @google/adk's `BaseMemoryService` interface (2 required methods)
 * plus the Vertex-parity extras (`addEventsToMemory`, `addMemory`).
 *
 * Ported from the Python `adk-flair` package. See specs/ADK-FLAIR-ADAPTER.md
 * in the tpsdev-ai/cli repo for the full design.
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

// ─── FlairMemoryService ─────────────────────────────────────────────────────

export class FlairMemoryService implements BaseMemoryService {
  private readonly _url: string;
  private readonly _agentId: string;
  private readonly _privateKey: crypto.KeyObject;
  private readonly _timeoutMs: number;
  /** Per-session state for custom_metadata warn-once (Python parity). */
  private _warnedSessions: Set<string> = new Set();

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
  ): Promise<SearchMemoryResponse> {
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
          results?: Array<{
            content?: string;
            author?: string;
            timestamp?: string;
            tags?: string[];
          }>;
        };

        const results = data.results ?? [];
        const memories: MemoryEntry[] = [];

        for (const hit of results) {
          // Per-hit tag re-verification: drop hits missing the compound tag
          const hitTags = hit.tags ?? [];
          if (!hitTags.includes(tag)) continue;

          const content: Content = {
            role: "user",
            parts: [{ text: hit.content ?? "" }],
          } as Content;

          memories.push({
            content,
            author: hit.author,
            timestamp: hit.timestamp,
          });
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
   * @param customMetadata - If provided, logs a once-per-session warning that
   *   custom_metadata is not supported by adk-flair (Python parity).
   */
  async addEventsToMemory(
    appName: string,
    userId: string,
    events: Event[],
    sessionId: string,
    customMetadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!events || events.length === 0) return;

    // custom_metadata warn-once per session (Python parity)
    if (customMetadata) {
      const sessionKey = `${appName}:${userId}:${sessionId}`;
      if (!this._warnedSessions.has(sessionKey)) {
        this._warnedSessions.add(sessionKey);
        console.warn(
          "adk-flair: custom_metadata ignored — adk-flair does not " +
          `support custom_metadata keys (session=${sessionKey})`
        );
      }
    }

    const tag = compoundTag(appName, userId);
    let written = 0;

    for (const event of events) {
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

      try {
        await this._writeRecord(recordId, body);
        written++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[adk-flair] write failed for session ${sessionId} event ${event.id} ` +
          `(written=${written}/${events.length}): ${msg}`
        );
      }
    }

    if (written === 0) return;
  }

  /**
   * Add memory entries directly.
   * Not called by ADK — use for direct memory writes.
   *
   * @param customMetadata - If provided, logs a once-per-session warning that
   *   custom_metadata is not supported by adk-flair (Python parity).
   */
  async addMemory(
    appName: string,
    userId: string,
    memories: MemoryEntry[],
    customMetadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!memories || memories.length === 0) return;

    // custom_metadata warn-once (Python parity)
    if (customMetadata) {
      const sessionKey = `${appName}:${userId}:direct`;
      if (!this._warnedSessions.has(sessionKey)) {
        this._warnedSessions.add(sessionKey);
        console.warn(
          "adk-flair: custom_metadata ignored — adk-flair does not " +
          "support custom_metadata keys"
        );
      }
    }

    const tag = compoundTag(appName, userId);
    let written = 0;

    for (const mem of memories) {
      const text = extractText(mem.content);
      if (!text) continue;

      const recordId = `${appName}:${userId}:direct:${crypto.randomUUID()}`;
      const body: Record<string, unknown> = {
        id: recordId,
        agentId: this._agentId,
        content: text,
        type: "session",
        durability: "standard",
        tags: [tag],
        createdAt: mem.timestamp ?? new Date().toISOString(),
      };
      if (mem.author) {
        body.author = mem.author;
      }

      try {
        await this._writeRecord(recordId, body);
        written++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[adk-flair] direct memory write failed for id ${recordId} ` +
          `(written=${written}/${memories.length}): ${msg}`
        );
      }
    }

    if (written === 0) return;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Write a single record to Flair via PUT /Memory/{recordId}.
   *
   * The deterministic record ID is embedded in the URL path so the server
   * can perform an idempotent upsert. The signing payload covers the full
   * path (METHOD:pathname), so the path MUST include the record ID.
   */
  private async _writeRecord(
    recordId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const path = `/Memory/${recordId}`;
    const authHeader = signRequest(
      this._privateKey,
      this._agentId,
      "PUT",
      path,
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._timeoutMs);

    try {
      const resp = await fetch(`${this._url}${path}`, {
        method: "PUT",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`
        );
      }
    } finally {
      clearTimeout(timeoutId);
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
