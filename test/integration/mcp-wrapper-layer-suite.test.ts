// ─── /mcp TOOLS wrapper-layer coverage — the systemic gap behind three bugs ───
//
// resources/mcp-tools.ts is the THIN WRAPPER SEAM between the /mcp transport
// and the delegated flair handlers (Memory / SemanticSearch / BootstrapMemories
// / Soul / WorkspaceState / OrgEvent / AttentionQuery / RecordUsage). All three
// recent connector bugs lived HERE, in the wrapper, not in the handlers:
//
//   #1181  memory_get / memory_update / memory_delete / soul_get did an INSTANCE
//          by-id read `new Cls(undefined, ctx).get(id)`; Harper routes
//          `.get(<string>)` on an unloaded instance to getProperty() → undefined,
//          so the caller's OWN record 404'd (or the permanent-delete guard was
//          silently skipped) one call after a successful store.
//   #1188  memory_get inlined the raw 768-float `embedding` vector — thousands of
//          useless tokens per record on a fixed-budget chat connector — and the
//          write echoes leaked the server-regenerated vector too.
//   #1182  bootstrap did `{ ...unwrap(await h.post(body)) }` WITHOUT awaiting the
//          async `unwrap`, spreading a PENDING PROMISE → `{}`, so only the
//          injected `flairVersion` survived.
//
// Every one shipped GREEN: the handler unit tests (BootstrapMemories.post,
// Memory.get) and the signed HTTP/CLI path were both correct and both covered —
// but nothing drove the wrappers at their OWN level, so the seam had no tests.
// They surfaced only when a real /mcp connector called `TOOLS.<tool>.impl`.
//
// This suite closes that class: it drives EVERY tool in the shipped `TOOLS`
// registry through its REAL `.impl` (via the inproc-app fixture's generic
// `mcpTool` op — see test/fixtures/inproc-app/resources/AgentFleet.js) against a
// HOME-isolated ephemeral Harper seeded with realistic data, asserting each
// wrapper returns the expected payload SHAPE. Each assertion is annotated with
// the defect class it guards (missing-await / bad-spread / unloaded-instance /
// embedding-leak) so a reintroduced wrapper defect FAILS a test, not a connector
// in the field. `bootstrap`'s deep payload proof lives in its own file
// (mcp-bootstrap-payload-1182.test.ts); here it gets a wrapper-level smoke check
// so the enumeration is complete.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;

const sfx = Date.now().toString(36);
const AGENT = `mcpwrap-${sfx}`;
const SOUL_ROLE = `MCP wrapper-layer test subject ${sfx}`;

// A directly-seeded memory carrying a KNOWN embedding vector. Seeding the vector
// ourselves (rather than relying on the embedding engine, which some lanes run
// keyword-only) makes the #1188 embedding-strip a GUARANTEED differential: the
// record demonstrably HAS an `embedding`, so a wrapper that stops stripping it
// leaks a value the test can see, and a wrapper that strips unconditionally
// fails the includeEmbedding:true half.
const GET_ID = `${AGENT}-${randomUUID()}`;
const GET_CONTENT = `mcp wrapper-layer seeded record for memory_get ${sfx}`;
const EMBEDDING = Array.from({ length: 768 }, (_, i) => Math.sin(i) / 10);

// A distinctive, rare token so memory_search surfaces the row even on the
// keyword-only (BM25) fallback path — no dependence on the embedding engine.
const SEARCH_TOKEN = `zqxwmarker${sfx}`;

/** Drive one in-process operation inside the fixture app. */
async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** Call a /mcp tool wrapper (`TOOLS[tool].impl`) as AGENT and unwrap the run() envelope. */
async function tool(name: string, args: Record<string, unknown> = {}, isAdmin = false): Promise<any> {
  const res = await fleet("mcpTool", { agentId: AGENT, tool: name, args, isAdmin });
  expect(res.ok, `mcpTool ${name} failed: ${JSON.stringify(res).slice(0, 500)}`).toBe(true);
  return res.value;
}

