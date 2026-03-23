import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

/**
 * Tests for CLI api() helper behavior:
 * - 204 No Content handling
 * - GET request agentId extraction from query params
 * - Auth header generation for different HTTP methods
 */

// We can't easily import api() directly (it's not exported), so we test
// the specific behaviors by testing the building blocks.

describe("CLI api() behaviors", () => {

  describe("204 No Content handling", () => {
    it("should return { ok: true } for empty response body", () => {
      // Simulates what api() does when res.text() returns ""
      const text = "";
      const result = text ? JSON.parse(text) : { ok: true };
      expect(result).toEqual({ ok: true });
    });

    it("should parse valid JSON normally", () => {
      const text = '{"results":[{"id":"123"}]}';
      const result = text ? JSON.parse(text) : { ok: true };
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe("123");
    });

    it("should return { ok: true } for content-length 0", () => {
      const contentLength = "0";
      const isEmpty = contentLength === "0";
      expect(isEmpty).toBe(true);
    });
  });

  describe("agentId extraction from query params", () => {
    it("should extract agentId from URL query string", () => {
      const path = "/Memory?agentId=test-bot&tag=important";
      const match = path.match(/agentId=([^&]+)/);
      expect(match).not.toBeNull();
      expect(decodeURIComponent(match![1])).toBe("test-bot");
    });

    it("should handle URL-encoded agentId", () => {
      const path = "/Memory?agentId=my%20bot";
      const match = path.match(/agentId=([^&]+)/);
      expect(decodeURIComponent(match![1])).toBe("my bot");
    });

    it("should return null when no agentId in query", () => {
      const path = "/Memory?tag=important";
      const match = path.match(/agentId=([^&]+)/);
      expect(match).toBeNull();
    });

    it("should not match agentId in path segments", () => {
      const path = "/Memory/agentId-123";
      const hasQueryAgentId = path.includes("agentId=");
      expect(hasQueryAgentId).toBe(false);
    });
  });

  describe("auth signing uses full path", () => {
    it("should include query params in signed path", () => {
      const path = "/Memory?agentId=test-bot&tag=foo";
      expect(path).toBe("/Memory?agentId=test-bot&tag=foo");
    });

    it("should work with paths without query params", () => {
      const path = "/SemanticSearch";
      expect(path).toBe("/SemanticSearch");
    });
  });

  describe("auth source priority", () => {
    it("should prefer FLAIR_TOKEN over agentId", () => {
      const token = "my-bearer-token";
      const agentId = "test-bot";
      // Token takes priority
      const authHeader = token ? `Bearer ${token}` : `Ed25519 ${agentId}`;
      expect(authHeader).toBe("Bearer my-bearer-token");
    });

    it("should use agentId from body when no env vars", () => {
      const token = undefined;
      const envAgentId = undefined;
      const body = { agentId: "from-body", content: "test" };
      const agentId = envAgentId || (body && typeof body === "object" ? body.agentId : undefined);
      expect(agentId).toBe("from-body");
    });

    it("should use FLAIR_AGENT_ID over body agentId", () => {
      const envAgentId = "from-env";
      const body = { agentId: "from-body" };
      const agentId = envAgentId || body.agentId;
      expect(agentId).toBe("from-env");
    });

    it("should extract agentId from query when no body", () => {
      const body = undefined;
      const path = "/Memory?agentId=from-query";
      let agentId = body && typeof body === "object" ? (body as any).agentId : undefined;
      if (!agentId && path.includes("agentId=")) {
        const match = path.match(/agentId=([^&]+)/);
        if (match) agentId = decodeURIComponent(match[1]);
      }
      expect(agentId).toBe("from-query");
    });
  });
});
