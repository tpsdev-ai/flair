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
//       the mapping, it does not union identities);
//   (e) flair#1317 — RE-LINKING UNDER A DIFFERENT PROVIDER SUPERSEDES. The
//       linking layer used to dedup on (kind, idpProvider, idpSubject) while
//       the resolver reads (kind, idpSubject), so a re-link under a new
//       provider name minted a SECOND active credential for the same subject
//       and resolution became iteration-order-dependent. K&S ruling: unify the
//       linking key on (kind, idpSubject); at most one ACTIVE credential per
//       subject regardless of provider; the prior credential is hard-revoked,
//       not duplicated;
//   (f) flair#1317 fail-closed — a REVOKED credential does not resolve AT ALL,
//       not merely "isn't returned first". This is the property that makes
//       (e)'s supersede a real revocation rather than a re-ordering.
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
// flair#1317: the SECOND provider name the same subject gets re-linked under.
// Under the pre-fix linking key this minted a duplicate active credential.
const OTHER_PROVIDER = "mcp-oauth"; // the JIT stamp — the real-world collision

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

/** Write records straight into storage, past every resource-level gate. */
async function adminUpsert(table: string, records: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ operation: "upsert", database: "flair", table, records }),
  });
  if (!res.ok) throw new Error(`admin upsert ${table} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
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

  // ─── flair#1317 — the credential-matching asymmetry ────────────────────────
  //
  // RED ON MAIN (this is the regression, not a restatement): on unmodified
  // main `provisionIdpIdentityMapping` dedups on (kind, idpProvider,
  // idpSubject), so re-linking SUB under OTHER_PROVIDER finds nothing to reuse
  // and INSERTS a second credential. Both are `status: "active"` and both match
  // the resolver's (kind, idpSubject) filter, so `resolveAgentFromSub` returns
  // whichever the search iterator serves first — identity resolution by
  // iteration order. The `active.length` assertion below reads 2 on main.
  test("(e) flair#1317 — re-linking the SAME subject under a DIFFERENT provider SUPERSEDES: one active credential, prior hard-revoked", async () => {
    // PRECONDITION (and the control that the fixture is in the state the
    // regression needs): after (d) there is exactly one active credential for
    // SUB and it points at A, under PROVIDER.
    const before = (await adminSearch("Credential", "idpSubject", SUB))
      .filter((c) => c.kind === "idp" && c.status !== "revoked");
    expect(before.length, "precondition: one active credential for SUB before the cross-provider re-link").toBe(1);
    expect(before[0].principalId).toBe(AGENT_A);
    expect(before[0].idpProvider).toBe(PROVIDER);

    // THE DEFECT'S TRIGGER: same subject, DIFFERENT provider name.
    const mapping = await provisionIdpIdentityMapping({
      opsPortOrUrl: opsPort,
      adminUser: harper.admin.username,
      adminPass: harper.admin.password,
      principal: AGENT_B,
      principalKind: "agent",
      idpProvider: OTHER_PROVIDER,
      idpSubject: SUB,
    });

    const creds = (await adminSearch("Credential", "idpSubject", SUB)).filter((c) => c.kind === "idp");
    const active = creds.filter((c) => c.status !== "revoked");

    // THE INVARIANT: at most one ACTIVE Credential per (kind, idpSubject),
    // regardless of provider — the constraint the resolver already assumes.
    expect(
      active.length,
      `at most one active credential per (kind, idpSubject) — got ${active.length}: ` +
        JSON.stringify(active.map((c) => ({ id: c.id, provider: c.idpProvider, principal: c.principalId, status: c.status }))),
    ).toBe(1);
    expect(active[0].principalId).toBe(AGENT_B);
    expect(active[0].idpProvider).toBe(OTHER_PROVIDER);
    expect(active[0].id).toBe(mapping.credentialId);

    // SUPERSEDE, not duplicate and not delete: the prior row is RETAINED (so
    // the revocation is recoverable from storage and from Harper's table audit
    // log, which records the full record image of every write) and carries the
    // TERMINAL "revoked" state — never a soft flag a later path could flip back.
    const prior = creds.find((c) => c.id === firstCredentialId);
    expect(prior, "the superseded credential row must be retained, not deleted").toBeDefined();
    expect(prior!.status, "the superseded credential must be hard-revoked").toBe("revoked");
    expect(prior!.principalId, "the superseded row keeps its prior principal for audit").toBe(AGENT_A);

    // OBSERVABILITY: the caller is told a credential DIED, by id. `flair mcp
    // enable`'s identity-mapping step reports this — an operator who re-links
    // under a new provider name must not discover the revocation later.
    expect(mapping.credentialSuperseded, "the result must report the supersede").toBe(true);
    expect(mapping.supersededCredentialIds).toContain(firstCredentialId);
    expect(mapping.credentialReused, "a cross-provider re-link is not a reuse").toBe(false);
    expect(mapping.credentialId).not.toBe(firstCredentialId);

    // DETERMINISM AT RUNTIME, repeated: with one active credential there is no
    // iteration order left to depend on. (Repetition is the instrument: a
    // two-active store can return the same answer once by luck.)
    for (let i = 0; i < 3; i++) {
      const boot = await mcpTool(SUB, "bootstrap", {});
      expect(boot?.agentId, `bootstrap must resolve to B on every call (call ${i + 1})`).toBe(AGENT_B);
      expect(boot?.scope?.agentId).toBe(AGENT_B);
    }

    // And the mapping really MOVED: A's private row — readable over the
    // connector at the end of (d) — is no longer reachable.
    const rpc = await mcpCall(SUB, "memory_get", { id: privateId });
    expect(rpc.result?.isError, "after the supersede the connector is B again: A's private row is 404").toBe(true);
    expect(rpc.result?.structuredContent?.status).toBe(404);
  }, 120_000);

  // Not a #1317 regression — #1317's supersede is only worth anything if
  // "revoked" is a real denial. This pins the resolver's fail-closed property
  // directly: the revoked credential is the ONLY credential for its subject, so
  // "not returned first" cannot mask a pass. (Green on main too, by design —
  // it is the security floor the supersede stands on.)
  test("(f) flair#1317 fail-closed — a REVOKED credential does not resolve AT ALL, even as its subject's only credential", async () => {
    const revokedSub = `pm-idp-revoked-${sfx}`;
    const mapping = await provisionIdpIdentityMapping({
      opsPortOrUrl: opsPort,
      adminUser: harper.admin.username,
      adminPass: harper.admin.password,
      principal: AGENT_B,
      principalKind: "agent",
      idpProvider: PROVIDER,
      idpSubject: revokedSub,
    });

    // POSITIVE CONTROL: while ACTIVE this sub resolves — so the denial below is
    // the revocation, not an unprovisioned subject or a broken fixture.
    const bootBefore = await mcpTool(revokedSub, "bootstrap", {});
    expect(bootBefore?.agentId, "control: the active credential resolves").toBe(AGENT_B);

    // The terminal state the supersede writes, applied directly.
    await adminUpsert("Credential", [{ id: mapping.credentialId, status: "revoked" }]);
    const [stored] = await adminSearch("Credential", "id", mapping.credentialId);
    expect(stored?.status, "fixture control: the credential really is revoked in storage").toBe("revoked");
    expect(stored?.principalId, "the row still names a real principal — so a resolver that ignored status WOULD resolve it").toBe(AGENT_B);

    // THE ASSERTION: denied outright. Not de-prioritised — unresolvable.
    const rpc = await mcpCall(revokedSub, "bootstrap", {});
    expect(rpc.error?.message, `a revoked credential must not resolve: ${JSON.stringify(rpc).slice(0, 300)}`)
      .toContain("not a provisioned flair agent");
  }, 120_000);
});
