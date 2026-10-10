/**
 * principal-link.test.ts — `flair principal link` / `unlink` / `links`
 * (flair#2115): link maps one IdP login to a principal; unlink revokes a
 * mapping; links lists the principal's current mappings.
 *
 * The ops store is an in-memory stub
 * served by an injected fetch: every URL is asserted before it is served, and
 * no test makes a network call.
 *
 */
import { describe, test, expect } from "bun:test";
import { Command } from "commander";
import { agentInsertSchemaError } from "../helpers/agent-insert-schema.ts";
import { register } from "../../src/commands/principal.ts";
import {
  linkPrincipalMapping,
  unlinkPrincipalMapping,
  listPrincipalMappings,
  provisionIdpIdentityMapping,
} from "../../src/lib/mcp-enable.ts";

/** A public-shaped origin, as `flair mcp enable --instance` requires. */
const HOSTED = "https://flair.example.com";
/** The address `resolveOpsUrl` gives that origin: its host at the hosted ops port. */
const HOSTED_OPS = "https://flair.example.com:9925/";
/** The ops API's own origin, given as the numeric port form tests prefer. */
const LOCAL_PORT = 41234;
const LOCAL_OPS = "http://127.0.0.1:41234/";

const ADMIN = { adminUser: "admin", adminPass: "pw" };

type Call = { url: string; body: any };

/**
 * An in-memory Agent + Credential store behind an injected fetch.
 *
 * The stub asserts EVERY request URL against `expectedUrl` before it serves it:
 * the test fails on the first call that goes anywhere else, which is what makes
 * "every ops target is this stub" a measured claim rather than an assumption.
 */
function mappingStub(opts: {
  expectedUrl: string;
  principals?: string[];
  credentials?: Array<Record<string, any>>;
  /** Fail the first N reads (search_by_value / search_by_conditions). */
  failReads?: number;
  /** Fail every Agent read. */
  failAgentRead?: boolean;
  /** Fail every Credential read. */
  failCredRead?: boolean;
  /** Fail the Nth Credential read (1-based), the others answering normally. */
  failCredReadAt?: number;
  /** Answer the Nth Credential read (1-based) with 200 and a body that is NOT a list. */
  answerNotAListAt?: number;
  /** Answer the Agent read with a row whose id is NOT the requested principal. */
  mismatchAgentId?: boolean;
  /** Fail every write (insert / upsert / update). */
  failWrites?: boolean;
  updateResult?: unknown;
  updateIds?: string[];
  /** Answer reads with 200 and a body that is NOT a record list. */
  answerNotAList?: boolean;
  /** Answer every Credential read with 200 and this body. */
  credBody?: unknown;
  /** Answer the Nth Agent read (1-based) with 200 and `body`. */
  agentBodyAt?: { n: number; body: unknown };
}) {
  const principals = new Map<string, any>((opts.principals ?? ["alice"]).map((id) => [id, { id }]));
  const rows = new Map<string, any>(
    (opts.credentials ?? []).map((c) => [String(c.id), { kind: "idp", status: "active", createdAt: "2026-10-02T00:00:00.000Z", ...c }]),
  );
  const calls: Call[] = [];
  let readsLeft = opts.failReads ?? 0;
  let credReads = 0;
  let agentReads = 0;

  const write = (records: any[]) => {
    for (const rec of records) rows.set(String(rec.id), { ...(rows.get(String(rec.id)) ?? {}), ...rec });
  };

  const fetchImpl = (async (url: any, init?: any) => {
    const target = String(url);
    expect(target).toBe(opts.expectedUrl);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: target, body });
    if (body.operation === "search_by_value" && body.table === "Agent") {
      agentReads += 1;
      if (opts.failAgentRead || readsLeft-- > 0) return new Response("boom", { status: 500 });
      if (opts.answerNotAList) return Response.json({ ok: true });
      if (agentReads === opts.agentBodyAt?.n) return Response.json(opts.agentBodyAt.body);
      if (!principals.has(body.search_value)) return Response.json([]);
      return Response.json([{ id: opts.mismatchAgentId ? "someone-else" : body.search_value }]);
    }
    if (body.operation === "search_by_conditions" && body.table === "Credential") {
      credReads += 1;
      if (opts.failCredRead || readsLeft-- > 0 || credReads === opts.failCredReadAt) {
        return new Response("boom", { status: 500 });
      }
      if (opts.answerNotAList || credReads === opts.answerNotAListAt) return Response.json({ ok: true });
      if ("credBody" in opts) return Response.json(opts.credBody);
      const cond = (name: string) =>
        (body.conditions ?? []).find((c: any) => c.search_attribute === name)?.search_value;
      const kind = cond("kind");
      const subject = cond("idpSubject");
      const principalId = cond("principalId");
      const hits = [...rows.values()].filter(
        (r) =>
          (kind === undefined || r.kind === kind) &&
          (subject === undefined || r.idpSubject === subject) &&
          (principalId === undefined || r.principalId === principalId),
      );
      return Response.json(hits);
    }
    if (body.operation === "insert" && body.table === "Agent") {
      const error = agentInsertSchemaError(body.records ?? []);
      if (error) return error;
      if (opts.failWrites) return new Response("nope", { status: 500 });
      for (const row of body.records ?? []) principals.set(row.id, { ...row });
      return Response.json({ message: "inserted" });
    }
    if ((body.operation === "upsert" || body.operation === "update") && body.table === "Credential") {
      if (opts.failWrites) return new Response("nope", { status: 500 });
      const records = body.records ?? [];
      write(body.operation === "update" && opts.updateIds !== undefined
        ? records.filter((r: any) => opts.updateIds!.includes(r.id)) : records);
      return Response.json(body.operation === "update"
        ? ("updateResult" in opts ? opts.updateResult : { update_hashes: records.map((r: any) => r.id), skipped_hashes: [] })
        : { message: "upserted" });
    }
    if (body.operation === "sql") {
      // flair#2433 — the create path resolves the instance's own id from the
      // Instance table before it inserts the Agent row.
      return Response.json([{ id: "inst-local-2433" }]);
    }
    return Response.json({});
  }) as unknown as typeof fetch;

  const writes = () => calls.filter((c) => ["insert", "upsert", "update"].includes(c.body.operation));
  return { fetchImpl, calls, writes, rows, principals };
}