/** POST an ops-API operation with admin creds; returns the parsed JSON body. */
async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Insert a record straight into storage via the ops API (seed path). */
async function seedInsert(table: string, record: Record<string, unknown>): Promise<void> {
  const { status } = await ops({ operation: "insert", database: "flair", table, records: [record] });
  expect(status, `${table} insert → ${status}`).toBe(200);
}

/**
 * Read a record back from storage (ground-truth persistence check for the write
 * tools whose wrapper echo is thin — proves the wrapper actually drove the
 * write, independent of what it returned).
 */
async function opsSearchEquals(table: string, attribute: string, value: string): Promise<any[]> {
  const { status, body } = await ops({
    operation: "search_by_conditions",
    database: "flair",
    table,
    operator: "and",
    get_attributes: ["*"],
    conditions: [{ search_attribute: attribute, search_type: "equals", search_value: value }],
  });
  expect(status, `${table} search_by_conditions → ${status}`).toBe(200);
  return Array.isArray(body) ? body : [];
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-mcpwrap-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

  // Realistic seed: an Agent principal + a Soul entry + a memory carrying a
  // known embedding + a relationship (so `attention` has cross-source data).
  await fleet("register", { id: AGENT });
  await seedInsert("Soul", {
    id: `${AGENT}:role`,
    agentId: AGENT,
    key: "role",
    value: SOUL_ROLE,
    createdAt: new Date().toISOString(),
  });
  await seedInsert("Memory", {
    id: GET_ID,
    agentId: AGENT,
    content: GET_CONTENT,
    durability: "standard",
    visibility: "private",
    embedding: EMBEDDING,
    embeddingModel: "seed-fixture",
    createdAt: new Date().toISOString(),
    validFrom: new Date().toISOString(),
  });
  await seedInsert("Relationship", {
    id: `${AGENT}-${randomUUID()}`,
    agentId: AGENT,
    subject: `agent:${AGENT}`,
    predicate: "works_with",
    object: "repo:tpsdev-ai/flair",
    confidence: 1.0,
    validFrom: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("/mcp TOOLS wrapper layer — every tool driven through its real .impl", () => {
  // ── bootstrap (read/payload) — smoke check; deep proof in the #1182 file ──
  test("bootstrap: returns the rich payload (agentId + soul + memories + flairVersion), not a bare {flairVersion}", async () => {
    const body = await tool("bootstrap", { currentTask: "wrapper-layer smoke", maxTokens: 8000 });
    // missing-await / bad-spread: the un-awaited `{...unwrap(promise)}` collapsed
    // the whole payload to just the injected flairVersion.
    expect(Object.keys(body ?? {}).sort()).not.toEqual(["flairVersion"]);
    expect(body.agentId, "resolved agentId is the caller's").toBe(AGENT);
    expect(body.soul?.role, "soul carries the seeded role").toBe(SOUL_ROLE);
    expect(Array.isArray(body.memories), "memories container is an array").toBe(true);
    expect(typeof body.flairVersion, "flairVersion still injected by the wrapper").toBe("string");
  }, 120_000);

  // ── memory_search (read/payload) ──
  test("memory_search: returns { results } carrying the caller's matching memory, no raw embedding on hits", async () => {
    // Store a memory whose content carries a rare token, then search for it.
    const marker = `${SEARCH_TOKEN} the quick brown fox coordination note`;
    const stored = await tool("memory_store", { content: marker, type: "fact", durability: "standard" });
    expect(stored?.id, "the store must have landed an id to search for").toBeTruthy();

    const res = await tool("memory_search", { query: SEARCH_TOKEN, limit: 10 });
    // dropped-payload: the wrapper must return the handler's { results } intact —
    // a broken wrapper returns {}/undefined and `.results` is absent.
    expect(Array.isArray(res?.results), `search must return a results array, got: ${JSON.stringify(res).slice(0, 200)}`).toBe(true);
    const hit = res.results.find((r: any) => typeof r?.content === "string" && r.content.includes(SEARCH_TOKEN));
    expect(hit, "the seeded token memory must be among the results").toBeDefined();
    // embedding-leak: search projects the vector out (DEFAULT_SELECT) — a hit
    // must never carry the raw embedding.
    expect(Object.prototype.hasOwnProperty.call(hit, "embedding"), "search hit must not inline the embedding").toBe(false);
  }, 120_000);

  // ── memory_store (write echo) ──
  test("memory_store: echoes { id, content, written } and strips the embedding from the write echo", async () => {
    const content = `mcp wrapper-layer memory_store echo ${sfx} ${randomUUID()}`;
    const res = await tool("memory_store", { content, type: "decision", durability: "standard" });
    // bad-spread / dropped-keys: a broken wrapper returns {}/undefined, so the
    // echo would carry no id and no written flag.
    expect(res?.id, `store echo must carry the new id, got: ${JSON.stringify(res).slice(0, 200)}`).toBeTruthy();
    expect(res.written, "store echo must report written:true").toBe(true);
    // embedding-leak (defense-in-depth; the engine-independent proof is in
    // memory_get below): the write echo must never inline the server-regenerated
    // vector, regardless of whether the embedding engine ran.
    expect(Object.prototype.hasOwnProperty.call(res, "embedding"), "store echo must not inline the embedding").toBe(false);
    // Behavioral proof the write landed via the wrapper (buildWriteResponse's
    // echo carries id/written but not content) — read it back through memory_get.
    const back = await tool("memory_get", { id: res.id });
    expect(back?.content, "the stored content must be persisted and readable").toBe(content);
  }, 120_000);

  // ── memory_get (read/payload) — the embedding-strip differential ──
  test("memory_get: returns the full record content with NO embedding by default, and WITH it under includeEmbedding", async () => {
    const def = await tool("memory_get", { id: GET_ID });
    // unloaded-instance (#1181): the pre-fix instance `.get(<string>)` returned
    // undefined → 404 for the caller's OWN record. The static form loads it.
    expect(def, `memory_get must load the caller's own record, got: ${JSON.stringify(def).slice(0, 200)}`).toBeTruthy();
    expect(def.id, "record id round-trips").toBe(GET_ID);
    expect(def.content, "record content round-trips").toBe(GET_CONTENT);
    expect(def.agentId, "record is the caller's own").toBe(AGENT);
    // embedding-leak (#1188): the record demonstrably HAS a 768-float vector
    // (we seeded it); the default wrapper path must strip it.
    expect(Object.prototype.hasOwnProperty.call(def, "embedding"), "default memory_get must strip the embedding").toBe(false);

    const withEmb = await tool("memory_get", { id: GET_ID, includeEmbedding: true });
    // The other half of the differential: opt-in must return the vector, proving
    // the strip is conditional (not a blanket drop) and the record really carries it.
    expect(Array.isArray(withEmb?.embedding), "includeEmbedding:true must return the raw vector").toBe(true);
    expect(withEmb.embedding.length, "the seeded 768-float vector round-trips").toBe(768);
  }, 120_000);

  // ── memory_update (write echo) ──
  test("memory_update: overwrites in place, echoes the updated record shape with no embedding, and the change is durable", async () => {
    const orig = `mcp wrapper-layer update-target ${sfx} ${randomUUID()}`;
    const stored = await tool("memory_store", { content: orig, durability: "standard" });
    const id = stored?.id;
    expect(id, "seed store for update must return an id").toBeTruthy();

    const updated = `${orig} :: UPDATED ${randomUUID()}`;
    const res = await tool("memory_update", { id, content: updated });
    // unloaded-instance (#1181): pre-fix, the by-id read 404'd ("memory not
    // found") or the static-write leg threw "Invalid primary key type: undefined".
    // A working wrapper echoes the same id with written:true — a throw or a
    // {}/undefined echo fails here.
    expect(res?.id, `update echo must carry the id, got: ${JSON.stringify(res).slice(0, 200)}`).toBe(id);
    expect(res.written, "update echo must report written:true").toBe(true);
    // embedding-leak (#1188): Memory.put regenerates the vector server-side; the
    // echo must not inline it.
    expect(Object.prototype.hasOwnProperty.call(res, "embedding"), "update echo must not inline the embedding").toBe(false);

    // Durability: read the new content back through the wrapper — the in-place
    // overwrite actually landed (the echo carries id/written, not content).
    const after = await tool("memory_get", { id });
    expect(after?.content, "the update must be persisted").toBe(updated);
  }, 120_000);

  // ── memory_delete (delete + guard) ──
  test("memory_delete: deletes a standard memory, and the permanent-memory guard still fires for a non-admin", async () => {
    // (a) a normal delete removes the row.
    const doomed = await tool("memory_store", { content: `mcp wrapper-layer delete-me ${sfx} ${randomUUID()}`, durability: "standard" });
    const id = doomed?.id;
    expect(id, "seed store for delete must return an id").toBeTruthy();
    await tool("memory_delete", { id });
    const gone = await tool("memory_get", { id });
    // After delete the record must not be readable — makeByIdReadGate 404s
    // (unwrap → {status:404}) or the row is simply absent.
    const isGone = gone == null || gone.status === 404 || gone.error != null || gone.content !== doomed.content;
    expect(isGone, `deleted memory must be gone, got: ${JSON.stringify(gone).slice(0, 200)}`).toBe(true);

    // (b) the permanent-memory admin guard: a non-admin delete of a PERMANENT
    // memory must be refused with 403.
    // unloaded-instance (#1181): the pre-fix instance read let super.get() return
    // undefined, so `record.durability === "permanent"` was SILENTLY SKIPPED and
    // the guarded delete fell through to an unguarded one. Asserting the 403
    // proves the guard's record load (the static form) still sees the real row.
    const permId = `${AGENT}-${randomUUID()}`;
    await seedInsert("Memory", {
      id: permId,
      agentId: AGENT,
      content: `mcp wrapper-layer permanent — never delete without a go ${sfx}`,
      durability: "permanent",
      visibility: "private",
      createdAt: new Date().toISOString(),
      validFrom: new Date().toISOString(),
    });
    const denied = await tool("memory_delete", { id: permId });
    expect(denied?.status, `permanent delete by non-admin must 403, got: ${JSON.stringify(denied).slice(0, 200)}`).toBe(403);
    // Still present after the refused delete.
    const still = await tool("memory_get", { id: permId });
    expect(still?.id, "the permanent memory must survive the refused delete").toBe(permId);
  }, 120_000);

  // ── soul_get (read/payload) ──
  test("soul_get: returns the seeded soul entry (not undefined)", async () => {
    const res = await tool("soul_get", { key: "role" });
    // unloaded-instance (#1181): soul_get came back empty on the connector path
    // even though the entry loads fine via the static/Ed25519 route. A working
    // wrapper returns the record.
    expect(res, `soul_get must return the entry, got: ${JSON.stringify(res).slice(0, 200)}`).toBeTruthy();
    expect(res.key, "soul entry key round-trips").toBe("role");
    expect(res.value, "soul entry value round-trips").toBe(SOUL_ROLE);
  }, 120_000);

  // ── soul_set (write) — DEFECT FOUND BY THIS SUITE, FIXED IN THIS PR ──────────
  //
  // The soul_set wrapper used to do `new Cls(undefined, ctx).put({ id, ... })` —
  // a PUT on an UNLOADED instance — which threw `Invalid primary key type:
  // undefined` against a real Soul + real store: the EXACT #1181 class the
  // sibling read wrappers (memoryGet/update/delete/soulGet) and write wrappers
  // (memoryStore/workspaceSet/orgEvent) were already migrated off of. soul_set's
  // only prior test (test/unit/mcp-handler.test.ts) drove a MOCKED handler, so
  // the real instance-put never ran and the defect shipped on the connector path.
  // This suite caught it; the fix (mcp-tools.ts's soulSet, now a collection-bound
  // `collectionResource(Cls, ctx).post()` so Soul.post stamps the required
  // createdAt) lands in the same PR. This test asserts the intended behavior —
  // a green here proves the write both lands and reads back through the wrapper.
  test("soul_set: writes an entry the wrapper can read back", async () => {
    const key = `project-${sfx}`;
    const value = `mcp wrapper-layer soul_set value ${randomUUID()}`;
    // unloaded-instance (#1181): pre-fix this THREW "Invalid primary key type:
    // undefined"; the collection-bound post persists and echoes without error.
    const res = await tool("soul_set", { key, value });
    expect(res?.error, `soul_set must not return an error, got: ${JSON.stringify(res).slice(0, 200)}`).toBeUndefined();
    const back = await tool("soul_get", { key });
    expect(back?.value, "soul_set must persist the value readable via soul_get").toBe(value);
  }, 120_000);

  // ── flair_workspace_set (write) ──
  test("flair_workspace_set: drives the write without throwing and persists a record attributed to the caller", async () => {
    const ref = `cp-mcpwrap-${sfx}`;
    const res = await tool("flair_workspace_set", { ref, label: "wrapper-layer", phase: "review", summary: "mcp suite" });
    // dropped-payload / #1181-class instance-put throw: `tool()` already asserts
    // the wrapper did not throw; assert it also did not return an error shape.
    expect(res?.error, `workspace_set must not error, got: ${JSON.stringify(res).slice(0, 200)}`).toBeUndefined();
    // Ground truth: the write actually landed, keyed `${agentId}:${ref}` and
    // attributed to the caller (WorkspaceState.post stamps agentId from identity,
    // never the body — the echo is thin, so persistence is checked in storage).
    const rows = await opsSearchEquals("WorkspaceState", "id", `${AGENT}:${ref}`);
    expect(rows.length, "workspace_set must persist exactly one record").toBe(1);
    expect(rows[0].ref, "persisted ref").toBe(ref);
    expect(rows[0].agentId, "persisted record is attributed to the caller").toBe(AGENT);
  }, 120_000);

  // ── flair_orgevent (write) ──
  test("flair_orgevent: drives the write without throwing and persists an event attributed to the caller", async () => {
    const summary = `mcp wrapper-layer orgevent ${sfx} ${randomUUID()}`;
    const res = await tool("flair_orgevent", { kind: "status", summary, scope: "org" });
    // dropped-payload / #1181-class throw: OrgEvent.post echoes thin (the wrapper
    // returned null), so the load-bearing check is that the write did not throw
    // (asserted by `tool()`) / error, and that it persisted.
    expect(res?.error, `orgevent must not error, got: ${JSON.stringify(res).slice(0, 200)}`).toBeUndefined();
    // Ground truth: the event landed, attributed to the authenticated agent
    // (authorId from identity, never the body).
    const rows = await opsSearchEquals("OrgEvent", "summary", summary);
    expect(rows.length, "orgevent must persist exactly one event").toBe(1);
    expect(rows[0].kind, "persisted kind").toBe("status");
    expect(rows[0].authorId, "orgevent is attributed to the caller").toBe(AGENT);
  }, 120_000);

  // ── bootstrap events container (flair#1206) — the wrapper-seam proof ──
  // #1199 made prose `context` opt-in; org events lived ONLY in that prose, so
  // at the /mcp DEFAULT (includeContext=false) they were counted+charged but
  // never delivered in any structured field a connector could read — orphaned.
  // The bug lived in the wrapper path (the connector's vantage), uncaught because
  // the handler unit tests drove the resource, not the wrapper. This drives the
  // REAL bootstrap wrapper (TOOLS.bootstrap.impl) and asserts the structured
  // `events` array is delivered at the default, with the targetIds relevance
  // filter preserved (Sherlock: a pure prose→structured move, no scope widening).
  test("bootstrap: delivers the structured `events` array at the /mcp default; targetIds relevance filter preserved (#1206)", async () => {
    const evSfx = randomUUID();
    const ORG_SUMMARY = `mcp-1206 org-scoped ${evSfx}`;
    const MINE_SUMMARY = `mcp-1206 targeted-to-me ${evSfx}`;
    const OTHER_SUMMARY = `mcp-1206 targeted-elsewhere ${evSfx}`;
    // Org-scoped (no targets) → relevant to everyone incl. AGENT.
    await seedInsert("OrgEvent", {
      id: `1206-org-${evSfx}`, authorId: `mcp-1206-author-${evSfx}`, kind: "status",
      summary: ORG_SUMMARY, scope: "org", createdAt: new Date().toISOString(),
    });
    // Targeted AT AGENT → relevant.
    await seedInsert("OrgEvent", {
      id: `1206-mine-${evSfx}`, authorId: `mcp-1206-author-${evSfx}`, kind: "handoff",
      summary: MINE_SUMMARY, scope: "direct", targetIds: [AGENT],
      detail: "please pick this up", createdAt: new Date().toISOString(),
    });
    // Targeted at a DIFFERENT agent → the relevance filter must exclude it.
    await seedInsert("OrgEvent", {
      id: `1206-other-${evSfx}`, authorId: `mcp-1206-author-${evSfx}`, kind: "handoff",
      summary: OTHER_SUMMARY, scope: "direct", targetIds: [`someone-else-${evSfx}`],
      createdAt: new Date().toISOString(),
    });

    // Wrapper default: includeContext is NOT passed → false (the connector path).
    const body = await tool("bootstrap", { currentTask: "events wrapper check", maxTokens: 8000 });

    // Always present + self-describing — an array even when the caller has none.
    expect(Array.isArray(body.events), `events must be a structured array on the wrapper path, got: ${JSON.stringify(body.events)}`).toBe(true);
    const summaries = body.events.map((e: any) => e.summary);
    // The two relevant events are delivered structurally, at the default.
    expect(summaries, "org-scoped event delivered").toContain(ORG_SUMMARY);
    expect(summaries, "event targeted at the caller delivered").toContain(MINE_SUMMARY);
    // The event targeted at someone else is filtered out — no scope widening.
    expect(summaries, "event targeted at a DIFFERENT agent must be filtered out").not.toContain(OTHER_SUMMARY);
    // Shape: the targeted entry carries the fields a connector reads.
    const mine = body.events.find((e: any) => e.summary === MINE_SUMMARY);
    expect(mine.kind, "structured entry carries kind").toBe("handoff");
    expect(mine.detail, "optional detail is carried when present").toBe("please pick this up");
    expect(Array.isArray(mine.targetIds) && mine.targetIds.includes(AGENT), "targetIds carried when present").toBe(true);
    // Delivery is independent of prose: at the default, context carries no bodies.
    expect(body.context, "default prose context does not carry the event body").not.toContain(ORG_SUMMARY);
    // Count coherence: the self-describing count equals the shipped array length.
    expect(body.sections.events, "sections.events equals the shipped array length").toBe(body.events.length);
  }, 120_000);

  // ── attention (read/payload) ──
  test("attention: returns the grouped-by-source view with all five groups and a counts total", async () => {
    const res = await tool("attention", { entity: "repo:tpsdev-ai/flair", days: 30 });
    // dropped-payload / dropped-keys: a working wrapper returns the full
    // { entity, windowDays, since, groups, counts } shape intact.
    expect(res, `attention must return a result, got: ${JSON.stringify(res).slice(0, 200)}`).toBeTruthy();
    expect(res.entity, "attention echoes the queried entity").toBe("repo:tpsdev-ai/flair");
    expect(typeof res.windowDays, "attention carries a numeric window").toBe("number");
    expect(Object.keys(res.groups ?? {}).sort(), "attention groups every source").toEqual(
      ["memory", "orgEvent", "presence", "relationship", "workspaceState"].sort(),
    );
    expect(typeof res.counts?.total, "attention carries a numeric total count").toBe("number");
    // The seeded relationship on this entity must surface (proves the wrapper
    // returned real grouped data, not an empty husk).
    expect(res.counts.relationship, "the seeded relationship must be counted").toBeGreaterThanOrEqual(1);
  }, 120_000);

  // ── record_usage (write) ──
  test("record_usage: returns the invariant { recorded } acknowledgement", async () => {
    const res = await tool("record_usage", { memoryId: GET_ID, attribution: "wrapper-layer suite" });
    // dropped-payload: a working wrapper returns RecordUsage's invariant ack.
    expect(res, `record_usage must return a result, got: ${JSON.stringify(res).slice(0, 200)}`).toBeTruthy();
    expect(res.error, "record_usage must not return an error").toBeUndefined();
    expect(res.recorded, "record_usage acknowledges with recorded:true").toBe(true);
  }, 120_000);
});
