import { describe, test, expect } from "bun:test";
import { resolvePrefixConvention, applyDocumentPrefix, applyQueryPrefix } from "../src/prefixes.js";

describe("resolvePrefixConvention", () => {
  test("matches nomic-embed-text-v1.5 filenames (case-insensitive, any quant)", () => {
    expect(resolvePrefixConvention("nomic-embed-text-v1.5.Q4_K_M.gguf")?.id).toBe("nomic-search-prefix");
    expect(resolvePrefixConvention("NOMIC-EMBED-TEXT-V1.5.Q8_0.GGUF")?.id).toBe("nomic-search-prefix");
  });

  test("matches nomic-embed-text-v2-moe filenames", () => {
    expect(resolvePrefixConvention("nomic-embed-text-v2-moe.Q4_K_M.gguf")?.id).toBe("nomic-search-prefix");
  });

  test("strips directory components before matching (keyed on basename)", () => {
    expect(resolvePrefixConvention("/some/path/to/nomic-embed-text-v1.5.Q4_K_M.gguf")?.id).toBe("nomic-search-prefix");
  });

  test("unknown model family resolves to undefined, not a guess", () => {
    expect(resolvePrefixConvention("some-other-embedding-model.Q4_K_M.gguf")).toBeUndefined();
  });
});

describe("applyDocumentPrefix / applyQueryPrefix", () => {
  const convention = resolvePrefixConvention("nomic-embed-text-v1.5.Q4_K_M.gguf");

  test("document prefix matches HFE's literal string exactly", () => {
    expect(applyDocumentPrefix("hello world", convention)).toBe("search_document: hello world");
  });

  test("query prefix matches HFE's literal string exactly", () => {
    expect(applyQueryPrefix("hello world", convention)).toBe("search_query: hello world");
  });

  test("no convention -> text passes through unprefixed", () => {
    expect(applyDocumentPrefix("hello world", undefined)).toBe("hello world");
    expect(applyQueryPrefix("hello world", undefined)).toBe("hello world");
  });
});
