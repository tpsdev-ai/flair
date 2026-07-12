/**
 * migrations-embedding-stamp-e2e.test.ts — the FIRST registered migration
 * (embedding-stamp, always active — no opt-in env needed) against real
 * Harper. Verifies it reuses Memory.put()'s own regen branch (a REAL
 * embedding gets computed, not a stub) for a stale-string row AND an
 * explicit-null row, and proves a genuinely important, empirically-derived
 * correctness fix.
 *
 * GROUND-TRUTH FINDING (from building this test against real Harper, not
 * assumed): Harper's index layer NEVER creates an entry for a truly-ABSENT
 * property — `getIndexedValues()` returns `undefined` for `value ===
 * undefined` unconditionally, distinct from an EXPLICIT `null` (which IS
 * indexed when `indexNulls` is on, the default for a new index). That makes
 * a genuinely-never-set attribute invisible to EVERY condition-based query
 * (`not_equal`, `equals: null`, an OR of both) — not a `not_equal`-specific
 * quirk. resources/migrations/embedding-stamp.ts's fix: its OWN writes
 * clear `embedding`/`embeddingModel` to explicit `null` (never
 * undefined/delete), so a failed regen still leaves a QUERYABLE row instead
 * of a permanently-invisible one, and its pending condition ORs
 * `not_equal <current>` with `equals: null` to catch both states. A row
 * whose embeddingModel was NEVER touched by anything at all (truly absent
 * since its very first write) remains a known, narrow gap outside this
 * migration's bounded-query reach — see that file's module doc.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const EMBEDDING_STAMP_ID = "embedding-stamp";
const AGENT_ID = "__flair_embedding_stamp_e2e_test_agent__";

let harper: HarperInstance;
let installDir: string;
let authHeader: string;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function healthDetail(): Promise<any> {
  const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
  if (!res.ok) return null;
  return res.json();
}

describe("zero-touch migrations — embedding-stamp end-to-end (real Harper, always-active migration)", () => {
  beforeAll(async () => {
    const first = await startHarper();
    installDir = first.installDir;
    authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");
    harper = first;

    // Row A: an explicit STALE embeddingModel string (the common case — a
    // model upgrade left old rows behind).
    // Row B: EXPLICIT null (a prior regen attempt failed, or a write raced
    // the embeddings engine's boot probe) — the queryable state
    // embedding-stamp's own writes now guarantee, per the module doc above.
    await opsCall({
      operation: "insert",
      database: "flair",
      table: "Memory",
      records: [
        {
          id: "stamp-stale-model",
          agentId: AGENT_ID,
          content: "embedding-stamp-e2e-marker-alpha",
          embedding: [0.9, 0.9, 0.9],
          embeddingModel: "some-ancient-model-v0",
          createdAt: new Date().toISOString(),
        },
        {
          id: "stamp-explicit-null",
          agentId: AGENT_ID,
          content: "embedding-stamp-e2e-marker-beta",
          embedding: null,
          embeddingModel: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    // Boot-keyed — restart so a fresh boot's cycle discovers these seeded rows.
    await stopHarper(first, { keepInstallDir: true });
    harper = await startHarper({ installDir });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper).catch(() => {});
    await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  });

  test("both the stale-model row and the explicit-null row get re-embedded via Memory.put()'s own regen path", async () => {
    const deadline = Date.now() + 90_000;
    let mig: any = null;
    while (Date.now() < deadline) {
      const detail = await healthDetail();
      mig = detail?.migrations?.migrations?.find((m: any) => m.id === EMBEDDING_STAMP_ID);
      if (mig?.state === "completed") break;
      if (mig?.state === "halted" || mig?.state === "failed") {
        throw new Error(`embedding-stamp ${mig.state}: ${mig.reason}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    expect(mig?.state).toBe("completed");
    expect(mig?.rowsRemaining).toBe(0);

    for (const id of ["stamp-stale-model", "stamp-explicit-null"]) {
      const row = await opsCall({
        operation: "search_by_value",
        database: "flair",
        table: "Memory",
        search_attribute: "id",
        search_value: id,
        get_attributes: ["*"],
      });
      const record = Array.isArray(row) ? row[0] : row;
      // A REAL embedding was computed — not the stub the two synthetic-test
      // files use (those explicitly avoid this to stay fast; this test
      // exists specifically to prove the real regen path works).
      expect(Array.isArray(record.embedding)).toBe(true);
      expect(record.embedding.length).toBeGreaterThan(0);
      expect(typeof record.embeddingModel).toBe("string");
      expect(record.embeddingModel).not.toBe("some-ancient-model-v0");
      // Content untouched — proves the migration is genuinely derived-only.
      expect(record.content).toContain("embedding-stamp-e2e-marker");
    }
  }, 120_000);
});
