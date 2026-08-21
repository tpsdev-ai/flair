// ─── flair#1280 — OAuth connector principal mapping: the two-identity test ────
//
// Design ruling (issue #1280, Kern-approved): DISTINCT identities are a
// feature; the defect is that ACCIDENTAL distinctness is silent. A connector's
// token `sub` resolves through `Credential(kind:"idp", idpSubject=sub)` →
// `principalId`, and nothing constrains that Agent to be the operator's CLI
// identity. When they differ, every read over the connector is *correctly*
// scoped to an agent that owns nothing — "my memory is empty" with no error
// anywhere. The remedy is legibility (bootstrap self-describes; docs state the
// mapping + the LINK opt-in), not same-principal defaulting magic.
//
// THE FIXTURE GAP THIS CLOSES (the #1181-investigation finding): no test
// anywhere drove the real `resolveAgentFromSub` against real Harper with TWO
// identities. Every integration suite hands tools a hand-built
// `{ agentId, isAdmin }` (bypassing Credential resolution entirely), and the
// one faithful OAuth-principal fixture (test/unit/mcp-handler.test.ts) only
// ever runs against mocked handler doubles. This suite drives the SHIPPED
// `mcpHandler` — `request.mcp = { sub }`, the post-`withMCPAuth` shape — via
// the inproc-app fixture's `mcpRpc` op, so the real Credential lookup, the
// real tool wrappers, and the real read-scope gates all run against a real
// store. (The only production layer out of the loop is `withMCPAuth`'s RS256
// JWT verification itself, which has its own coverage.)
//
// The identities:
//   AGENT_A — the "operator's CLI" identity. Writes an org-non-private row and
//             a private row directly (the fixture's in-process seam).
//   AGENT_B — the connector's own, deliberately distinct identity. The token
//             sub is provisioned to B through the REAL supported flow —
//             `provisionIdpIdentityMapping` (src/lib/mcp-enable.ts), the exact
//             function `flair mcp enable`'s identity-mapping step calls.
//
// The contract pinned (per the ruling, distinct-by-default formalized):
//   (a) sub-resolved B sees A's org-non-private rows and NEVER A's private
//       rows (search), with in-band positive controls so the never-sees
//       assertions are proven able to fire;
//   (b) B's bootstrap SELF-DESCRIBES as B (agentId + scope fields) — the
//       first diagnostic for "why is my connector memory empty";
//   (c) by-id GET on A's private row is 404 (the #1264 404-never-403 posture),
//       while A's non-private row IS by-id readable cross-principal (control);
//   (d) LINKING — the documented same-identity opt-in: re-running
//       provisionIdpIdentityMapping with the SAME (provider, subject) and
//       principal=A re-points the SAME Credential row (no duplicate; resolution
//       stays deterministic), after which the connector sees exactly what A
//       sees — including NO LONGER seeing B's private rows (the link replaces
//       the mapping, it does not union identities).
//
// MUTATION PROOF (fixture can express leakage): flip PRIVATE_VISIBILITY below
// to "shared" and the never-sees-private assertions in (a)/(c) FAIL — the
// shared-row positive controls run the identical query/read shapes, so a leak
// is observable by construction, not vacuously absent.
//
// Ordering: bun runs tests in declaration order; (d) re-points the credential,
// so every sub→B assertion deliberately precedes it.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable.ts";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;
let opsPort: number;

const sfx = Date.now().toString(36);
const AGENT_A = `pm-cli-a-${sfx}`; // the operator's CLI identity
const AGENT_B = `pm-conn-b-${sfx}`; // the connector's distinct identity
const SUB = `pm-idp-sub-${sfx}`; // the IdP subject the token carries
const PROVIDER = "github"; // same provider on provision AND link (see docs note)

// Single rare tokens so the BM25 lane surfaces them even keyword-only
// (pattern: mcp-wrapper-layer-suite's SEARCH_TOKEN).
const SHARED_MARKER = `pmshared${sfx}`;
const PRIVATE_MARKER = `pmprivate${sfx}`;
const B_MARKER = `pmconnown${sfx}`;

