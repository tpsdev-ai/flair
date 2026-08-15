// ─── flair#1182 (part 2) — the /mcp `bootstrap` wrapper must return the FULL ───
// payload, proven live against a real BootstrapMemories + real store.
//
// The bug: resources/mcp-tools.ts's `bootstrap` tool built its response as
// `{ ...unwrap(await h.post(body)), flairVersion }`. `unwrap` is an ASYNC
// function — every sibling tool spells it `await unwrap(...)` — but `bootstrap`
// dropped the `await`, so `result` was the unresolved PROMISE. Object-spreading
// a Promise copies NO own-enumerable keys (`{...aPromise}` === `{}`), so the
// entire rich payload BootstrapMemories.post computes — the resolved agentId,
// the scope descriptor, the soul map, the memories/predicted containers, and
// (the decisive tell) the opt-in abstention verdict — was silently discarded,
// and a caller over the /mcp connector saw ONLY the injected `flairVersion`.
//
// Why an integration test (and why through the fixture): the payload path lives
// in the REAL BootstrapMemories.post reading a REAL Soul + Memory out of the
// store, and the drop lives in the REAL resources/mcp-tools.ts wrapper. The
// inproc-app fixture's `bootstrapViaMcp` op imports the shipped `TOOLS.bootstrap`
// and invokes its `.impl` in-process against a live Harper, so the assertions —
// and the mutation proof (revert the `await` ⇒ these fail) — land on the shipped
// line, not on a mirror of it.
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
const AGENT = `boot1182-${sfx}`;
const SOUL_ROLE = `Bootstrap payload test subject ${sfx}`;
const PERM_MARKER = `boot1182 permanent marker: never delete the backup before an explicit go ${randomUUID()}`;

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

/** Insert a Soul record straight into storage (bootstrap reads it back by agentId). */
async function seedSoul(agentId: string, key: string, value: string): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Soul",
      records: [{ id: `${agentId}:${key}`, agentId, key, value, createdAt: new Date().toISOString() }],
    }),
  });
  expect(res.status, `Soul insert ${agentId}:${key} → ${res.status}`).toBe(200);
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-boot1182-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

  // Seed the caller: an Agent principal, a Soul entry, and one permanent memory.
  await fleet("register", { id: AGENT });
  await seedSoul(AGENT, "role", SOUL_ROLE);
  const written = await fleet("remember", { agentId: AGENT, content: PERM_MARKER, durability: "permanent", visibility: "private" });
  expect(written.ok, `seeding the memory failed: ${JSON.stringify(written)}`).toBe(true);
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("flair#1182 part 2 — /mcp bootstrap returns the full payload, not just flairVersion", () => {
  test("the real mcp-tools bootstrap wrapper returns agentId + scope + soul + the seeded memory (not a bare {flairVersion})", async () => {
    const res = await fleet("bootstrapViaMcp", {
      agentId: AGENT,
      args: { currentTask: "verifying the bootstrap payload", maxTokens: 8000, includeTrust: true },
    });
    expect(res.ok, `bootstrapViaMcp failed: ${JSON.stringify(res).slice(0, 400)}`).toBe(true);
    const body = res.value;

    // ── THE BUG, stated directly: the wrapper used to return ONLY this key. ──
    // If the await is dropped, `body` is exactly { flairVersion } and every
    // assertion below fails. This one names the regression outright.
    expect(
      Object.keys(body ?? {}).sort(),
      `bootstrap must return the rich payload, got keys: ${JSON.stringify(Object.keys(body ?? {}))}`,
    ).not.toEqual(["flairVersion"]);

    // ── resolved identity + scope descriptor (the #1182.1 self-describing keys) ──
    expect(body.agentId, "resolved agentId must be the caller's").toBe(AGENT);
    expect(body.scope?.agentId, "scope.agentId must be the caller's").toBe(AGENT);
    expect(body.scope?.isAdmin, "a non-admin caller resolves as non-admin").toBe(false);
    expect(typeof body.scope?.reads, "scope must describe the read model").toBe("string");

    // ── the soul map carries the seeded identity as structured data ──
    expect(body.soul, "soul container must be present").toBeDefined();
    expect(body.soul.role, "soul must carry the seeded role").toBe(SOUL_ROLE);

    // ── the memories container carries the caller's OWN seeded memory ──
    expect(Array.isArray(body.memories), "memories must be an array").toBe(true);
    const contents = body.memories.map((m: any) => m.content);
    expect(contents, "the seeded permanent memory must be in the payload").toContain(PERM_MARKER);
    for (const m of body.memories) {
      expect(m.agentId, "every returned memory is the caller's OWN").toBe(AGENT);
    }

    // ── the always-present containers + the version the wrapper injects ──
    expect(Array.isArray(body.predicted), "predicted container present").toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, "context"), "context still present").toBe(true);
    expect(typeof body.flairVersion, "flairVersion still injected by the wrapper").toBe("string");
  }, 120_000);

  test("abstain:true — the abstention verdict {abstained, bestScore, threshold} survives to the caller", async () => {
    const res = await fleet("bootstrapViaMcp", {
      agentId: AGENT,
      args: { currentTask: "verifying the abstention verdict", maxTokens: 8000, abstain: true },
    });
    expect(res.ok, `bootstrapViaMcp(abstain) failed: ${JSON.stringify(res).slice(0, 400)}`).toBe(true);
    const body = res.value;

    // The decisive tell: abstain returns a COMPUTED verdict that never touches
    // read-scope, so its presence proves the whole computed payload survived —
    // it could not have been "gated away" by scoping.
    expect(body.abstention, "abstain:true must return an abstention verdict").toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(body.abstention, "abstained"),
      "abstention verdict must carry `abstained`",
    ).toBe(true);
    expect(typeof body.abstention.abstained, "`abstained` is a boolean").toBe("boolean");
    expect(
      Object.prototype.hasOwnProperty.call(body.abstention, "bestScore"),
      "abstention verdict must carry `bestScore` (may be null)",
    ).toBe(true);
    expect(typeof body.abstention.threshold, "abstention verdict must carry a numeric `threshold`").toBe("number");
  }, 120_000);
});
