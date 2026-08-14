// ─── flair#1181 — by-id reads must use the STATIC Cls.get/delete, proven live ─
//
// The bug: the /mcp connector's `memory_get` / `memory_update` / `soul_get` /
// `memory_delete` reached the datastore with an INSTANCE by-id read —
// `new Cls(undefined, ctx).get(<string id>)`. Harper routes `.get(<string>)` on
// an UNLOADED instance (tables leave `loadAsInstance` at its `undefined`
// default) to `getProperty()` — a field accessor that returns `undefined` — so
// the row never loads and `makeByIdReadGate`'s `!record` branch 404s the
// caller's OWN record, one call after a successful store. `memory_store` and
// `memory_search` worked because they use the static/collection paths; the
// Ed25519 REST route worked because it uses Harper's static `Resource.get`.
//
// The fix migrates the by-id reads to the static `Cls.get(id, context)` form —
// the SAME transactional path the REST route takes: it loads the row and hands
// the override a `RequestTarget` (never a bare string), so the `getProperty`
// dead end never fires, while STILL dispatching through the flair get()
// override → makeByIdReadGate → resolveReadScope. Scope is unchanged.
//
// Why an integration test (the unit test that shipped the bug mocked it away):
// `test/unit/mcp-handler.test.ts` injects capture-doubles whose `get()` returned
// canned data, so the real instance-vs-static Harper load was never exercised.
// This test drives the REAL Memory resource + real makeByIdReadGate through the
// inproc-app fixture (the same harness in-process-agents.test.ts uses), so the
// load path is the real one. The fixture ops mirror resources/mcp-tools.ts's
// exact patterns: `recallById` = the fixed static read, `recallByIdInstance` =
// the pre-fix instance read (the bug), `recallByIdTrust` = the includeTrust
// threading, `deleteById`/`updateById` = the delete/update round-trips.
//
// The load-bearing assertions:
//   1. POSITIVE — the caller reads its OWN record by id (static): the record.
//   2. BUG/MUTATION — the same id via the INSTANCE pattern: null (404). This is
//      the pre-fix code, executed live, side-by-side with the fix.
//   3. NEGATIVE/SECURITY — a DIFFERENT agent's PRIVATE record by id (static):
//      null. Own-records-only is preserved; the fix does not widen scope.
//   4. includeTrust survives the static migration.
//   5. delete + update round-trip end-to-end (the write legs left as-is work).
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
const CALLER = `byid-caller-${sfx}`;
const OTHER = `byid-other-${sfx}`;

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

