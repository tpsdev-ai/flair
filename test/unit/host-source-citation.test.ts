/**
 * host-source-citation.test.ts — flair#1940 A6 (slice 2b).
 *
 * Unit coverage for the bootstrap citation format constant and its renderer:
 * the id is display-truncated to 8 characters, the claim is marked unverified,
 * a withheld pointer renders the withheld marker (never the host object), and a
 * record with no renderable pointer renders nothing. The per-item length bound
 * A6 sets (20 tokens) is asserted against the shared token estimator.
 */
import { describe, expect, it } from "bun:test";
import {
  formatHostSourceCitation,
  HOST_SOURCE_CITATION_FORMAT,
  HOST_SOURCE_CITATION_MAX_TOKENS,
  HOST_SOURCE_ID_DISPLAY_CHARS,
  HOST_SOURCE_WITHHELD_CITATION,
} from "../../resources/host-source-citation";
import { estimateTokens } from "../../resources/token-estimate";

describe("flair#1940 A6 — bootstrap host-source citation", () => {
  it("renders host/kind and the first 8 id characters, marked unverified", () => {
    const out = formatHostSourceCitation({ v: 1, host: "openclaw", kind: "run", id: "run-123456789abc" });
    expect(out).toBe("[via openclaw/run run-1234 (unverified)]"); // assertion
    expect(HOST_SOURCE_CITATION_FORMAT).toBe("[via {host}/{kind} {id8} (unverified)]"); // assertion: one exported format
    expect(HOST_SOURCE_ID_DISPLAY_CHARS).toBe(8); // assertion
  });

  it("never renders the URL (A6: the full URL is MCP/CLI detail only)", () => {
    const out = formatHostSourceCitation({
      v: 1, host: "cursor", kind: "launch", id: "launch-1",
      url: "https://host.test/path#frag",
    });
    expect(out).toBe("[via cursor/launch launch-1 (unverified)]"); // assertion
    expect(String(out)).not.toContain("host.test"); // assertion: no URL in the prose citation
  });

  it("renders the withheld marker for a withheld pointer, never the host object", () => {
    expect(formatHostSourceCitation("withheld")).toBe(HOST_SOURCE_WITHHELD_CITATION); // assertion
    expect(HOST_SOURCE_WITHHELD_CITATION).toBe("[via withheld]"); // assertion
  });

  it("renders nothing for an absent or non-renderable pointer", () => {
    expect(formatHostSourceCitation(undefined)).toBeNull(); // assertion
    expect(formatHostSourceCitation(null)).toBeNull(); // assertion
    expect(formatHostSourceCitation({ v: 1, host: "openclaw" } as any)).toBeNull(); // assertion: missing kind/id
  });

  it("stays within the per-item token budget for the longest accepted id", () => {
    const longId = "a".repeat(256); // the id grammar's maximum length (A2)
    const out = formatHostSourceCitation({ v: 1, host: "openclaw", kind: "run", id: longId })!;
    expect(out.length).toBeGreaterThan(0); // assertion: it rendered
    expect(estimateTokens(out)).toBeLessThanOrEqual(HOST_SOURCE_CITATION_MAX_TOKENS); // assertion: ≤ 20 tokens
  });
});
