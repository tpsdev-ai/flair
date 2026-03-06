import { describe, expect, test } from "bun:test";
import { computeContentHash, findExistingMemoryByContentHash } from "../../resources/memory-feed-lib";

describe("memory-feed-lib", () => {
  test("computes a stable 16-char content hash from agentId and content", () => {
    const hash = computeContentHash("ember", "dedup me");

    expect(hash).toHaveLength(16);
    expect(hash).toBe(computeContentHash("ember", "dedup me"));
    expect(hash).not.toBe(computeContentHash("anvil", "dedup me"));
  });

  test("finds an existing memory only for the matching agent and hash", async () => {
    const emberHash = computeContentHash("ember", "same memory");
    const anvilHash = computeContentHash("anvil", "same memory");
    const existing = await findExistingMemoryByContentHash(
      [
        { id: "other-agent", agentId: "anvil", contentHash: anvilHash },
        { id: "match", agentId: "ember", contentHash: emberHash },
      ],
      "ember",
      emberHash,
    );

    expect(existing?.id).toBe("match");
  });

  test("returns null when no duplicate exists", async () => {
    const existing = await findExistingMemoryByContentHash(
      [{ id: "mem-1", agentId: "ember", contentHash: "aaaaaaaaaaaaaaaa" }],
      "ember",
      "bbbbbbbbbbbbbbbb",
    );

    expect(existing).toBeNull();
  });
});