const SUBJECT = { idpSubject: "octocat", idpProvider: "github" };

for (const field of ["name", "publicKey", "createdAt"]) {
  test(`mapping fake rejects an Agent insert missing ${field}`, async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: [] });
    const record: Record<string, unknown> = {
      id: "self", name: "self", publicKey: "idp:github:octocat", createdAt: "2026-10-02T00:00:00.000Z",
    };
    delete record[field];
    const response = await st.fetchImpl(HOSTED_OPS, {
      method: "POST",
      body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [record] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `Property ${field} is required` });
    expect(st.principals.has("self")).toBe(false);
  });
}

describe("flair principal link (flair#2115)", () => {
  test("maps the subject and prints the mapping", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"] });
    const result = await linkPrincipalMapping(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
      { fetchImpl: st.fetchImpl, now: () => "2026-10-02T00:00:00.000Z" },
    );
    expect(result.action).toBe("linked");
    expect(result.principal).toBe("alice");
    expect(result.idpSubject).toBe("octocat");
    expect(result.lines).toEqual([
      `Linked: IdP subject 'octocat' (provider 'github') → principal 'alice' — Credential(kind:idp) created (${result.credentialId}).`,
    ]);
    // The mapping really landed, and it is the only active row for the subject.
    const active = [...st.rows.values()].filter((r) => r.status !== "revoked");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ principalId: "alice", idpProvider: "github", idpSubject: "octocat" });
    // An EXISTING principal is never created by this path.
    expect(st.calls.map((c) => c.body.operation)).not.toContain("insert");
  });

  test("refuses a missing principal by name and writes nothing", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: [] });
    const err = (await linkPrincipalMapping(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "ghost", ...SUBJECT },
      { fetchImpl: st.fetchImpl },
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("No principal 'ghost'");
    // The remedy names the TARGET instance: `flair principal add` writes to
    // THIS machine's own instance, and these commands target a remote one.
    expect(err.message).toContain("Create the principal on the TARGET instance");
    expect(err.message).not.toContain("flair principal add");
    expect(st.writes()).toEqual([]);
  });

  test("refuses a failed principal READ instead of creating the principal", async () => {
    // The Agent read fails: an unreadable Agent table is not an absent
    // principal, so the create path must not run.
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"], failAgentRead: true });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/ops API read at .* failed \(HTTP 500\)/);
    expect(st.writes()).toEqual([]);
  });

  test("refuses an orphaned credential that names a deleted principal, and writes nothing", async () => {
    // The subject's credential still names 'alice', but the Agent is gone. The
    // already-linked branch must not answer that with success.
    const st = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: [],
      credentials: [
        { id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "alice", status: "active" },
      ],
    });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/No principal 'alice'/);
    expect(st.writes()).toEqual([]);
  });

  test("refuses a missing principal whose subject is mapped elsewhere, by the missing-principal error", async () => {
    // The requested principal does not exist AND the subject is mapped to
    // someone else: the missing principal is what is wrong, and that is what is
    // reported (not the different-principal refusal, which --replace would not fix).
    const st = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: ["bob"],
      credentials: [
        { id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "bob", status: "active" },
      ],
    });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "ghost", ...SUBJECT },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/No principal 'ghost'/);
    expect(st.writes()).toEqual([]);
  });

  test("refuses an Agent answer whose row is not the requested principal", async () => {
    // The id is compared: a row that is not the principal is not the principal.
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"], mismatchAgentId: true });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/query-mismatch:id/);
    expect(st.writes()).toEqual([]);
  });

  test("refuses a subject mapped to a different principal, and moves it with replace", async () => {
    const row = { id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "bob", status: "active" };

    const refused = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice", "bob"], credentials: [row] });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: refused.fetchImpl },
      ),
    ).rejects.toThrow(/already mapped to principal 'bob'/);
    expect(refused.writes()).toEqual([]);

    const moved = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice", "bob"], credentials: [row] });
    const result = await linkPrincipalMapping(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT, replace: true },
      { fetchImpl: moved.fetchImpl, now: () => "2026-10-02T00:00:00.000Z" },
    );
    expect(result.action).toBe("replaced");
    expect(result.previousPrincipal).toBe("bob");
    expect(result.credentialId).toBe("cred_c1");
    expect(result.credentialReused).toBe(true);
    expect(result.lines).toEqual([
      "Re-linked: IdP subject 'octocat' (provider 'github') was mapped to principal 'bob'; now mapped to 'alice' " +
        "— Credential(kind:idp) re-pointed (cred_c1).",
    ]);
    expect([...moved.rows.values()].filter((r) => r.status !== "revoked")).toMatchObject([
      { id: "cred_c1", principalId: "alice" },
    ]);
  });

  test("prints a superseded credential exactly as mcp enable does", async () => {
    // A credential under ANOTHER provider, naming another principal: the write
    // re-points (new credential) and REVOKES this one.
    const st = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: ["alice", "carl"],
      credentials: [
        { id: "cred_c2", idpSubject: "octocat", idpProvider: "gitlab", principalId: "carl", status: "active" },
      ],
    });
    const result = await linkPrincipalMapping(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT, replace: true },
      { fetchImpl: st.fetchImpl, now: () => "2026-10-02T00:00:00.000Z" },
    );
    expect(result.supersededCredentialIds).toEqual(["cred_c2"]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain(
      " SUPERSEDED: 1 prior Credential(kind:idp) row(s) for this subject were REVOKED, not de-duplicated — cred_c2. " +
        "The revoked rows no longer resolve. Future calls for this subject use the surviving mapping. " +
        "Exactly one resolvable (principal-bearing) active credential remains per (kind, idpSubject). Principal-less legacy rows are skipped and may remain active.",
    );
    expect(st.rows.get("cred_c2")?.status).toBe("revoked");
  });

  test("reports an already-linked subject without writing", async () => {
    const st = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: ["alice"],
      credentials: [
        { id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "alice", status: "active" },
      ],
    });
    const result = await linkPrincipalMapping(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
      { fetchImpl: st.fetchImpl },
    );
    expect(result.action).toBe("already-linked");
    expect(result.lines).toEqual([
      "Already linked: IdP subject 'octocat' (provider 'github') → principal 'alice'. No change.",
    ]);
    expect(st.writes()).toEqual([]);
  });

  test("refuses a failed credential read instead of reading it as 'no mapping'", async () => {
    const st = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: ["alice"],
      credentials: [
        { id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "bob", status: "active" },
      ],
      failCredRead: true,
    });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/ops API read at .* failed \(HTTP 500\)/);
    expect(st.writes()).toEqual([]);
  });

  test("refuses a failed PROVISIONER read after the preflight, and writes nothing", async () => {
    // Read 1 is `link`'s own preflight (it succeeds); read 2 is the shared
    // provisioner's pre-write read, the one that used to be turned into [] —
    // which is exactly the "no rows" answer a superseding write would rewrite.
    const st = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: ["alice", "bob"],
      credentials: [
        { id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "bob", status: "active" },
      ],
      failCredReadAt: 2,
    });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT, replace: true },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/ops API read at .* failed \(HTTP 500\)/);
    expect(st.writes()).toEqual([]);
    // The prior credential is untouched: the failed read did not stand in for "no rows".
    expect(st.rows.get("cred_c1")?.status).toBe("active");
  });

  test("refuses a PROVISIONER read that did not answer with a record list, writing nothing", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"], answerNotAListAt: 2 });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/did not answer with a record list/);
    expect(st.writes()).toEqual([]);
  });

  test("refuses a read that did not answer with a record list", async () => {
    // 200 with a body that is not a list is not "no mapping" either.
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"], answerNotAList: true });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/did not answer with a record list/);
    expect(st.writes()).toEqual([]);
  });

  const MALFORMED_CREDENTIAL_ANSWERS: unknown[] = [
    [null],
    [42],
    [[]],
    [{ id: "cred_c1", idpSubject: "someone-else", idpProvider: "github", principalId: "bob", status: "active" }],
  ];

  for (const credBody of MALFORMED_CREDENTIAL_ANSWERS) {
    test(`refuses a Credential answer of ${JSON.stringify(credBody)} with --replace, writing nothing`, async () => {
      const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice", "bob"], credBody });
      await expect(
        linkPrincipalMapping(
          { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT, replace: true },
          { fetchImpl: st.fetchImpl },
        ),
      ).rejects.toThrow(/answered with a malformed Credential record \(entry 0\)/);
      expect(st.writes()).toEqual([]);
    });
  }

  const MALFORMED_SECOND_AGENT_ANSWERS: Array<[unknown, RegExp]> = [
    [[null], /answered with a malformed Agent record \(entry 0\)/],
    [[{ id: 7 }], /answered with a malformed Agent record \(entry 0\)/],
    [{ ok: true }, /did not answer with a record list/],
    [[{ id: "someone-else" }], /query-mismatch:id/],
  ];

  for (const [body, reason] of MALFORMED_SECOND_AGENT_ANSWERS) {
    test(`refuses a second Agent answer of ${JSON.stringify(body)}, writing nothing`, async () => {
      // Agent read 1 is `link`'s own check; read 2 is the shared provisioner's.
      const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"], agentBodyAt: { n: 2, body } });
      await expect(
        linkPrincipalMapping(
          { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
          { fetchImpl: st.fetchImpl },
        ),
      ).rejects.toThrow(reason);
      expect(st.writes()).toEqual([]);
    });
  }

  test("sends every call to the target it was given, and refuses a bad one before any call", async () => {
    const numeric = mappingStub({ expectedUrl: LOCAL_OPS, principals: ["alice"] });
    const result = await linkPrincipalMapping(
      { opsPortOrUrl: LOCAL_PORT, ...ADMIN, principal: "alice", ...SUBJECT },
      { fetchImpl: numeric.fetchImpl },
    );
    expect(result.action).toBe("linked");
    expect(numeric.calls.length).toBeGreaterThan(0);

    const bad = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"] });
    await expect(
      linkPrincipalMapping(
        { hostedOrigin: `${HOSTED}/mcp`, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: bad.fetchImpl },
      ),
    ).rejects.toThrow(/cannot read hostedOrigin/);
    expect(bad.calls).toEqual([]);
  });
});

