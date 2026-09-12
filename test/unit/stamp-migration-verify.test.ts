/**
 * stamp-migration-verify.test.ts — post-deploy / upgrade --target
 * embedding-stamp convergence check (flair#1073).
 */
import { describe, it, expect } from "bun:test";
import {
  evaluateStampSnapshot,
  inferCurrentModelId,
  verifyStampMigrationConverged,
} from "../../src/stamp-migration-verify.ts";

describe("inferCurrentModelId", () => {
  it("prefers a +searchprefix stamp over a more-common pre-flip bare stamp", () => {
    expect(
      inferCurrentModelId({
        modelCounts: {
          "nomic-embed-text-v1.5-Q4_K_M": 554,
          "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
        },
      }),
    ).toBe("nomic-embed-text-v1.5-Q4_K_M+searchprefix");
  });
});

describe("evaluateStampSnapshot", () => {
  it("is not converged on a 100% pre-flip corpus (the false-complete shape)", () => {
    const r = evaluateStampSnapshot({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M": 554 },
      cyclePhase: "done",
      migrations: [{ id: "embedding-stamp", state: "completed", rowsDone: 0, rowsRemaining: 0 }],
    });
    expect(r.converged).toBe(false);
    expect(r.detail).toContain("embedding-stamp");
  });

  it("is not converged when HealthDetail names the outstanding migration", () => {
    const r = evaluateStampSnapshot({
      modelCounts: {
        "nomic-embed-text-v1.5-Q4_K_M": 554,
        "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
      },
      warnings: [
        "migration 'embedding-stamp' is outstanding (554 rows still on nomic-embed-text-v1.5-Q4_K_M:554, 40 already current) — cross-model search is unreliable and duplicate detection is inactive until the re-embed completes; the last cycle marked it complete without converging; it will retry automatically",
      ],
    });
    expect(r.converged).toBe(false);
    expect(r.detail).toContain("duplicate detection is inactive");
  });

  it("converges on a uniform +searchprefix corpus with embedding-stamp completed", () => {
    const r = evaluateStampSnapshot({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 599 },
      cyclePhase: "done",
      migrations: [{ id: "embedding-stamp", state: "completed", rowsRemaining: 0 }],
    });
    expect(r.converged).toBe(true);
  });

  it("converges on an empty corpus", () => {
    const r = evaluateStampSnapshot({ modelCounts: {}, cyclePhase: "done" });
    expect(r.converged).toBe(true);
  });
});

describe("verifyStampMigrationConverged", () => {
  it("polls until the corpus is a single +searchprefix space", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) {
        return new Response(
          JSON.stringify({
            memories: {
              modelCounts: {
                "nomic-embed-text-v1.5-Q4_K_M": 554,
                "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
              },
            },
            migrations: {
              cyclePhase: "running",
              migrations: [{ id: "embedding-stamp", state: "running", rowsDone: 50, rowsRemaining: 504 }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          memories: { modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 594 } },
          migrations: {
            cyclePhase: "done",
            migrations: [{ id: "embedding-stamp", state: "completed", rowsDone: 554, rowsRemaining: 0 }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await verifyStampMigrationConverged({
      baseUrl: "https://flair.kris-test.harperfabric.com",
      fabricUser: "admin",
      fabricPassword: "pw",
      fetchImpl,
      pollIntervalMs: 1,
      timeoutMs: 2000,
      sleep: async () => undefined,
    });
    expect(calls).toBe(3);
  });

  it("throws when the split never heals", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          memories: {
            modelCounts: {
              "nomic-embed-text-v1.5-Q4_K_M": 554,
              "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
            },
          },
          migrations: {
            cyclePhase: "done",
            migrations: [{ id: "embedding-stamp", state: "completed", rowsDone: 0, rowsRemaining: 0 }],
          },
          warnings: [
            { level: "warn", message: "migration 'embedding-stamp' is outstanding (554 rows still on nomic-embed-text-v1.5-Q4_K_M:554) — cross-model search is unreliable and duplicate detection is inactive until the re-embed completes" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    await expect(
      verifyStampMigrationConverged({
        baseUrl: "https://flair.kris-test.harperfabric.com",
        fabricUser: "admin",
        fabricPassword: "pw",
        fetchImpl,
        pollIntervalMs: 1,
        timeoutMs: 20,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/embedding-stamp did not converge/);
  });
});