/** Read a record straight out of storage, past every resource-level gate. */
async function adminSearch(table: string, attribute: string, value: string): Promise<any[]> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({
      operation: "search_by_value",
      database: "flair",
      table,
      search_attribute: attribute,
      search_value: value,
      get_attributes: ["*"],
    }),
  });
  const body = await res.json().catch(() => []);
  return Array.isArray(body) ? body : [];
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-byid-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

  await fleet("register", { id: CALLER });
  await fleet("register", { id: OTHER });
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("flair#1181 — by-id read uses the static Cls.get (loads the row, fires the gate)", () => {
  test("POSITIVE + MUTATION: the caller reads its OWN record by id via STATIC get; the pre-fix INSTANCE read returns null", async () => {
    const marker = `${CALLER} OWN ${randomUUID()}`;
    const written = await fleet("remember", { agentId: CALLER, content: marker, visibility: "private" });
    expect(written.ok).toBe(true);
    const id = written.value?.id;
    expect(typeof id, "the write must hand back the id it minted").toBe("string");

    // Ground truth: this id really is the caller's own record.
    const [stored] = await adminSearch("Memory", "id", id);
    expect(stored?.agentId).toBe(CALLER);
    expect(stored?.content).toBe(marker);

    // FIX (static): the owner reads its own record. Pre-fix this was the 404.
    const viaStatic = await fleet("recallById", { agentId: CALLER, id });
    expect(viaStatic.ok).toBe(true);
    expect(viaStatic.value?.id).toBe(id);
    expect(viaStatic.value?.content).toBe(marker);

    // BUG (instance): the SAME owner + SAME id, via the pre-fix instance
    // pattern, reads as absent — the #1181 404-on-your-own-record, live. This
    // is the mutation proof, run side-by-side with the fix in one pass.
    const viaInstance = await fleet("recallByIdInstance", { agentId: CALLER, id });
    expect(viaInstance.ok).toBe(true);
    expect(viaInstance.value ?? null, "the pre-fix INSTANCE by-id read must return null on the caller's OWN record").toBeNull();
  }, 120_000);

  test("NEGATIVE/SECURITY: a DIFFERENT agent's PRIVATE record still returns null by id — own-only preserved, scope not widened", async () => {
    const marker = `${OTHER} PRIVATE ${randomUUID()}`;
    const written = await fleet("remember", { agentId: OTHER, content: marker, visibility: "private" });
    expect(written.ok).toBe(true);
    const id = written.value?.id;
    expect(typeof id).toBe("string");

    // Ground truth: OTHER owns it, it is private.
    const [stored] = await adminSearch("Memory", "id", id);
    expect(stored?.agentId).toBe(OTHER);
    expect(stored?.visibility).toBe("private");

    // OWNER control: OTHER can read it — so a null below is a scope denial, not
    // a record that is unreadable to everyone.
    const owner = await fleet("recallById", { agentId: OTHER, id });
    expect(owner.value?.id).toBe(id);

    // SECURITY: CALLER, holding OTHER's exact private id, still gets null. The
    // static migration made a fail-CLOSED read LOAD the row; the ownership gate
    // then denies it exactly as before. THIS is the invariant the fix must not
    // break.
    const cross = await fleet("recallById", { agentId: CALLER, id });
    expect(cross.ok).toBe(true);
    expect(cross.value ?? null, "CALLER must NOT read OTHER's private record").toBeNull();
  }, 120_000);

  test("includeTrust survives the static migration — folded into the RequestTarget, the trust block attaches", async () => {
    const marker = `${CALLER} TRUST ${randomUUID()}`;
    const written = await fleet("remember", { agentId: CALLER, content: marker, visibility: "private" });
    const id = written.value?.id;

    const trusted = await fleet("recallByIdTrust", { agentId: CALLER, id });
    expect(trusted.ok).toBe(true);
    expect(trusted.value?.id).toBe(id);
    expect(trusted.value?.hasTrust, "a by-id get with includeTrust must return the trust block").toBe(true);
    // The trust block is a real object attached by Memory.get()'s attachTrust,
    // carrying at least the author + provenance-status fields (buildTrustBlock).
    expect(trusted.value?.trust?.provenanceStatus, JSON.stringify(trusted.value?.trust)).toBeDefined();
    expect(trusted.value?.trust?.author).toBe(CALLER);
  }, 120_000);

  test("memory_delete round-trip: static delete removes the caller's own record", async () => {
    const marker = `${CALLER} DELETE ${randomUUID()}`;
    const written = await fleet("remember", { agentId: CALLER, content: marker, durability: "standard", visibility: "private" });
    const id = written.value?.id;
    expect(typeof id).toBe("string");

    const del = await fleet("deleteById", { agentId: CALLER, id });
    expect(del.ok).toBe(true);
    expect(del.value?.deleted, "the record must be gone after a static delete").toBe(true);
    expect(await adminSearch("Memory", "id", id)).toEqual([]);
  }, 120_000);

  test("memory_update round-trip: static existing-read + unchanged write leg merges new content", async () => {
    const marker = `${CALLER} UPDATE ${randomUUID()}`;
    const written = await fleet("remember", { agentId: CALLER, content: marker, durability: "standard", visibility: "private" });
    const id = written.value?.id;
    expect(typeof id).toBe("string");

    const newContent = `${marker} — EDITED`;
    const upd = await fleet("updateById", { agentId: CALLER, id, content: newContent });
    expect(upd.ok, `updateById failed: ${JSON.stringify(upd)}`).toBe(true);
    expect(upd.value?.updated, "memory_update must round-trip end-to-end with only the read migrated").toBe(true);
    expect(upd.value?.content).toBe(newContent);
  }, 120_000);
});