async function invokeUnlink(fetchImpl: typeof fetch) {
  const old = { fetch: globalThis.fetch, exit: process.exit, log: console.log, error: console.error };
  const logs: string[] = [];
  const errors: string[] = [];
  const exitSignal = Symbol("unlink-exit");
  let exitCode = 0;
  try {
    globalThis.fetch = fetchImpl;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    process.exit = ((code?: number) => { exitCode = code ?? 0; throw exitSignal; }) as typeof process.exit;
    const command = new Command();
    register(command);
    try {
      await command.parseAsync(["principal", "unlink", "alice", "--idp-subject", "octocat",
        "--instance", HOSTED, "--admin-pass", ADMIN.adminPass], { from: "user" });
    } catch (err) {
      if (err !== exitSignal) throw err;
    }
    return { exitCode, logs: logs.join("\n"), errors: errors.join("\n") };
  } finally {
    globalThis.fetch = old.fetch;
    process.exit = old.exit;
    console.log = old.log;
    console.error = old.error;
  }
}

describe("flair principal unlink (flair#2115)", () => {
  const credentials = ["cred_c1", "cred_c2"].map(id => ({
    id, idpSubject: "octocat", idpProvider: "github", principalId: "alice", status: "active",
  }));
  for (const [name, updateResult, updateIds, unconfirmed] of [
    ["skipped_hashes", { update_hashes: ["cred_c1", "cred_c2"], skipped_hashes: ["cred_c2"] }, ["cred_c1"], ["cred_c2"]],
    ["missing ID in update_hashes", { update_hashes: ["cred_c1"] }, ["cred_c1", "cred_c2"], ["cred_c2"]],
    ["partial update", { update_hashes: ["cred_c1"], skipped_hashes: ["cred_c2"] }, ["cred_c1"], ["cred_c2"]],
    ["missing update_hashes", { message: "updated" }, [], ["cred_c1", "cred_c2"]],
    ["error in update result", { update_hashes: ["cred_c1", "cred_c2"], error: "failed" }, [], ["cred_c1", "cred_c2"]],
    ["confirmed result with active readback", { update_hashes: ["cred_c1", "cred_c2"] }, ["cred_c1"], ["cred_c2"]],
  ] as Array<[string, unknown, string[], string[]]>) {
    test(`unlink exits nonzero without Unlinked on HTTP 200 ${name}`, async () => {
      const st = mappingStub({ expectedUrl: HOSTED_OPS, credentials, updateResult, updateIds });
      const result = await invokeUnlink(st.fetchImpl);
      expect(result.exitCode).toBe(1);
      expect(result.logs).not.toContain("Unlinked");
      for (const id of unconfirmed) expect(result.errors).toContain(id);
      expect(st.writes()).toHaveLength(1);
      for (const row of credentials) {
        expect(st.rows.get(row.id)?.status).toBe(updateIds.includes(row.id) ? "revoked" : "active");
      }
    });
  }

  test("unlink exits nonzero without Unlinked when readback fails", async () => {
    // Read 3 is the subject readback; reads 1-2 are the preflight and the
    // flair#2222 pre-write guard.
    const st = mappingStub({ expectedUrl: HOSTED_OPS, credentials, failCredReadAt: 3 });
    const result = await invokeUnlink(st.fetchImpl);
    expect(result.exitCode).toBe(1);
    expect(result.logs).not.toContain("Unlinked");
    for (const row of credentials) expect(result.errors).toContain(row.id);
    expect(result.errors).toContain("read");
  });

  test("unlink prints Unlinked only after all IDs and the subject readback are confirmed", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, credentials });
    const result = await invokeUnlink(st.fetchImpl);
    expect(result.exitCode).toBe(0);
    expect(result.logs).toContain("Unlinked");
    expect(result.logs).toContain("cred_c1, cred_c2");
    expect(result.errors).toBe("");
    expect(st.calls.map(c => c.body.operation)).toEqual([
      "search_by_value", "search_by_conditions", "search_by_value", "search_by_conditions", "update", "search_by_conditions",
    ]);
    expect([...st.rows.values()].every(row => row.status === "revoked")).toBe(true);
  });

  test("revokes the subject's mapping to that principal and prints it", async () => {
    const st = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: ["alice"],
      credentials: [
        { id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "alice", status: "active" },
      ],
    });
    const result = await unlinkPrincipalMapping(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
      { fetchImpl: st.fetchImpl, now: () => "2026-10-02T00:00:00.000Z" },
    );
    expect(result.revokedCredentialIds).toEqual(["cred_c1"]);
    expect(result.lines).toEqual([
      "Unlinked: IdP subject 'octocat' is no longer mapped to principal 'alice' — Credential(kind:idp) revoked (cred_c1).",
    ]);
    // Retained, not deleted — the row stays legible as a revoked credential.
    expect(st.rows.get("cred_c1")).toMatchObject({ status: "revoked", principalId: "alice", idpSubject: "octocat" });
    expect([...st.rows.values()].filter((r) => r.status !== "revoked")).toEqual([]);
  });

  test("refuses a subject that is not mapped to that principal, writing nothing", async () => {
    const elsewhere = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: ["alice", "bob"],
      credentials: [
        { id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "bob", status: "active" },
      ],
    });
    await expect(
      unlinkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: elsewhere.fetchImpl },
      ),
    ).rejects.toThrow(/is not mapped to principal 'alice'.*It is mapped to: bob/);
    expect(elsewhere.writes()).toEqual([]);

    const none = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"] });
    await expect(
      unlinkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: none.fetchImpl },
      ),
    ).rejects.toThrow(/has no active Credential\(kind:idp\) mapping/);
    expect(none.writes()).toEqual([]);
  });

  test("refuses a mapping that carries a different provider name, writing nothing", async () => {
    const st = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: ["alice"],
      credentials: [
        { id: "cred_c1", idpSubject: "octocat", idpProvider: "gitlab", principalId: "alice", status: "active" },
      ],
    });
    await expect(
      unlinkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/under provider 'gitlab', not 'github'.*--idp-provider gitlab/);
    expect(st.writes()).toEqual([]);
  });

  test("refuses a missing principal by name, and a failed read as a failed read", async () => {
    const missing = mappingStub({ expectedUrl: HOSTED_OPS, principals: [] });
    await expect(
      unlinkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "ghost", ...SUBJECT },
        { fetchImpl: missing.fetchImpl },
      ),
    ).rejects.toThrow(/No principal 'ghost'/);
    expect(missing.writes()).toEqual([]);

    // The Agent read, then the subject's credentials: both must refuse.
    const agentRead = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"], failAgentRead: true });
    await expect(
      unlinkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: agentRead.fetchImpl },
      ),
    ).rejects.toThrow(/ops API read at .* failed \(HTTP 500\)/);
    expect(agentRead.writes()).toEqual([]);

    const credRead = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"], failCredRead: true });
    await expect(
      unlinkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: credRead.fetchImpl },
      ),
    ).rejects.toThrow(/ops API read at .* failed \(HTTP 500\)/);
    expect(credRead.writes()).toEqual([]);
  });

  test("refuses [null] Credential rows, writing nothing", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"], credBody: [null] });
    await expect(
      unlinkPrincipalMapping(
        { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
        { fetchImpl: st.fetchImpl },
      ),
    ).rejects.toThrow(/answered with a malformed Credential record \(entry 0\)/);
    expect(st.writes()).toEqual([]);
  });
});

