// ─── N agents, in-process, no CLI — proven against a real two-component Harper ─
//
// The consumer this exists for: a Harper application deployed to Fabric that
// loads Flair as a sub-component and calls it IN-PROCESS. There is no shell on
// that node, so every step here — registering agents, minting their key
// material, writing and reading as each of them — has to be reachable from
// application code alone.
//
// Every other in-process test in this repo runs against `mock.module("harper",
// …)`, which cannot catch the two things that actually break an embedding: the
// resource registry lookup across components, and Harper's collection binding
// (see resources/in-process.ts). So this test boots a REAL second Harper
// application (test/fixtures/inproc-app) with the worktree symlinked in as
// `node_modules/@tpsdev-ai/flair`, and drives the fixture's in-process code via
// its own HTTP endpoint. The HTTP hop is the TEST's remote control; the Flair
// calls it triggers are all in-process method calls.
//
// The load-bearing assertion is the scoping proof: two agents registered by the
// app, each writing a private and a shared memory, and NEITHER able to read the
// other's private one. An integration where every agent is silently admin is
// worse than no integration — so the admin-equivalence of a context-LESS call
// is pinned here too, as a property, not a comment.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync, createPrivateKey, sign as cryptoSign, randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;

const sfx = Date.now().toString(36);
const ALPHA = `inproc-alpha-${sfx}`;
const BRAVO = `inproc-bravo-${sfx}`;

/**
 * An Ed25519 keypair minted with nothing but `node:crypto` — the point being
 * that an app needs no CLI and no keystore to produce usable agent key
 * material. The private key never leaves this process; only the raw 32-byte
 * public key is handed to Flair.
 */
function mintKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    publicKeyB64: Buffer.from(rawPublic).toString("base64"),
    privateKey: createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" }) as string),
  };
}

const alphaKeys = mintKeypair();
const bravoKeys = mintKeypair();

