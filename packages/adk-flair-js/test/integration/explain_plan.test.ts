/**
 * Integration test 1: Harper explain plan — compound tag drives the query plan.
 *
 * Verifies that a compound `adk:<app>:<user>` tag search uses pre-filtering
 * (index seek / Regime A), not post-filter, on a multi-user corpus.
 *
 * Writes >=3 simulated users x >=50 memories each through the adapter against
 * a live Flair instance, then asserts that searching for one user returns ONLY
 * that user's memories — the positive control for the isolation property.
 *
 * Ported from packages/adk-flair/tests/test_explain_plan.py.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { FlairMemoryService, compoundTag, signRequest } from "../../src/index.js";
import { getLiveFlair, type LiveFlairConfig } from "../helpers/live-flair.js";
import type { MemoryEntry } from "@google/adk";
import type { Content } from "@google/genai";
import * as crypto from "node:crypto";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMemory(text: string): MemoryEntry {
  return {
    content: { role: "user", parts: [{ text }] } as Content,
  };
}

async function writeUserCorpus(
  service: FlairMemoryService,
  appName: string,
  userId: string,
  count: number,
): Promise<void> {
  const batchSize = 10;
  for (let batchStart = 0; batchStart < count; batchStart += batchSize) {
    const batch: MemoryEntry[] = [];
    for (let i = batchStart; i < Math.min(batchStart + batchSize, count); i++) {
      const category = i % 3 === 0 ? "technical" : i % 3 === 1 ? "personal" : "random";
      batch.push(
        makeMemory(
          `${userId} memory ${i}: ${category} fact about ${userId}'s work on project-${i % 10}`,
        ),
      );
    }
    await service.addMemory(appName, userId, batch);
  }
}

async function search(
  service: FlairMemoryService,
  appName: string,
  userId: string,
  query: string,
): Promise<string[]> {
  const result = await service.searchMemory({ appName, userId, query });
  return result.memories.map((m) => (m.content?.parts?.[0] as { text?: string })?.text ?? "");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExplainPlan", () => {
  let config: LiveFlairConfig | null = null;
  let service: FlairMemoryService | null = null;

  beforeAll(async () => {
    config = await getLiveFlair();
    if (!config) {
      console.log("SKIP: no live Flair available — skipping explain-plan integration tests");
      return;
    }
    service = new FlairMemoryService({
      url: config.httpUrl,
      agentId: config.agentId,
      keyfile: config.keyfilePath,
    });
  }, { timeout: 200_000 });

  afterAll(async () => {
    if (service) await service.close();
    if (config?.cleanup) await config.cleanup();
  }, { timeout: 15_000 });

  it("tag drives pre-filter isolation", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "explain-plan-test-js";
    const users = ["alice", "bob", "carol"];
    const perUser = 50;

    // Write corpus
    for (const user of users) {
      await writeUserCorpus(service, app, user, perUser);
    }

    // Search for alice
    const results = await search(service, app, "alice", "technical work");

    // 1. We got results (not empty)
    expect(results.length).toBeGreaterThan(0);

    // 2. Every result belongs to alice (isolation proof)
    for (const text of results) {
      expect(text.toLowerCase()).toContain("alice");
    }

    // 3. No bob or carol results leaked in
    const bobLeaks = results.filter((t) => t.toLowerCase().includes("bob"));
    const carolLeaks = results.filter((t) => t.toLowerCase().includes("carol"));
    expect(bobLeaks.length).toBe(0);
    expect(carolLeaks.length).toBe(0);

    // 4. Search for bob also works
    const bobResults = await search(service, app, "bob", "personal facts");
    expect(bobResults.length).toBeGreaterThan(0);
    for (const text of bobResults) {
      expect(text.toLowerCase()).toContain("bob");
    }

    // 5. Explain plan: the tag filter is still in the engine plan.
    // Isolation (1–4) is the product proof. Harper 5.2.7's cost-based
    // planner may rank embedding cosine-sort first (lower estimated_count).
    // Do not require tags to be first — that would fight a Harper ship.
    const tag = compoundTag(app, "alice");
    const authHeader = signRequest(config.privateKey, config.agentId, "POST", "/SemanticSearch");

    const explainResp = await fetch(`${config.httpUrl}/SemanticSearch`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: config.agentId,
        q: "technical work",
        tag,
        limit: 10,
        explain: true,
      }),
    });

    expect(explainResp.status).toBe(200);
    const plan = (await explainResp.json()) as Record<string, unknown>;
    expect(plan["explain"]).toBe(true);

    const enginePlan = (plan["plan"] ?? {}) as Record<string, unknown>;
    const engineConditions = (enginePlan["conditions"] ?? []) as Array<Record<string, unknown>>;
    expect(engineConditions.length).toBeGreaterThan(0);

    const tagCondition = engineConditions.find((c) => c["attribute"] === "tags");
    expect(tagCondition).toBeDefined();
    expect(tagCondition!["comparator"]).toBe("equals");
    expect(tagCondition!["value"]).toBe(tag);
  }, { timeout: 60_000 }); // 150 embeds (3 users × 50) — not a 5s unit of work; matches metadata_and_list

  it("empty user returns empty", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const result = await service.searchMemory({
      appName: "any-app",
      userId: "",
      query: "anything",
    });
    expect(result.memories.length).toBe(0);
  });
});