describe("flair principal links (flair#2115)", () => {
  test("lists exactly the principal's active mappings", async () => {
    const st = mappingStub({
      expectedUrl: HOSTED_OPS,
      principals: ["alice", "bob"],
      credentials: [
        { id: "cred_a", idpSubject: "octocat", idpProvider: "github", principalId: "alice", status: "active" },
        { id: "cred_b", idpSubject: "octocat-alt", idpProvider: "gitlab", principalId: "alice", status: "active" },
        { id: "cred_bob", idpSubject: "hubot", idpProvider: "github", principalId: "bob", status: "active" },
        { id: "cred_gone", idpSubject: "old", idpProvider: "github", principalId: "alice", status: "revoked" },
      ],
    });
    const result = await listPrincipalMappings(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "alice" },
      { fetchImpl: st.fetchImpl },
    );
    expect(result.mappings).toEqual([
      { credentialId: "cred_a", idpProvider: "github", idpSubject: "octocat" },
      { credentialId: "cred_b", idpProvider: "gitlab", idpSubject: "octocat-alt" },
    ]);
    expect(result.lines).toEqual([
      "IdP subject 'octocat' (provider 'github') → principal 'alice' (cred_a)",
      "IdP subject 'octocat-alt' (provider 'gitlab') → principal 'alice' (cred_b)",
    ]);
    // A list is a read: nothing is written.
    expect(st.writes()).toEqual([]);
  });

  test("reports an empty list after a valid read with no active mapping", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"] });
    const result = await listPrincipalMappings(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "alice" },
      { fetchImpl: st.fetchImpl },
    );
    expect(result.mappings).toEqual([]);
    expect(result.lines).toEqual(["No IdP mappings for principal 'alice'."]);
  });

  test("refuses a missing principal, and a failed read", async () => {
    const missing = mappingStub({ expectedUrl: HOSTED_OPS, principals: [] });
    await expect(
      listPrincipalMappings({ hostedOrigin: HOSTED, ...ADMIN, principal: "ghost" }, { fetchImpl: missing.fetchImpl }),
    ).rejects.toThrow(/No principal 'ghost'/);

    const failed = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"], failCredRead: true });
    await expect(
      listPrincipalMappings({ hostedOrigin: HOSTED, ...ADMIN, principal: "alice" }, { fetchImpl: failed.fetchImpl }),
    ).rejects.toThrow(/ops API read at .* failed \(HTTP 500\)/);
  });
});

