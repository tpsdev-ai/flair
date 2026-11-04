/**
 * request-target.test.ts — the canonical request-target rule the auth
 * middleware applies before any other request processing, and the raw-path
 * helpers its path decisions use.
 *
 * Pure: no Harper, no middleware. The middleware-driven checks live in
 * test/unit-isolated/request-target-middleware.test.ts; the real-Harper checks
 * in test/integration/request-target-canonical-e2e.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  NON_CANONICAL_REQUEST_TARGET_ERROR,
  decodePathSegment,
  isCanonicalRequestTarget,
  lastRawPathSegment,
  nonCanonicalRequestTargetRefusal,
  rawPathSegments,
  routedRecordId,
  requestPath,
} from "../../resources/request-target.ts";
import { resolveGuardedRecord } from "../../resources/record-owner-guard.ts";
import { encodeRecordId as cliEncodeRecordId, recordIdPath } from "../../src/lib/record-id-path.ts";
import { encodeRecordId as mcpEncodeRecordId, memoryPutPath } from "../../packages/flair-mcp/src/record-id-path.ts";

describe("isCanonicalRequestTarget — refused forms", () => {
  const dotSegments = [
    "/.",
    "/..",
    "/Memory/.",
    "/Memory/..",
    "/Memory/./x",
    "/Memory/../x",
    "/Memory/x/..",
    "/Memory/%2e",
    "/Memory/%2E",
    "/Memory/%2e/x",
    "/Memory/%2e%2e",
    "/Memory/%2E%2E/x",
    "/Memory/%2e%2E/x",
    "/Memory/.%2e/x",
    "/Memory/%2e./x",
    "/Memory/%2E./x?limit=1",
  ];
  const emptySegments = [
    "//",
    "//Memory",
    "/Memory//x",
    "/Memory/x//",
    "/Memory//",
    "/Memory//x?limit=1",
    "http://localhost/Memory",
  ];
  const backslashes = [
    "\\",
    "/Memory\\x",
    "/Memory/x\\y",
    "/Memory/x\\",
    "/\\Memory",
  ];

  for (const target of dotSegments) {
    test(`a dot segment: ${JSON.stringify(target)}`, () => {
      expect(isCanonicalRequestTarget(target)).toBe(false);
    });
  }
  for (const target of emptySegments) {
    test(`repeated slashes: ${JSON.stringify(target)}`, () => {
      expect(isCanonicalRequestTarget(target)).toBe(false);
    });
  }
  for (const target of backslashes) {
    test(`a raw backslash: ${JSON.stringify(target)}`, () => {
      expect(isCanonicalRequestTarget(target)).toBe(false);
    });
  }
});

describe("isCanonicalRequestTarget — canonical forms pass", () => {
  const canonical = [
    "/",
    "/health",
    "/Memory",
    "/Memory/",
    "/Memory/x",
    // dots inside a segment
    "/Memory/a.b",
    "/Memory/x.content",
    "/Memory/a..b",
    "/Memory/...",
    "/Memory/.hidden",
    "/Memory/trailing.",
    "/Memory/%2e%2e%2e",
    "/Memory/%2ex",
    // percent-encoding
    "/Memory/a%20b",
    "/Memory/m%2F1%3F%23%25",
    "/Memory/a%2Fb",
    "/Memory/a%2fb",
    "/Memory/a%2F%2Fb",
    "/Memory/a%5Cb",
    "/Memory/a%5cb",
    "/Memory/%2F",
    "/Memory/%5C",
    "/Memory/mcs-deep%252Fbase",
    "/Memory/mcs-bad%E0%A4.content",
    // query strings are not part of the path
    "/Memory?agentId=a",
    "/Memory/?tags=x&agentId=a",
    "/Memory/x?select(id,content)&limit=5",
    "/Memory?x=../..&y=//&z=\\",
    "/Memory/x?",
    "/OrgEventCatchup/agent-1?since=2026-10-16T00:00:00.000Z",
  ];
  for (const target of canonical) {
    test(`passes: ${JSON.stringify(target)}`, () => {
      expect(isCanonicalRequestTarget(target)).toBe(true);
    });
  }
});

describe("a record id built by Flair's own clients is a canonical target", () => {
  const ids = [
    "plain",
    "a/b",
    "a\\b",
    "a.b",
    "x.content",
    "..x",
    "x..",
    "...",
    "%2e",
    "%2e%2e",
    "a//b",
    "/leading",
    "trailing/",
    "./x",
    "x/..",
    "a b?c#d%e",
    "agent-1:soul-key",
  ];
  for (const id of ids) {
    test(`id ${JSON.stringify(id)}`, () => {
      expect(isCanonicalRequestTarget(recordIdPath("Memory", id))).toBe(true);
      expect(isCanonicalRequestTarget(`/Memory/${cliEncodeRecordId(id)}`)).toBe(true);
      expect(isCanonicalRequestTarget(memoryPutPath(id))).toBe(true);
      expect(isCanonicalRequestTarget(`/Memory/${mcpEncodeRecordId(id)}?limit=1`)).toBe(true);
      // Both helpers return the decoded id.
      expect(routedRecordId(recordIdPath("Memory", id))?.id).toBe(id);
      expect(resolveGuardedRecord(recordIdPath("Memory", id))?.id).toBe(id);
    });
  }
});

describe("the named refusal", () => {
  test("400 with the named error", async () => {
    const res = nonCanonicalRequestTargetRefusal("GET");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json();
    expect(body.error).toBe(NON_CANONICAL_REQUEST_TARGET_ERROR);
    expect(body.error).toBe("non_canonical_request_target");
  });

  test("HEAD gets the 400 with no body", async () => {
    const res = nonCanonicalRequestTargetRefusal("HEAD");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
  });
});

describe("raw-path helpers: split on `/` first, then decode one segment", () => {
  test("requestPath is everything before the first `?`", () => {
    expect(requestPath("/Memory/a%2Fb?x=1?y=2")).toBe("/Memory/a%2Fb");
    expect(requestPath("/Memory/a%2Fb")).toBe("/Memory/a%2Fb");
    expect(requestPath("/Memory?")).toBe("/Memory");
  });

  test("rawPathSegments keeps an encoded `/` inside its segment", () => {
    expect(rawPathSegments("/Memory/a%2Fb")).toEqual(["Memory", "a%2Fb"]);
    expect(rawPathSegments("/OrgEvent/a%2F..%2Fb")).toEqual(["OrgEvent", "a%2F..%2Fb"]);
    expect(rawPathSegments("/")).toEqual([]);
  });

  test("lastRawPathSegment is the whole last segment, encoded `/` included", () => {
    expect(lastRawPathSegment("/Memory/a%2Fb.content")).toBe("a%2Fb.content");
    expect(lastRawPathSegment("/Memory/a%2F%E0%A4.content")).toBe("a%2F%E0%A4.content");
  });

  test("decodePathSegment decodes one segment, null for invalid percent-encoding", () => {
    expect(decodePathSegment("a%2Fb")).toBe("a/b");
    expect(decodePathSegment("a%5Cb")).toBe("a\\b");
    expect(decodePathSegment("a%E0%A4")).toBeNull();
  });

  test("routedRecordId returns the fully decoded remainder as the initial RequestTarget id", () => {
    expect(routedRecordId("/OrgEvent/a%2Fb")).toEqual({ resource: "OrgEvent", id: "a/b" });
    expect(routedRecordId("/WorkspaceState/ws%2F1")).toEqual({ resource: "WorkspaceState", id: "ws/1" });
    expect(routedRecordId("/OrgEvent/a%2F..%2Fb")).toEqual({ resource: "OrgEvent", id: "a/../b" });
    // A raw multi-segment remainder is ONE id (the whole decoded remainder).
    expect(routedRecordId("/OrgEvent/a/b/c")).toEqual({ resource: "OrgEvent", id: "a/b/c" });
    expect(routedRecordId("/OrgEvent")).toBeNull();
    expect(routedRecordId("/OrgEvent/")).toBeNull();
    expect(routedRecordId("/OrgEvent/bad%E0%A4")).toBeNull();
  });

  test("resolveGuardedRecord decides an encoded-slash id as one id", () => {
    expect(resolveGuardedRecord("/Memory/a%2Fb")).toEqual({ table: "Memory", ownerField: "agentId", id: "a/b" });
    expect(resolveGuardedRecord("/OrgEvent/a%2Fb")).toEqual({ table: "OrgEvent", ownerField: "authorId", id: "a/b" });
    expect(resolveGuardedRecord("/WorkspaceState/a%5Cb")).toEqual({ table: "WorkspaceState", ownerField: "agentId", id: "a\\b" });
  });
});