// MUTATION KNOB — set to "shared" and the never-sees-private assertions below
// MUST fail (verified at authoring time); restore to "private".
const PRIVATE_VISIBILITY = "private";

let sharedId: string; // A's org-non-private row
let privateId: string; // A's private row
let bPrivateId: string; // B's own private row, written OVER THE CONNECTOR
let firstCredentialId: string;

/** Drive one in-process fixture op (POST /AgentFleet). */
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

/**
 * One JSON-RPC tools/call through the REAL mcpHandler, as the given sub.
 * Returns the parsed JSON-RPC response object.
 */
async function mcpCall(sub: string, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const out = await fleet("mcpRpc", {
    sub,
    rpc: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
  });
  expect(out.ok, `mcpRpc transport failed: ${JSON.stringify(out).slice(0, 400)}`).toBe(true);
  return out.value.rpc;
}

/** The tool payload (structuredContent) of a NON-error tools/call, asserted so. */
async function mcpTool(sub: string, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const rpc = await mcpCall(sub, tool, args);
  expect(rpc?.error, `tools/call ${tool} returned a JSON-RPC error: ${JSON.stringify(rpc?.error)}`).toBeUndefined();
  return rpc.result?.structuredContent;
}

/** Read records straight out of storage, past every resource-level gate. */
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
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-principal-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });
  opsPort = Number(new URL(harper.opsURL).port);

  // Two REGISTERED identities — full Principal shape via the Agent resource.
  await fleet("register", { id: AGENT_A });
  await fleet("register", { id: AGENT_B });

  // Provision sub → B through the REAL supported flow (the same call `flair
  // mcp enable --principal <id> --idp-subject <sub>` makes on its
  // identity-mapping step), against the REAL ops API.
  const mapping = await provisionIdpIdentityMapping({
    opsPortOrUrl: opsPort,
    adminUser: harper.admin.username,
    adminPass: harper.admin.password,
    principal: AGENT_B,
    principalKind: "agent",
    idpProvider: PROVIDER,
    idpSubject: SUB,
  });
  // The flow ATTACHED to the existing B — it did not mint a shadow principal.
  expect(mapping.principalCreated).toBe(false);
  expect(mapping.credentialReused).toBe(false);
  firstCredentialId = mapping.credentialId;

  // A's two rows, written directly (the operator's own seam).
  const shared = await fleet("remember", { agentId: AGENT_A, content: `org-visible note ${SHARED_MARKER}`, visibility: "shared" });
  expect(shared.ok).toBe(true);
  sharedId = shared.value?.id;
  const priv = await fleet("remember", { agentId: AGENT_A, content: `owner-only note ${PRIVATE_MARKER}`, visibility: PRIVATE_VISIBILITY });
  expect(priv.ok).toBe(true);
  privateId = priv.value?.id;
  expect(typeof sharedId).toBe("string");
  expect(typeof privateId).toBe("string");
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("flair#1280 — connector principal mapping (distinct-by-default, formalized)", () => {
  test("GROUND TRUTH: the seeded Credential + Memory rows are what the contract needs them to be", async () => {
    // Exactly ONE idp Credential maps the sub, and it points at B.
    const creds = (await adminSearch("Credential", "idpSubject", SUB)).filter((c) => c.kind === "idp");
    expect(creds.length).toBe(1);
    expect(creds[0].principalId).toBe(AGENT_B);
    expect(creds[0].status).toBe("active");

    // A's rows landed with the visibilities the assertions below key on. If
    // the MUTATION KNOB is flipped, this test fails FIRST, naming the fixture.
    const [storedShared] = await adminSearch("Memory", "id", sharedId);
    expect(storedShared?.agentId).toBe(AGENT_A);
    expect(storedShared?.visibility).toBe("shared");
    const [storedPriv] = await adminSearch("Memory", "id", privateId);
    expect(storedPriv?.agentId).toBe(AGENT_A);
    expect(storedPriv?.visibility).toBe("private");
  }, 120_000);

  test("an UNMAPPED sub is denied live (JIT default-OFF): no anonymous, no admin, no tool run", async () => {
    const rpc = await mcpCall(`pm-ghost-${sfx}`, "memory_search", { query: SHARED_MARKER, limit: 5 });
    expect(rpc.error?.message).toContain("not a provisioned flair agent");
  }, 120_000);

  test("the connector WRITES as the RESOLVED agent (B) — attribution comes from the Credential, never the payload", async () => {
    const echo = await mcpTool(SUB, "memory_store", {
      content: `connector-written owner-only note ${B_MARKER}`,
      visibility: "private",
      // A forged agentId in the arguments must be ignored (resolution wins).
      agentId: AGENT_A,
    });
    bPrivateId = echo?.id;
    expect(typeof bPrivateId, `memory_store echo missing id: ${JSON.stringify(echo)}`).toBe("string");
    const [stored] = await adminSearch("Memory", "id", bPrivateId);
    expect(stored?.agentId, "the connector write must be attributed to the sub-RESOLVED agent B").toBe(AGENT_B);
    expect(stored?.visibility).toBe("private");
  }, 120_000);

  test("(a) search as the connector: A's org-non-private row IS visible; A's private row NEVER is", async () => {
    // OWNER CONTROL — the private row is real, indexed and owner-readable, so
    // the absence below is a scope denial, not an indexing failure.
    const ownerView = await fleet("semanticRecall", { agentId: AGENT_A, q: PRIVATE_MARKER, limit: 20 });
    expect(ownerView.ok).toBe(true);
    expect(
      ownerView.value.some((r: any) => r.id === privateId),
      "A must find its own private row (owner control)",
    ).toBe(true);

    // POSITIVE (and the leak instrument's control): the IDENTICAL query shape
    // over the connector DOES surface A's org-non-private row cross-principal.
    const sharedHits = await mcpTool(SUB, "memory_search", { query: SHARED_MARKER, limit: 20 });
    expect(Array.isArray(sharedHits?.results), `memory_search must return results: ${JSON.stringify(sharedHits).slice(0, 300)}`).toBe(true);
    const sharedHit = sharedHits.results.find((r: any) => r.id === sharedId);
    expect(sharedHit, "the connector (B) must see A's org-non-private row").toBeDefined();
    expect(sharedHit.agentId).toBe(AGENT_A);

    // NEGATIVE: the same query shape aimed at the private marker returns
    // NOTHING of A's private row — not the id, not the content, not anywhere
    // in the serialized payload.
    const privateHits = await mcpTool(SUB, "memory_search", { query: PRIVATE_MARKER, limit: 20 });
    expect(Array.isArray(privateHits?.results)).toBe(true);
    expect(
      privateHits.results.some((r: any) => r.id === privateId),
      "the connector (B) must NEVER see A's private row",
    ).toBe(false);
    expect(JSON.stringify(privateHits)).not.toContain(PRIVATE_MARKER);
  }, 120_000);

  test("(b) bootstrap over the connector SELF-DESCRIBES as B — the first 'why is my memory empty' diagnostic", async () => {
    const boot = await mcpTool(SUB, "bootstrap", {});
    // Who does the server think I am? These fields are the answer (#1182).
    expect(boot?.agentId, "bootstrap must self-describe the RESOLVED agent").toBe(AGENT_B);
    expect(boot?.scope?.agentId).toBe(AGENT_B);
    expect(boot?.scope?.isAdmin).toBe(false);
    expect(typeof boot?.scope?.reads).toBe("string");
    expect(typeof boot?.flairVersion).toBe("string");

    const payload = JSON.stringify(boot);
    // PAYLOAD-SCAN CONTROL: the payload demonstrably carries memory content —
    // B's own connector-written row is in it…
    expect(payload, "B's own row must appear in B's bootstrap (scan control)").toContain(B_MARKER);
    // …so the absence of A's private content is a real exclusion, not an
    // empty payload passing vacuously.
    expect(payload, "A's private content must never appear in B's bootstrap").not.toContain(PRIVATE_MARKER);
  }, 120_000);

  test("(c) by-id GET as the connector: A's private row → 404 (#1264 posture); A's non-private row → readable (control)", async () => {
    // OWNER CONTROL: the row reads fine as its owner.
    const owner = await fleet("recallById", { agentId: AGENT_A, id: privateId });
    expect(owner.value?.id).toBe(privateId);

    // CONTROL for the read path: cross-principal by-id on a NON-private row
    // works — so the 404 below is the private exclusion, not a broken read.
    const sharedRead = await mcpTool(SUB, "memory_get", { id: sharedId });
    expect(sharedRead?.id).toBe(sharedId);
    expect(String(sharedRead?.content)).toContain(SHARED_MARKER);

    // THE ASSERTION: holding the exact private id gets 404, never 403, never
    // the record.
    const rpc = await mcpCall(SUB, "memory_get", { id: privateId });
    expect(rpc.result?.isError, `expected a tool error, got: ${JSON.stringify(rpc.result?.structuredContent).slice(0, 300)}`).toBe(true);
    expect(rpc.result?.structuredContent?.status).toBe(404);
    expect(JSON.stringify(rpc)).not.toContain(PRIVATE_MARKER);
  }, 120_000);

  test("(d) LINK — the supported opt-in: re-pointing the sub to A re-uses the SAME Credential and the connector now sees exactly what A sees", async () => {
    // The link is the SAME supported call, principal now A. Same provider +
    // subject ⇒ the existing Credential row is RE-POINTED, not duplicated.
    const mapping = await provisionIdpIdentityMapping({
      opsPortOrUrl: opsPort,
      adminUser: harper.admin.username,
      adminPass: harper.admin.password,
      principal: AGENT_A,
      principalKind: "agent",
      idpProvider: PROVIDER,
      idpSubject: SUB,
    });
    expect(mapping.principalCreated).toBe(false);
    expect(mapping.credentialReused, "the link must REUSE the existing (provider,subject) Credential").toBe(true);
    expect(mapping.credentialId).toBe(firstCredentialId);

    // Determinism: still exactly ONE idp Credential for this sub — a duplicate
    // would make resolveAgentFromSub's answer iteration-order-dependent.
    const creds = (await adminSearch("Credential", "idpSubject", SUB)).filter((c) => c.kind === "idp");
    expect(creds.length).toBe(1);
    expect(creds[0].principalId).toBe(AGENT_A);

    // Runtime legibility flips with the mapping: bootstrap now self-describes
    // as A.
    const boot = await mcpTool(SUB, "bootstrap", {});
    expect(boot?.agentId).toBe(AGENT_A);
    expect(boot?.scope?.agentId).toBe(AGENT_A);

    // The former 404 is now the owner's own read.
    const nowOwn = await mcpTool(SUB, "memory_get", { id: privateId });
    expect(nowOwn?.id).toBe(privateId);
    expect(String(nowOwn?.content)).toContain(PRIVATE_MARKER);

    // And search surfaces A's private row to the linked connector.
    const hits = await mcpTool(SUB, "memory_search", { query: PRIVATE_MARKER, limit: 20 });
    expect(hits.results.some((r: any) => r.id === privateId)).toBe(true);

    // The link REPLACES the mapping — it does not union identities. B's
    // private row (which the connector itself wrote three tests ago) is now
    // invisible to it. Owner control first: B still reads its own row.
    const bOwner = await fleet("recallById", { agentId: AGENT_B, id: bPrivateId });
    expect(bOwner.value?.id).toBe(bPrivateId);
    const bHits = await mcpTool(SUB, "memory_search", { query: B_MARKER, limit: 20 });
    expect(
      bHits.results.some((r: any) => r.id === bPrivateId),
      "after linking to A, the connector must NOT see B's private rows",
    ).toBe(false);

    // "Exactly what A sees", pinned per-row over the seeded universe: for each
    // row, connector-by-id visibility === A's direct by-id visibility.
    for (const [id, label] of [
      [sharedId, "A shared"],
      [privateId, "A private"],
      [bPrivateId, "B private"],
    ] as const) {
      const direct = await fleet("recallById", { agentId: AGENT_A, id });
      const aSees = direct.value?.id === id;
      const rpc = await mcpCall(SUB, "memory_get", { id });
      const connectorSees = rpc.result?.isError !== true && rpc.result?.structuredContent?.id === id;
      expect(connectorSees, `${label}: connector visibility (${connectorSees}) must equal A's direct visibility (${aSees})`).toBe(aSees);
    }
  }, 120_000);
});