describe("flair principal link|unlink|links — the target policy (flair#2115)", () => {
  /** Representative shapes the three commands refuse. */
  const REFUSED_TARGETS: string[] = [
    "http://flair.example.com", // a REMOTE origin, but not HTTPS
    "http://127.0.0.1:41234", // loopback over http
    "https://localhost.", // the absolute form of localhost
    "https://localhost.:41234",
    "https://localhost:41234",
    "https://127.0.0.1", // loopback
    "https://10.0.0.1", // RFC1918
    "https://172.16.0.1",
    "https://192.168.0.1",
    "https://169.254.0.1", // link-local
    "https://[::1]", // IPv6 loopback
    "https://[fd00::1]", // IPv6 unique-local
    "https://[fe80::1]", // IPv6 link-local
    "https://[::ffff:192.168.0.1]", // IPv4-mapped IPv6
    "ftp://flair.example.com", // not HTTPS
    "not-a-url", // unparseable
  ];

  for (const instance of REFUSED_TARGETS) {
    test(`refuses ${instance} before any request`, async () => {
      // A fetch that FAILS the test if it is ever called: "refused before any
      // request" is measured, not assumed.
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        throw new Error(`a request was made to ${instance}`);
      }) as unknown as typeof fetch;
      const mapping = { hostedOrigin: instance, ...ADMIN, principal: "alice", ...SUBJECT };
      await expect(linkPrincipalMapping(mapping, { fetchImpl })).rejects.toThrow(/must be an HTTPS URL whose host is not/);
      await expect(unlinkPrincipalMapping(mapping, { fetchImpl })).rejects.toThrow(/must be an HTTPS URL whose host is not/);
      await expect(
        listPrincipalMappings({ hostedOrigin: instance, ...ADMIN, principal: "alice" }, { fetchImpl }),
      ).rejects.toThrow(/must be an HTTPS URL whose host is not/);
      expect(calls).toBe(0);
    });
  }

  test("accepts an HTTPS origin with a DNS name", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"] });
    const result = await linkPrincipalMapping(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
      { fetchImpl: st.fetchImpl },
    );
    expect(result.action).toBe("linked");
  });
});


