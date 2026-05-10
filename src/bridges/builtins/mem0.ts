/**
 * Built-in bridge: mem0
 *
 * Imports memories from a Mem0 instance (cloud at api.mem0.ai or self-hosted)
 * into Flair. Pulls every memory for a given user_id via the Mem0 v1 GET
 * /v1/memories/ endpoint, paginating with page/page_size until exhausted.
 * Each imported row becomes one Flair memory tagged `source:mem0` +
 * `import:mem0`, durability `persistent`.
 *
 * One-way import (we don't sync back). This backs the "switch off SaaS
 * memory in 30 seconds" positioning.
 *
 * API schema (verified against api.mem0.ai/openapi.json on 2026-05-10):
 *   GET /v1/memories/?user_id=<id>&page=<n>&page_size=<n>
 *   Authorization: Token <api-key>
 *
 *   Response shape A (v1, bare array — self-hosted + cloud v1):
 *     [ { id, memory, created_at, ... }, ... ]
 *     Pagination ends when an empty array is returned.
 *
 *   Response shape B (v3 / DRF-style paginated envelope):
 *     { count, next, previous, results: [...] }
 *     Pagination ends when `next` is null.
 *
 *   The bridge auto-detects which shape the server returns and handles both.
 *
 * Why a Shape B (code) bridge and not Shape A (YAML descriptor):
 *   - The Mem0 API requires bearer-auth headers and pagination.
 *   - The Shape A file-based parser can't drive a REST API.
 *   - Error handling needs to distinguish 401/403/404 from network failures
 *     from malformed responses — easier to express in TS.
 *
 * Usage:
 *   flair bridge import mem0 --user <id> --api-key <key> --agent <flair-id>
 *   flair bridge import mem0 --user <id> --base-url https://mem0.example.com --agent <flair-id>
 *   MEM0_API_KEY=<key> flair bridge import mem0 --user <id> --agent <flair-id>
 */

import type { BridgeContext, BridgeMemory, MemoryBridge } from "../types.js";
import { BridgeRuntimeError } from "../types.js";

