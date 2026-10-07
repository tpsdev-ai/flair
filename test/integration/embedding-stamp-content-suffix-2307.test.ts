/**
 * embedding-stamp-content-suffix-2307.test.ts — flair#2307 item 5, real Harper.
 *
 * The embedding-stamp migration re-embeds a stale Memory row through a
 * loopback `PUT /Memory/:id`. A legacy row whose id already ends in the
 * `.content` property suffix cannot be addressed that way (Harper's REST by-id
 * path reads the suffix as a selector, and the by-id write guard refuses the
 * id), so before this change the row stayed pending and /HealthDetail kept
 * naming the migration. This pins the success path: with a working embedding
 * provider and no concurrent change, such a row is re-embedded and
 * /HealthDetail stops naming the migration.
 *
 * A suffixed SKILL row must get the vector Memory's write paths give a skill:
 * the vector of its `trigger`, not of its `content`. Two ordinary stale rows
 * whose content is that trigger text and that content text are re-embedded by
 * the migration's loopback `PUT /Memory/:id` (Memory.put's own embed path), and
 * serve as the engine's reference vectors for the two texts.
 *
 * The provider-failure, no-text, concurrent edit and deletion paths are pinned
 * in test/unit-isolated/embedding-stamp-content-suffix-2307.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

const EMBEDDING_STAMP_ID = "embedding-stamp";
const AGENT_ID = "mstamp-content-suffix-agent";
const LEGACY_ID = "mstamp-legacy.content";
const SKILL_ID = "mstamp-legacy-skill.content";
const TRIGGER_REF_ID = "mstamp-trigger-reference";
const CONTENT_REF_ID = "mstamp-content-reference";
const SKILL_TRIGGER = "when the greenhouse humidity climbs above eighty percent overnight";
const SKILL_CONTENT = "Reconcile the quarterly invoice ledger against the bank statement line by line.";
const CURRENT_MODEL_ID = getModelId();

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
async function readRow(id: string): Promise<any> {
  const row = await opsCall({
    operation: "search_by_value",
    database: "flair",
    table: "Memory",
    search_attribute: "id",
    search_value: id,
    get_attributes: ["*"],
  });
  return Array.isArray(row) ? row[0] : row;
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
async function healthDetail(): Promise<any> {
  const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
  if (!res.ok) return null;
  return res.json();
}

describe("flair#2307 item 5 — a `.content`-suffixed legacy row converges (real Harper)", () => {
  beforeAll(async () => {
    const first = await startHarper();
    installDir = first.installDir;
    authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");
    harper = first;

    // A legacy row whose id already ends in `.content` and whose embedding
    // stamp is stale.
    await opsCall({
      operation: "insert",
      database: "flair",
      table: "Memory",
      records: [
        {
          id: LEGACY_ID,
          agentId: AGENT_ID,
          content: "embedding-stamp-content-suffix-marker",
          embedding: [0.1, 0.1, 0.1],
          embeddingModel: "some-ancient-model-v0",
          createdAt: new Date().toISOString(),
        },
        {
          id: SKILL_ID,
          agentId: AGENT_ID,
          tags: ["skill"],
          trigger: SKILL_TRIGGER,
          content: SKILL_CONTENT,
          durability: "persistent",
          embedding: [0.1, 0.1, 0.1],
          embeddingModel: "some-ancient-model-v0",
          createdAt: new Date().toISOString(),
        },
        {
          id: TRIGGER_REF_ID,
          agentId: AGENT_ID,
          content: SKILL_TRIGGER,
          embedding: [0.1, 0.1, 0.1],
          embeddingModel: "some-ancient-model-v0",
          createdAt: new Date().toISOString(),
        },
        {
          id: CONTENT_REF_ID,
          agentId: AGENT_ID,
          content: SKILL_CONTENT,
          embedding: [0.1, 0.1, 0.1],
          embeddingModel: "some-ancient-model-v0",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    // Boot-keyed — restart so a fresh boot's cycle discovers the seeded row.
    await stopHarper(first, { keepInstallDir: true });
    harper = await startHarper({ installDir });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper).catch(() => {});
    await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  });

  it("the row is re-embedded, and /HealthDetail stops naming the migration", async () => {
    const deadline = Date.now() + 120_000;
    let mig: any = null;
    while (Date.now() < deadline) {
      const detail = await healthDetail();
      mig = detail?.migrations?.migrations?.find((m: any) => m.id === EMBEDDING_STAMP_ID);
      if (mig?.state === "completed") break;
      if (mig?.state === "halted" || mig?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(mig?.state).toBe("completed");

    const row = await opsCall({
      operation: "search_by_value",
      database: "flair",
      table: "Memory",
      search_attribute: "id",
      search_value: LEGACY_ID,
      get_attributes: ["*"],
    });
    const record = Array.isArray(row) ? row[0] : row;
    expect(record.embeddingModel).toBe(CURRENT_MODEL_ID);
    expect(Array.isArray(record.embedding)).toBe(true);
    expect(record.content).toBe("embedding-stamp-content-suffix-marker"); // derived-only

    const detail = await healthDetail();
    const named = (detail?.warnings ?? []).some((w: any) => String(w?.message ?? "").includes(`migration '${EMBEDDING_STAMP_ID}' is outstanding`));
    expect(named).toBe(false);
  }, 150_000);

  it("a suffixed skill row gets its trigger's vector, and is stamped current with it", async () => {
    // The migration completed in the case above (same boot).
    const skill = await readRow(SKILL_ID);
    const triggerRef = await readRow(TRIGGER_REF_ID);
    const contentRef = await readRow(CONTENT_REF_ID);
    for (const row of [skill, triggerRef, contentRef]) {
      expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
      expect(Array.isArray(row.embedding) && row.embedding.length > 3).toBe(true);
    }
    const toTrigger = cosine(skill.embedding, triggerRef.embedding);
    const toContent = cosine(skill.embedding, contentRef.embedding);
    expect(toTrigger).toBeGreaterThan(0.999); // assertion: the stored vector is the trigger's
    expect(toContent).toBeLessThan(0.99);
    expect(skill.trigger).toBe(SKILL_TRIGGER);
    expect(skill.content).toBe(SKILL_CONTENT);
  }, 30_000);
});