describe("operations read predicates", () => {
  const params = { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT };
  const provision = (fetchImpl: typeof fetch) => provisionIdpIdentityMapping(
    { ...params, principalKind: "human" }, { fetchImpl });
  const good = { id: "cred_prior", kind: "idp", principalId: "bob", idpProvider: "github",
    idpSubject: "octocat", status: "active", createdAt: "2026-10-02T00:00:00.000Z" };
  const agentAnswers = [
    { name: "mixed", rows: [{ id: "alice" }, { id: "bob" }], reason: "query-mismatch:id" },
    { name: "duplicate", rows: [{ id: "alice" }, { id: "alice" }], reason: "duplicate-row-id" },
  ];
  for (const stage of ["principal preflight", "provisioner Agent"] as const) {
    for (const answer of agentAnswers) {
      test(`${stage}: ${answer.name} answer refuses without writing`, async () => {
        const st = mappingStub({ expectedUrl: HOSTED_OPS, agentBodyAt: { n: 1, body: answer.rows } });
        const run = stage === "principal preflight"
          ? linkPrincipalMapping(params, { fetchImpl: st.fetchImpl }) : provision(st.fetchImpl);
        const result = await run.catch(error => error);
        expect(st.writes()).toEqual([]);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toContain(answer.reason);
      });
    }
  }
  for (const stage of ["link subject", "unlink subject", "provisioner subject", "principal credentials"] as const) {
    const row = stage === "principal credentials" || stage === "unlink subject"
      ? { ...good, principalId: "alice" } : good;
    const answers = [
      { name: "invalid-label", rows: [{ ...row, label: [] }], reason: "missing-or-invalid-credential-field" },
      { name: "wrong-kind", rows: [{ ...row, kind: "api-key" }], reason: "query-mismatch:kind" },
      { name: "missing-kind", rows: [Object.fromEntries(Object.entries(row).filter(([key]) => key !== "kind"))], reason: "query-mismatch:kind" },
      { name: "mixed-kind", rows: [row, { ...row, id: "cred_extra", kind: "api-key" }], reason: "query-mismatch:kind" },
      { name: "mixed-query", rows: [row, { ...row, id: "cred_extra", ...(stage === "principal credentials"
          ? { principalId: "carl" } : { idpSubject: "unrelated" }) }], reason: stage === "principal credentials"
          ? "query-mismatch:principalId" : "query-mismatch:idpSubject" },
      { name: "duplicate", rows: [row, row], reason: "duplicate-row-id" },
      { name: "multi-principal", rows: [row, { ...row, id: "cred_extra", principalId: "carl" }], reason:
          stage === "principal credentials" ? "query-mismatch:principalId" : "ambiguous-prior-principals" },
    ];
    for (const answer of answers.filter(answer => stage !== "provisioner subject" || answer.name !== "multi-principal")) {
      test(`${stage}: ${answer.name} answer refuses without writing`, async () => {
        const st = mappingStub({ expectedUrl: HOSTED_OPS, credBody: answer.rows,
          principals: stage === "provisioner subject" ? [] : ["alice"] });
        const run = stage === "link subject" ? linkPrincipalMapping({ ...params, replace: true }, { fetchImpl: st.fetchImpl })
          : stage === "unlink subject" ? unlinkPrincipalMapping(params, { fetchImpl: st.fetchImpl })
          : stage === "principal credentials" ? listPrincipalMappings(params, { fetchImpl: st.fetchImpl })
          : provision(st.fetchImpl);
        const result = await run.catch(error => error);
        expect(st.writes()).toEqual([]);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toContain(answer.reason);
      });
    }
  }
  for (const fault of ["wrong-kind", "mixed-kind", "mixed-subject", "missing-kind", "duplicate", "multi-principal",
                       "wrong-principal", "wrong-provider", "wrong-status", "invalid-label"] as const) {
    test(`post-write verification: ${fault} refuses and sends no further write`, async () => {
      const st = mappingStub({ expectedUrl: HOSTED_OPS });
      let writesAtRead = 0;
      const fetchImpl = (async (url: any, init?: RequestInit) => {
        const response = await st.fetchImpl(url, init);
        const query = JSON.parse(String(init?.body));
        // The invariant read-back is the first Credential read AFTER the write;
        // the preflight and the flair#2222 pre-write guard both see no write yet.
        if (query.table !== "Credential" || query.operation !== "search_by_conditions" || st.writes().length === 0) return response;
        writesAtRead = st.writes().length;
        const rows = await response.json() as any[];
        const row = rows[0];
        if (fault === "invalid-label") row.label = [];
        if (fault === "wrong-kind") row.kind = "api-key";
        if (fault === "missing-kind") delete row.kind;
        if (fault === "wrong-principal") row.principalId = "carl";
        if (fault === "wrong-provider") row.idpProvider = "gitlab";
        if (fault === "wrong-status") row.status = "pending";
        if (fault === "mixed-kind") rows.push({ ...row, id: "extra", kind: "api-key" });
        if (fault === "mixed-subject") rows.push({ ...row, id: "extra", idpSubject: "unrelated" });
        if (fault === "multi-principal") rows.push({ ...row, id: "extra", principalId: "carl" });
        if (fault === "duplicate") rows.push({ ...row });
        return Response.json(rows);
      }) as typeof fetch;
      const reason = fault === "duplicate" ? "duplicate-row-id"
        : fault === "multi-principal" ? "post-write-mismatch"
        : fault === "mixed-subject" ? "query-mismatch:idpSubject"
        : ["wrong-kind", "mixed-kind", "missing-kind"].includes(fault) ? "query-mismatch:kind"
        : fault === "invalid-label" ? "missing-or-invalid-credential-field"
        : "uniqueness invariant";
      await expect(provision(fetchImpl)).rejects.toThrow(reason);
      expect(writesAtRead).toBe(1);
      expect(st.writes()).toHaveLength(writesAtRead);
    });
  }
});

