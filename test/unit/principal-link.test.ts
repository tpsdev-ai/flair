/**
 * principal-link.test.ts — `flair principal link` / `unlink` / `links`
 * (flair#2115): map ONE IdP login to a principal on an already-enabled
 * instance, without walking `flair mcp enable`'s whole flow.
 *
 * Every rule in this surface is a control, so each test asserts the outcome
 * AND the not-written side of a refusal. The ops store is an in-memory stub
 * served by an injected fetch: every URL is asserted before it is served, and
 * no test makes a network call.
 *
 * The mapping WRITE is `provisionIdpIdentityMapping` (the `mcp enable` step),
 * so the "nothing was written" assertions look at the stub's whole call log —
 * no insert, no upsert, no update.
 */
import { describe, test, expect } from "bun:test";
import {
  linkPrincipalMapping,
  unlinkPrincipalMapping,
  listPrincipalMappings,
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
  /** Answer reads with 200 and a body that is NOT a record list. */
  answerNotAList?: boolean;
}) {
  const principals = new Map<string, any>((opts.principals ?? ["alice"]).map((id) => [id, { id }]));
  const rows = new Map<string, any>(
    (opts.credentials ?? []).map((c) => [String(c.id), { kind: "idp", status: "active", ...c }]),
  );
  const calls: Call[] = [];
  let readsLeft = opts.failReads ?? 0;
  let credReads = 0;

  const write = (records: any[]) => {
    for (const rec of records) rows.set(String(rec.id), { ...(rows.get(String(rec.id)) ?? {}), ...rec });
  };

  const fetchImpl = (async (url: any, init?: any) => {
    const target = String(url);
    expect(target).toBe(opts.expectedUrl);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: target, body });
    if (body.operation === "search_by_value" && body.table === "Agent") {
      if (opts.failAgentRead || readsLeft-- > 0) return new Response("boom", { status: 500 });
      if (opts.answerNotAList) return Response.json({ ok: true });
      if (!principals.has(body.search_value)) return Response.json([]);
      return Response.json([{ id: opts.mismatchAgentId ? "someone-else" : body.search_value }]);
    }
    if (body.operation === "search_by_conditions" && body.table === "Credential") {
      credReads += 1;
      if (opts.failCredRead || readsLeft-- > 0 || credReads === opts.failCredReadAt) {
        return new Response("boom", { status: 500 });
      }
      if (opts.answerNotAList || credReads === opts.answerNotAListAt) return Response.json({ ok: true });
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
      if (opts.failWrites) return new Response("nope", { status: 500 });
      write(body.records ?? []);
      return Response.json({ message: "inserted" });
    }
    if ((body.operation === "upsert" || body.operation === "update") && body.table === "Credential") {
      if (opts.failWrites) return new Response("nope", { status: 500 });
      write(body.records ?? []);
      return Response.json({ message: body.operation === "upsert" ? "upserted" : "updated" });
    }
    return Response.json({});
  }) as unknown as typeof fetch;

  const writes = () => calls.filter((c) => ["insert", "upsert", "update"].includes(c.body.operation));
  return { fetchImpl, calls, writes, rows, principals };
}

const SUBJECT = { idpSubject: "octocat", idpProvider: "github" };

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
    // An unreadable Agent table is not an absent principal: no insert.
    expect(st.calls.filter((c) => c.body.operation === "insert")).toEqual([]);
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
    ).rejects.toThrow(/No principal 'alice'/);
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
        "They no longer resolve, and anything relying on them stops working. " +
        "Exactly one active credential per (kind, idpSubject) is the invariant that keeps resolution deterministic.",
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

describe("flair principal unlink (flair#2115)", () => {
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

  test("reports an empty list only when the read held no row", async () => {
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
  /** Every shape the three commands promise to refuse, so a request never carries
   *  the admin credential to one of them. */
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
      await expect(linkPrincipalMapping(mapping, { fetchImpl })).rejects.toThrow(/public HTTPS origin/);
      await expect(unlinkPrincipalMapping(mapping, { fetchImpl })).rejects.toThrow(/public HTTPS origin/);
      await expect(
        listPrincipalMappings({ hostedOrigin: instance, ...ADMIN, principal: "alice" }, { fetchImpl }),
      ).rejects.toThrow(/public HTTPS origin/);
      expect(calls).toBe(0);
    });
  }

  test("accepts a public HTTPS origin", async () => {
    const st = mappingStub({ expectedUrl: HOSTED_OPS, principals: ["alice"] });
    const result = await linkPrincipalMapping(
      { hostedOrigin: HOSTED, ...ADMIN, principal: "alice", ...SUBJECT },
      { fetchImpl: st.fetchImpl },
    );
    expect(result.action).toBe("linked");
  });
});