/** The TPS-Ed25519 header an agent presents over HTTP (resources/agent-auth.ts). */
function ed25519Header(agentId: string, privateKey: ReturnType<typeof createPrivateKey>, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = cryptoSign(null, Buffer.from(payload, "utf8"), privateKey);
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig.toString("base64")}`;
}

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

/** Read a record straight out of storage, bypassing every resource-level gate. */
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

const contents = (rows: any[]) => rows.map((r) => r.content).sort();

beforeAll(async () => {
  // Materialise the fixture app: its own config.yaml + resource, plus the
  // worktree symlinked in as the Flair component. componentLoader.ts resolves a
  // sub-component from `node_modules/<name>` walking up from the app directory,
  // so this symlink is what makes `'@tpsdev-ai/flair'` in the fixture's
  // config.yaml load THIS build.
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-app-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");

  // cwd = the APP (Harper's `dev "."` target); harperBinDir = the worktree,
  // which is where node_modules/harper lives.
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
}, 300_000);

afterAll(async () => {
  // The restart test below hands `startHarper` an installDir it did not create,
  // so that instance never owns it — clean it up here regardless of which
  // instance is current.
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("in-process embedding — Flair loaded as a sub-component of another app", () => {
  test("the app resolves Flair's RESOURCES (not just its tables) from the shared registry", async () => {
    const { ok, value, error } = await fleet("registered");
    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    // The app's own resource and Flair's are in one process-global registry.
    expect(value).toContain("AgentFleet");
    expect(value).toContain("Memory");
    expect(value).toContain("Agent");
    expect(value).toContain("SemanticSearch");
  });
});

describe("registering N agents with no CLI", () => {
  test("the app registers two agents in-process, with key material it minted itself", async () => {
    const a = await fleet("register", { id: ALPHA, publicKey: alphaKeys.publicKeyB64 });
    const b = await fleet("register", { id: BRAVO, publicKey: bravoKeys.publicKeyB64 });
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  test("each record lands with the FULL Principal shape, not a hand-copied subset", async () => {
    for (const [id, keys] of [[ALPHA, alphaKeys], [BRAVO, bravoKeys]] as const) {
      const [record] = await adminSearch("Agent", "id", id);
      expect(record, `Agent ${id} was not persisted`).toBeDefined();
      // Defaults applied by resources/Agent.ts's post() — the reason to go
      // through the resource rather than write databases.flair.Agent directly.
      expect(record.kind).toBe("agent");
      expect(record.status).toBe("active");
      expect(record.displayName).toBe(id);
      expect(record.admin).toBe(false);
      expect(record.defaultTrustTier).toBe("unverified");
      expect(record.type).toBe("agent");
      expect(record.createdAt).toBeTruthy();
      // The key the app minted, stored verbatim.
      expect(record.publicKey).toBe(keys.publicKeyB64);
    }
  });

  test("an agent registered in-process can then authenticate over HTTP with that key", async () => {
    // Closes the loop: no CLI touched the keystore, yet the identity is a real
    // one the Ed25519 gate accepts — so the same agent works for remote callers.
    const path = `/Memory/?agentId=${ALPHA}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(ALPHA, alphaKeys.privateKey, "GET", path) },
    });
    expect(res.status).toBe(200);
  });

  test("a forged signature for the same agent is still rejected", async () => {
    // Mutation guard on the test above: a 200 there must mean the SIGNATURE
    // verified, not that the path is open to anyone naming a real agent.
    const path = `/Memory/?agentId=${ALPHA}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(ALPHA, bravoKeys.privateKey, "GET", path) },
    });
    expect(res.status).not.toBe(200);
  });
});

describe("acting as each agent, in-process", () => {
  test("each agent writes its own private and shared memories", async () => {
    for (const id of [ALPHA, BRAVO]) {
      const priv = await fleet("remember", { agentId: id, content: `${id} PRIVATE`, durability: "standard", visibility: "private" });
      const shared = await fleet("remember", { agentId: id, content: `${id} SHARED`, durability: "persistent", visibility: "shared" });
      expect(priv.error, `private write for ${id}`).toBeUndefined();
      expect(shared.error, `shared write for ${id}`).toBeUndefined();
      expect(priv.ok).toBe(true);
      expect(shared.ok).toBe(true);
    }
  });

  test("writes are attributed to the acting agent in storage", async () => {
    const rows = await adminSearch("Memory", "agentId", ALPHA);
    expect(contents(rows)).toEqual([`${ALPHA} PRIVATE`, `${ALPHA} SHARED`]);
  });

  test("an agent CANNOT write a memory owned by another agent", async () => {
    // Acting as ALPHA, claiming BRAVO owns the record. The context is the
    // authority; the body is not.
    const forged = await fleet("remember", { agentId: ALPHA, ownerAgentId: BRAVO, content: "forged by alpha" });
    expect(forged.ok).toBe(false);
    expect(forged.status).toBe(403);
    expect(forged.body).toContain("cannot write memory owned by another agent");

    // …and nothing landed under BRAVO.
    const bravoRows = await adminSearch("Memory", "agentId", BRAVO);
    expect(contents(bravoRows)).not.toContain("forged by alpha");
  });
});

describe("SCOPING PROOF — agent A cannot read agent B's private memories", () => {
  test("ALPHA sees its own private + both shared, and NOT BRAVO's private", async () => {
    const { ok, value, error } = await fleet("recall", { agentId: ALPHA });
    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    const seen = contents(value);
    expect(seen).toContain(`${ALPHA} PRIVATE`);
    expect(seen).toContain(`${ALPHA} SHARED`);
    expect(seen).toContain(`${BRAVO} SHARED`);
    expect(seen).not.toContain(`${BRAVO} PRIVATE`);
    // Nothing marked private by anyone else leaked in, whatever else is here.
    expect(value.filter((r: any) => r.visibility === "private" && r.agentId !== ALPHA)).toEqual([]);
  });

  test("BRAVO sees its own private + both shared, and NOT ALPHA's private", async () => {
    const { ok, value, error } = await fleet("recall", { agentId: BRAVO });
    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    const seen = contents(value);
    expect(seen).toContain(`${BRAVO} PRIVATE`);
    expect(seen).toContain(`${BRAVO} SHARED`);
    expect(seen).toContain(`${ALPHA} SHARED`);
    expect(seen).not.toContain(`${ALPHA} PRIVATE`);
    expect(value.filter((r: any) => r.visibility === "private" && r.agentId !== BRAVO)).toEqual([]);
  });

  test("SEMANTIC recall is scoped too — the path an agent loop actually reads through", async () => {
    // The one that matters most: the vector index is global, so the scope has to
    // survive being applied to ranked results rather than to a table query. Each
    // agent's private memory carries a distinctive topic the other never wrote
    // about, so a leak would surface as a top hit rather than as a near-miss.
    const alphaTopic = "quarterly billing reconciliation ledger";
    const bravoTopic = "deploy key rotation schedule";
    expect((await fleet("remember", { agentId: ALPHA, content: `${ALPHA} owns the ${alphaTopic}`, visibility: "private" })).ok).toBe(true);
    expect((await fleet("remember", { agentId: BRAVO, content: `${BRAVO} owns the ${bravoTopic}`, visibility: "private" })).ok).toBe(true);

    // Embeddings must actually have run, or this test proves nothing.
    const alphaRows = await adminSearch("Memory", "agentId", ALPHA);
    const embedded = alphaRows.find((r) => String(r.content).includes(alphaTopic));
    expect(Array.isArray(embedded?.embedding) && embedded.embedding.length > 0).toBe(true);

    // BRAVO searching for ALPHA's topic must not reach ALPHA's private record.
    const bravoHits = await fleet("semanticRecall", { agentId: BRAVO, q: alphaTopic });
    expect(bravoHits.ok).toBe(true);
    expect(bravoHits.value.map((r: any) => r.content).join(" ")).not.toContain(`${ALPHA} owns the`);
    expect(bravoHits.value.filter((r: any) => r.agentId === ALPHA && r.visibility === "private")).toEqual([]);

    // …and symmetrically.
    const alphaHits = await fleet("semanticRecall", { agentId: ALPHA, q: bravoTopic });
    expect(alphaHits.ok).toBe(true);
    expect(alphaHits.value.filter((r: any) => r.agentId === BRAVO && r.visibility === "private")).toEqual([]);

    // Control: the owner CAN reach its own record, so the assertions above are
    // not passing merely because semantic search returned nothing at all.
    const ownHits = await fleet("semanticRecall", { agentId: ALPHA, q: alphaTopic });
    expect(ownHits.value.map((r: any) => r.content).join(" ")).toContain(`${ALPHA} owns the`);
  }, 120_000);

  test("a by-id read of another agent's private record returns nothing", async () => {
    const [bravoPrivate] = (await adminSearch("Memory", "agentId", BRAVO)).filter((r) => r.visibility === "private");
    expect(bravoPrivate, "BRAVO's private record should exist in storage").toBeDefined();

    // BRAVO can read it…
    const owner = await fleet("recallById", { agentId: BRAVO, id: bravoPrivate.id });
    expect(owner.ok).toBe(true);
    expect(owner.value?.content).toBe(`${BRAVO} PRIVATE`);

    // …ALPHA, holding the exact id, cannot.
    const other = await fleet("recallById", { agentId: ALPHA, id: bravoPrivate.id });
    expect(other.value ?? null).toBeNull();
  });
});

// ─── The context object is a security boundary ───────────────────────────────
//
// The other half of the scoping proof. Showing that ALPHA cannot read BRAVO's
// private memories is necessary but not sufficient: the honest answer to "what
// if the app CLAIMS to be BRAVO?" is that it works, immediately and silently.
// In-process identity is ASSERTED, not verified — there is no signature, no
// lookup against the Agent table, and no registration requirement.
//
// That is correct design (a co-located caller could write the raw table anyway,
// so demanding a signature from same-process code would be theatre), and it is
// exactly why the context must be built from the app's own server-side state
// and never from request data. Both escalation paths — by omission and by
// assertion — are pinned here as properties, so neither can change quietly and
// neither can be mistaken for something Flair will catch for you.
describe("SECURITY BOUNDARY — in-process identity is asserted, not verified", () => {
  test("BY ASSERTION: claiming another agent's id simply works — it reads that agent's private memories", async () => {
    const { ok, value } = await fleet("recall", { agentId: BRAVO });
    expect(ok).toBe(true);
    // The caller never proved it is BRAVO. Nothing asked it to.
    expect(contents(value)).toContain(`${BRAVO} PRIVATE`);
  });

  test("BY ASSERTION: an id with NO Agent record acts as that agent anyway (registration is not a gate)", async () => {
    const ghost = `never-registered-${sfx}`;
    expect(await adminSearch("Agent", "id", ghost)).toEqual([]);

    const written = await fleet("remember", { agentId: ghost, content: `${ghost} GHOST`, visibility: "private" });
    expect(written.ok).toBe(true);

    const [row] = await adminSearch("Memory", "agentId", ghost);
    expect(row?.content).toBe(`${ghost} GHOST`);

    // …and it is scoped like any other agent: it cannot see ALPHA's private one.
    const { value } = await fleet("recall", { agentId: ghost });
    expect(contents(value)).not.toContain(`${ALPHA} PRIVATE`);
  });

  test("BY ASSERTION: tpsAgentIsAdmin is asserted too — it grants unfiltered reads and cross-agent writes", async () => {
    // Nothing checks that ALPHA is actually an admin; the flag is taken at face
    // value. This is why `isAdmin` must never be derived from caller input.
    const [record] = await adminSearch("Agent", "id", ALPHA);
    expect(record.admin).toBe(false); // ALPHA is NOT an admin principal…

    const seen = contents((await fleet("recall", { agentId: ALPHA, asAdmin: true })).value);
    expect(seen).toContain(`${BRAVO} PRIVATE`); // …yet it reads BRAVO's private record

    const forged = await fleet("remember", { agentId: ALPHA, ownerAgentId: BRAVO, content: "admin-forged", asAdmin: true });
    expect(forged.ok).toBe(true); // …and writes a record owned by BRAVO
    expect(contents(await adminSearch("Memory", "agentId", BRAVO))).toContain("admin-forged");
  });

  test("BY OMISSION: a context-LESS SEMANTIC search is unfiltered too", async () => {
    // The scary box in the guide claims this. It is true on both read paths.
    const { ok, value } = await fleet("semanticRecallUnscoped", { q: "quarterly billing reconciliation ledger" });
    expect(ok).toBe(true);
    const owners = new Set(value.map((r: any) => r.agentId));
    expect(value.some((r: any) => r.visibility === "private")).toBe(true);
    expect(owners.size).toBeGreaterThan(1);
  }, 120_000);

  test("BY OMISSION: a context-LESS call is ADMIN-EQUIVALENT — it reads every agent's private records", async () => {
    // The same escalation from the other end. If Flair's `internal` verdict ever
    // stops being unfiltered, this test fails and the guidance changes with it;
    // while it passes, it is the reason an embedding app must never let an agent
    // id default.
    const { ok, value } = await fleet("recallUnscoped");
    expect(ok).toBe(true);
    const seen = contents(value);
    expect(seen).toContain(`${ALPHA} PRIVATE`);
    expect(seen).toContain(`${BRAVO} PRIVATE`);
  });
});

// ─── What survives a process boundary (the cluster question) ─────────────────
//
// A distributed app depends on attribution being a property of the RECORD, not
// of the process that wrote it: Harper replicates every table in a replicated
// database unless it opts out with `@table(replicate: false)`, and none of
// Flair's do — so a memory written on node A lands on node B, and must read
// back there correctly attributed AND correctly scoped.
//
// This harness runs one node, so what is proven here is the load-bearing half:
// a SECOND Harper process, started fresh against the same storage with no
// memory of the first, resolves the same identities and the same boundaries
// from stored state alone. Nothing about who an agent is, or what it may see,
// lives in the process that wrote the record. What is NOT proven here is
// Harper's replication transport itself.
describe("attribution and scoping are storage state, not process state", () => {
  test("a fresh Harper process over the same data resolves identical per-agent scope", async () => {
    await stopHarper(harper, { keepInstallDir: true });
    harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT, installDir: harper.installDir });

    const alphaSees = contents((await fleet("recall", { agentId: ALPHA })).value);
    expect(alphaSees).toContain(`${ALPHA} PRIVATE`);
    expect(alphaSees).toContain(`${BRAVO} SHARED`);
    expect(alphaSees).not.toContain(`${BRAVO} PRIVATE`);

    const bravoSees = contents((await fleet("recall", { agentId: BRAVO })).value);
    expect(bravoSees).toContain(`${BRAVO} PRIVATE`);
    expect(bravoSees).toContain(`${ALPHA} SHARED`);
    expect(bravoSees).not.toContain(`${ALPHA} PRIVATE`);

    // The registry survives too — the agents this app registered are still
    // Principals, with the key material it minted.
    const [alphaRecord] = await adminSearch("Agent", "id", ALPHA);
    expect(alphaRecord.publicKey).toBe(alphaKeys.publicKeyB64);
    expect(alphaRecord.kind).toBe("agent");
  }, 300_000);
});