describe("legacy Credential mapping reads", () => {
  const params = { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT };
  const now = "2026-10-03T00:00:00.000Z";
  for (const stage of ["link", "unlink", "links", "provisioner"] as const) {
    test(`${stage} accepts a credential without createdAt`, async () => {
      const st = mappingStub({ expectedUrl: HOSTED_OPS, credentials: [
        { id: "cred_legacy", kind: "idp", principalId: "alice", ...SUBJECT, createdAt: undefined },
      ] });
      if (stage === "link") expect((await linkPrincipalMapping(params, { fetchImpl: st.fetchImpl })).action).toBe("already-linked");
      if (stage === "unlink") expect((await unlinkPrincipalMapping(params, { fetchImpl: st.fetchImpl })).revokedCredentialIds).toEqual(["cred_legacy"]);
      if (stage === "links") expect((await listPrincipalMappings(params, { fetchImpl: st.fetchImpl })).mappings).toHaveLength(1);
      if (stage === "provisioner") expect((await provisionIdpIdentityMapping({ ...params, principalKind: "human" }, { fetchImpl: st.fetchImpl })).credentialReused).toBe(true);
    });
  }
  for (const stage of ["link", "unlink", "provisioner"] as const) {
    test(`${stage} skips an idp credential without principalId`, async () => {
      const st = mappingStub({ expectedUrl: HOSTED_OPS, credentials: [
        { id: "cred_legacy", kind: "idp", ...SUBJECT, createdAt: undefined },
        { id: "cred_alice", kind: "idp", principalId: "alice", ...SUBJECT },
      ] });
      if (stage === "link") expect((await linkPrincipalMapping(params, { fetchImpl: st.fetchImpl })).action).toBe("already-linked");
      if (stage === "unlink") expect((await unlinkPrincipalMapping(params, { fetchImpl: st.fetchImpl })).revokedCredentialIds).toEqual(["cred_alice"]);
      if (stage === "provisioner") expect((await provisionIdpIdentityMapping({ ...params, principalKind: "human" }, { fetchImpl: st.fetchImpl })).credentialId).toBe("cred_alice");
      expect(st.rows.get("cred_legacy")?.status).toBe("active");
      expect(st.writes().flatMap(call => call.body.records).some(row => row.id === "cred_legacy")).toBe(false);
    });
  }
  for (const createdAt of ["2025-01-01T00:00:00.000Z", undefined, 42]) {
    for (const provider of ["github", "okta"]) {
      test(`legacy ${provider === "github" ? "reused" : "superseded"} createdAt ${String(createdAt)} is preserved or assigned`, async () => {
        const st = mappingStub({ expectedUrl: HOSTED_OPS, credentials: [
          { id: "cred_legacy", kind: "idp", principalId: "bob", ...SUBJECT, idpProvider: provider, createdAt },
        ] });
        await provisionIdpIdentityMapping({ ...params, principalKind: "human" }, { fetchImpl: st.fetchImpl, now: () => now });
        const written = st.writes().flatMap(call => call.body.records).find(row => row.id === "cred_legacy");
        expect(written.createdAt).toBe(typeof createdAt === "string" ? createdAt : now);
        expect(st.rows.get("cred_legacy")?.createdAt).toBe(written.createdAt);
      });
    }
  }
  for (const createdAt of [undefined, 42]) {
    test(`post-write read accepts createdAt ${String(createdAt)}`, async () => {
      const st = mappingStub({ expectedUrl: HOSTED_OPS });
      const fetchImpl = (async (url: any, init?: RequestInit) => {
        const response = await st.fetchImpl(url, init);
        const query = JSON.parse(String(init?.body));
        // The invariant read-back is the first Credential read after the write.
        if (query.table !== "Credential" || query.operation !== "search_by_conditions" || st.writes().length === 0) return response;
        const rows = await response.json() as any[];
        rows[0].createdAt = createdAt;
        return Response.json(rows);
      }) as typeof fetch;
      expect((await provisionIdpIdentityMapping({ ...params, principalKind: "human" }, { fetchImpl })).credentialId).toBeDefined();
      expect(st.writes()).toHaveLength(1);
    });
  }
  test("a principal-less row still must match the subject query", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, credBody: [
      { id: "cred_legacy", kind: "idp", idpSubject: "unrelated" },
    ] });
    await expect(linkPrincipalMapping(params, { fetchImpl: st.fetchImpl })).rejects.toThrow("query-mismatch:idpSubject");
    expect(st.writes()).toEqual([]);
  });
  for (const stage of ["link", "unlink"] as const) {
    test(`${stage} preflight refuses ambiguity and names the healing command`, async () => {
      const st = mappingStub({ expectedUrl: HOSTED_OPS, credentials: [
        { id: "cred_a", principalId: "alice", ...SUBJECT },
        { id: "cred_b", principalId: "bob", ...SUBJECT, idpProvider: "okta" },
      ] });
      const result = await (stage === "link" ? linkPrincipalMapping({ ...params, replace: true }, { fetchImpl: st.fetchImpl })
        : unlinkPrincipalMapping(params, { fetchImpl: st.fetchImpl })).catch(error => error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain("ambiguous-prior-principals");
      expect(result.message).toContain("flair mcp enable");
      expect(st.writes()).toEqual([]);
    });
  }
});

// ─── flair#2222 — a change between preflight and write refuses ───────────────
//
// Re-read Agent presence and canonicalized fields of principal-bearing IdP rows
// before each write. Valid comparison differences refuse with mapping-changed-underneath;
// invalid changed rows can fail earlier validation with missing-or-invalid-credential-field.
// Both fail closed.