interface Mem0Memory {
  id: string;
  memory: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

interface Mem0PaginatedEnvelope {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results: Mem0Memory[];
}

type Mem0Response = Mem0Memory[] | Mem0PaginatedEnvelope;

function isPaginatedEnvelope(body: Mem0Response): body is Mem0PaginatedEnvelope {
  return !Array.isArray(body) && typeof body === "object" && body !== null && Array.isArray((body as any).results);
}

async function* importMem0(
  opts: Record<string, unknown>,
  ctx: BridgeContext,
): AsyncIterable<BridgeMemory> {
  const userId = typeof opts.user === "string" ? opts.user : "";
  if (!userId) {
    throw new BridgeRuntimeError({
      bridge: "mem0",
      op: "import",
      field: "user",
      expected: "Mem0 user_id string",
      got: "missing",
      hint: "pass --user <id>; example: flair bridge import mem0 --user <id> --api-key <key> --agent <flair-id>",
    });
  }

  const apiKey = typeof opts.apiKey === "string" ? opts.apiKey : "";
  if (!apiKey) {
    throw new BridgeRuntimeError({
      bridge: "mem0",
      op: "import",
      field: "apiKey",
      expected: "Mem0 API token (cloud or self-hosted)",
      got: "missing",
      hint: "pass --api-key <token> or set MEM0_API_KEY in the environment",
    });
  }

  const baseUrl = typeof opts.baseUrl === "string" && opts.baseUrl.length > 0
    ? opts.baseUrl.replace(/\/+$/, "")
    : "https://api.mem0.ai";

  const maxPages = typeof opts.maxPages === "number" ? opts.maxPages : 0;
  const pageSize = 100;

  ctx.log.info("starting mem0 import", {
    user_id: userId,
    base_url: baseUrl,
  });

  let pageCount = 0;
  let totalKept = 0;
  let pageNum = 1;
  let cursor: string | null = `${baseUrl}/v1/memories/?user_id=${encodeURIComponent(userId)}&page=${pageNum}&page_size=${pageSize}`;

  while (cursor !== null) {
    if (maxPages > 0 && pageCount >= maxPages) {
      ctx.log.info("stopping at max-pages limit", { pages: pageCount, kept: totalKept });
      break;
    }

    ctx.log.debug("fetching page", { url: cursor, page: pageCount + 1 });

    let res: Response;
    try {
      res = await ctx.fetch(cursor, {
        headers: {
          Authorization: `Token ${apiKey}`,
          Accept: "application/json",
        },
      });
    } catch (err: any) {
      throw new BridgeRuntimeError({
        bridge: "mem0",
        op: "import",
        path: cursor,
        field: "fetch",
        expected: "HTTP 200",
        got: `network error: ${err?.message ?? err}`,
        hint: "check the base URL is reachable and the network is up",
      });
    }

    if (res.status === 401) {
      throw new BridgeRuntimeError({
        bridge: "mem0",
        op: "import",
        path: cursor,
        field: "apiKey",
        expected: "valid Mem0 API token",
        got: "HTTP 401 Unauthorized",
        hint: "the API key was rejected — check it's valid and scoped to the user_id",
      });
    }

    if (res.status === 403) {
      throw new BridgeRuntimeError({
        bridge: "mem0",
        op: "import",
        path: cursor,
        field: "apiKey",
        expected: "authorized token",
        got: "HTTP 403 Forbidden",
        hint: "the API key doesn't have permission to read memories for this user_id",
      });
    }

    if (res.status === 404) {
      throw new BridgeRuntimeError({
        bridge: "mem0",
        op: "import",
        path: cursor,
        field: "user",
        expected: "existing user_id",
        got: "HTTP 404 Not Found",
        hint: `user_id "${userId}" was not found on this Mem0 instance`,
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "(could not read body)");
      throw new BridgeRuntimeError({
        bridge: "mem0",
        op: "import",
        path: cursor,
        field: "response",
        expected: "HTTP 200",
        got: `HTTP ${res.status} ${res.statusText}`,
        hint: `unexpected response (${res.status}): ${body.slice(0, 200)}`,
      });
    }

    let body: Mem0Response;
    try {
      const text = await res.text();
      if (text.trim() === "") {
        throw new BridgeRuntimeError({
          bridge: "mem0",
          op: "import",
          path: cursor,
          field: "(response)",
          expected: "JSON body",
          got: "empty response",
          hint: "the Mem0 API returned an empty body — check the instance is healthy",
        });
      }
      body = JSON.parse(text);
    } catch (err: any) {
      if (err instanceof BridgeRuntimeError) throw err;
      throw new BridgeRuntimeError({
        bridge: "mem0",
        op: "import",
        path: cursor,
        field: "(response)",
        expected: "valid JSON: bare array OR { results: [...], next: string|null }",
        got: "parse error",
        hint: `could not parse response: ${err?.message ?? err}`,
      });
    }

    let mems: Mem0Memory[];
    let nextCursor: string | null;

    if (Array.isArray(body)) {
      // v1 bare-array shape — page until we get an empty array.
      mems = body;
      nextCursor = mems.length === 0 || mems.length < pageSize
        ? null
        : `${baseUrl}/v1/memories/?user_id=${encodeURIComponent(userId)}&page=${pageNum + 1}&page_size=${pageSize}`;
      pageNum++;
    } else if (isPaginatedEnvelope(body)) {
      // v3 / DRF-style envelope — use server-provided next URL.
      mems = body.results;
      nextCursor = typeof body.next === "string" && body.next.length > 0 ? body.next : null;
    } else {
      throw new BridgeRuntimeError({
        bridge: "mem0",
        op: "import",
        path: cursor,
        field: "(response)",
        expected: "bare array OR { results: [...], next: string|null }",
        got: typeof body,
        hint: `unexpected response shape — got ${typeof body}, expected an array or paginated envelope`,
      });
    }

    ctx.log.debug("received page", { count: mems.length, next: nextCursor });

    for (const m of mems) {
      const content = typeof m?.memory === "string" ? m.memory : "";
      if (!content || content.trim() === "") continue;
      totalKept++;
      yield {
        foreignId: `mem0:${m.id}`,
        content,
        createdAt: typeof m?.created_at === "string" ? m.created_at : undefined,
        tags: ["source:mem0", "import:mem0"],
        durability: "persistent",
      };
    }

    pageCount++;
    cursor = nextCursor;
  }

  ctx.log.info("mem0 import complete", { pages: pageCount, kept: totalKept });
}

export const mem0MemoryBridge: MemoryBridge = {
  name: "mem0",
  version: 1,
  kind: "api",
  description: "Import memories from a Mem0 instance (cloud or self-hosted) into Flair",
  options: {
    user: {
      description: "Mem0 user_id whose memories to import.",
      required: true,
    },
    apiKey: {
      description: "Mem0 API token. Can also be set via MEM0_API_KEY env var.",
      env: "MEM0_API_KEY",
      required: true,
    },
    baseUrl: {
      description: "Base URL of the Mem0 API (default: https://api.mem0.ai). Use your self-hosted URL for on-prem.",
    },
    maxPages: {
      description: "Maximum number of pages to fetch (0 = unlimited, for testing/dry-run).",
    },
  },
  import: importMem0,
  // No export — one-way import; we don't sync back to Mem0.
};