describe("flair#2222 — the pre-write re-validation bound", () => {
  const provisionParams = { hostedOrigin: HOSTED, ...ADMIN, principal: "self", principalKind: "human" as const, ...SUBJECT };

  test("the missing-Agent path checks before both writes and accepts its own insert", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: [] });
    const result = await provisionIdpIdentityMapping(provisionParams, { fetchImpl: st.fetchImpl });
    expect(result.principalCreated).toBe(true);
    expect(st.calls.map(c => c.body.table ? `${c.body.operation}:${c.body.table}` : c.body.operation)).toEqual([
      "search_by_value:Agent", "search_by_conditions:Credential",
      "search_by_value:Agent", "search_by_conditions:Credential", "sql", "insert:Agent",
      "search_by_value:Agent", "search_by_conditions:Credential", "upsert:Credential",
      "search_by_conditions:Credential",
    ]);
    expect(st.principals.get("self")).toMatchObject({ id: "self", admin: false, publicKey: "idp:github:octocat" });
    expect(st.rows.get(result.credentialId)).toMatchObject({ principalId: "self", status: "active" });
  });

  for (const change of ["repoint", "add", "remove-agent"] as const) {
    test(`the missing-Agent path refuses ${change} after insert without a Credential write or rollback`, async () => {
      const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["bob", "carl"], credentials: [
        { id: "cred_c1", principalId: "bob", ...SUBJECT },
      ] });
      const fetchImpl = (async (url: any, init?: RequestInit) => {
        const response = await st.fetchImpl(url, init);
        const op = JSON.parse(String(init?.body));
        if (op.operation === "insert" && op.table === "Agent") {
          if (change === "repoint") st.rows.get("cred_c1")!.principalId = "carl";
          if (change === "add") st.rows.set("cred_c2", { ...st.rows.get("cred_c1"), id: "cred_c2", principalId: "carl" });
          if (change === "remove-agent") st.principals.delete("self");
        }
        return response;
      }) as typeof fetch;
      const error = await provisionIdpIdentityMapping(provisionParams, { fetchImpl }).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("mapping-changed-underneath");
      expect(error.message).toContain("Agent 'self' was created; no rollback was attempted");
      expect(error.message).not.toContain("Nothing was written");
      expect(st.writes().map(c => `${c.body.operation}:${c.body.table}`)).toEqual(["insert:Agent"]);
      expect(st.principals.has("self")).toBe(change !== "remove-agent");
      expect(st.rows.get("cred_c1")).toMatchObject({ principalId: change === "repoint" ? "carl" : "bob", status: "active" });
      expect(st.rows.has("cred_c2")).toBe(change === "add");
    });
  }

  test("the missing-Agent path refuses a change before insert without either write", async () => {
    const st = raceStub({ principals: [], mutate: s => { s.principals.set("self", { id: "self" }); } });
    await expect(provisionIdpIdentityMapping(provisionParams, { fetchImpl: st.fetchImpl })).rejects.toThrow("mapping-changed-underneath");
    expect(st.writes()).toEqual([]);
  });

  test("lastUsedAt changes and principal-less legacy rows do not refuse a mapping write", async () => {
    const st = raceStub({ principals: ["self"], credentials: [
      { id: "cred_c1", principalId: "self", ...SUBJECT },
    ], mutate: s => {
      s.rows.get("cred_c1")!.lastUsedAt = "2026-10-03T00:00:00.000Z";
      s.rows.set("cred_legacy", { id: "cred_legacy", kind: "idp", ...SUBJECT });
    } });
    const result = await provisionIdpIdentityMapping(provisionParams, { fetchImpl: st.fetchImpl });
    expect(result.credentialId).toBe("cred_c1");
    expect(st.writes()).toHaveLength(1);
    expect(st.rows.has("cred_legacy")).toBe(true);
  });

  /** A stub whose store is changed ONCE, after the first subject read answers. */
  function raceStub(opts: {
    principals?: string[];
    credentials?: Array<Record<string, any>>;
    mutate: (st: ReturnType<typeof mappingStub>) => void;
  }) {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: opts.principals, credentials: opts.credentials });
    let injected = false;
    const inner = st.fetchImpl;
    const fetchImpl = (async (url: any, init?: any) => {
      const res = await inner(url, init);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (!injected && body.operation === "search_by_conditions" && body.table === "Credential") {
        injected = true;
        opts.mutate(st);
      }
      return res;
    }) as unknown as typeof fetch;
    return { ...st, fetchImpl };
  }

  test("link refuses when the Credential row moved after the preflight", async () => {
    const st = raceStub({
      principals: ["alice", "bob", "carl"],
      credentials: [{ id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "bob", status: "active" }],
      mutate: (s) => { s.rows.get("cred_c1")!.principalId = "carl"; },
    });
    await expect(
      linkPrincipalMapping({ hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT, replace: true }, { fetchImpl: st.fetchImpl }),
    ).rejects.toThrow(/mapping-changed-underneath/);
    expect(st.writes()).toEqual([]);
    expect(st.rows.get("cred_c1")!.principalId, "the concurrently changed row was not overwritten").toBe("carl");
  });

  test("unlink refuses when the Credential row moved after the preflight", async () => {
    const st = raceStub({
      principals: ["alice", "bob"],
      credentials: [{ id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "alice", status: "active" }],
      mutate: (s) => { s.rows.get("cred_c1")!.principalId = "bob"; },
    });
    await expect(
      unlinkPrincipalMapping({ hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT }, { fetchImpl: st.fetchImpl }),
    ).rejects.toThrow(/mapping-changed-underneath/);
    expect(st.writes()).toEqual([]);
    expect(st.rows.get("cred_c1")!.status).toBe("active");
  });

  test("the provisioner refuses when a concurrent link adds a subject row after the preflight", async () => {
    const st = raceStub({
      principals: ["self", "carl"],
      credentials: [{ id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "self", status: "active" }],
      mutate: (s) => {
        s.rows.set("cred_c2", { id: "cred_c2", kind: "idp", status: "active", idpProvider: "okta", idpSubject: "octocat", principalId: "carl", createdAt: "2026-10-02T00:00:00.000Z" });
      },
    });
    await expect(
      provisionIdpIdentityMapping({ hostedOrigin: HOSTED, ...ADMIN, principal: "self", principalKind: "human", ...SUBJECT }, { fetchImpl: st.fetchImpl }),
    ).rejects.toThrow(/mapping-changed-underneath/);
    expect(st.writes()).toEqual([]);
    expect([...st.rows.values()].filter((r) => r.status !== "revoked").length, "both rows survive").toBe(2);
  });

  test("the provisioner refuses when the principal Agent is removed after the preflight", async () => {
    const st = raceStub({
      principals: ["self"],
      credentials: [{ id: "cred_c1", idpSubject: "octocat", idpProvider: "github", principalId: "self", status: "active" }],
      mutate: (s) => { s.principals.delete("self"); },
    });
    await expect(
      provisionIdpIdentityMapping({ hostedOrigin: HOSTED, ...ADMIN, principal: "self", principalKind: "human", ...SUBJECT }, { fetchImpl: st.fetchImpl }),
    ).rejects.toThrow(/mapping-changed-underneath/);
    expect(st.writes()).toEqual([]);
  });
});
