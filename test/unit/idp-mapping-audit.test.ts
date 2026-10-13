/**
 * idp-mapping-audit.test.ts — `flair doctor`'s read-only check for IdP identity
 * mappings and who wrote them (src/lib/idp-mapping-audit.ts).
 *
 * The audit entries below have the shape Harper's `read_audit_log` (search by
 * primary key) returns: `{ operation, user_name, timestamp, records: [image] }`,
 * where the image is the WHOLE row as of that entry — Harper reconstructs it for
 * a partial write such as a REST PATCH or an ops-API update. An ops-API insert
 * records "insert"; a REST POST/PUT, an in-process put and an ops-API upsert
 * record "upsert" whether or not the row existed. A verified non-admin agent's
 * REST writes run as `flair-agent`; an admin agent, the ops API and the
 * server's provisioners do not.
 */
import { describe, expect, it } from "bun:test";
import {
  classifyIdpMappingHistory,
  CREATION_STAMP_TOLERANCE_MS,
  describeIdpMappingWriters,
  idpMappingRemedyCommands,
  idpMappingWriterReport,
  NON_ADMIN_AGENT_HARPER_USER,
  readCredentialAudit,
  readIdpMappingRows,
  type CredentialAuditEntry,
} from "../../src/lib/idp-mapping-audit";

const AGENT = NON_ADMIN_AGENT_HARPER_USER;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** An idp row with no createdAt, so no entry carrying it reads as a creation stamp. */
const idp = (id: string, extra: Record<string, unknown> = {}) => ({
  id, principalId: "agent-1", kind: "idp", idpProvider: "github", idpSubject: "alice", status: "active", ...extra,
});
const entry = (operation: string, user: string | undefined, ts: number, record: Record<string, unknown> | null): CredentialAuditEntry =>
  ({ operation, user_name: user, timestamp: ts, records: record ? [record] : [] });
/** The finding for one stored row with these audit entries. */
const findingFor = (entries: CredentialAuditEntry[], row: Record<string, unknown> = idp("c1")) =>
  describeIdpMappingWriters([row as any], { [String(row.id)]: entries });
const TARGET = { opsUrl: "http://127.0.0.1:9925/", adminUser: "admin" };

describe("classifyIdpMappingHistory — a retained history that shows the row's creation", () => {
  it("lists a mapping a non-admin agent inserted", () => {
    expect(classifyIdpMappingHistory("c1", [entry("insert", AGENT, T0, idp("c1"))])).toBe("non-admin-write");
  });

  it("clears a mapping an administrator inserted that its owner then relabelled and revoked", () => {
    expect(classifyIdpMappingHistory("c1", [
      entry("insert", "admin", T0, idp("c1")),
      entry("patch", AGENT, T0 + 1, idp("c1", { label: "laptop", updatedAt: "x" })),
      entry("patch", AGENT, T0 + 2, idp("c1", { label: "laptop", updatedAt: "x", status: "revoked" })),
    ])).toBe("no-non-admin-write");
  });

  it("lists a non-admin change of a mapping field, judged against the entry before it", () => {
    for (const change of [{ idpSubject: "mallory" }, { idpProvider: "other" }, { principalId: "agent-2" }, { kind: "bearer-token" }]) {
      expect(classifyIdpMappingHistory("c1", [entry("insert", "admin", T0, idp("c1")), entry("patch", AGENT, T0 + 1, idp("c1", change))]), JSON.stringify(change))
        .toBe("non-admin-write");
    }
  });

  it("lists a non-admin reactivating a mapping an administrator revoked", () => {
    expect(classifyIdpMappingHistory("c1", [
      entry("insert", "admin", T0, idp("c1")),
      entry("update", "admin", T0 + 1, idp("c1", { status: "revoked" })),
      entry("patch", AGENT, T0 + 2, idp("c1", { status: "active" })),
    ])).toBe("non-admin-write");
  });

  it("lists a non-admin turning its own credential into a mapping", () => {
    expect(classifyIdpMappingHistory("c1", [
      entry("insert", AGENT, T0, idp("c1", { kind: "bearer-token" })),
      entry("patch", AGENT, T0 + 1, idp("c1")),
    ])).toBe("non-admin-write");
  });

  it("takes a write after a recorded delete as the row's creation, and starts its history over", () => {
    expect(classifyIdpMappingHistory("c1", [entry("delete", "admin", T0, null), entry("upsert", "admin", T0 + 1, idp("c1"))])).toBe("no-non-admin-write");
    expect(classifyIdpMappingHistory("c1", [
      entry("insert", "admin", T0, idp("c1")),
      entry("delete", "admin", T0 + 1, { id: "c1" }),
      entry("upsert", AGENT, T0 + 2, idp("c1")),
    ])).toBe("non-admin-write");
    // A non-admin change before the delete no longer decides the re-created row.
    expect(classifyIdpMappingHistory("c1", [
      entry("insert", "admin", T0, idp("c1")),
      entry("patch", AGENT, T0 + 1, idp("c1", { idpSubject: "mallory" })),
      entry("delete", "admin", T0 + 2, { id: "c1" }),
      entry("upsert", "admin", T0 + 3, idp("c1")),
    ])).toBe("no-non-admin-write");
  });

  it("replays entries in timestamp order", () => {
    expect(classifyIdpMappingHistory("c1", [
      entry("patch", AGENT, T0 + 1, idp("c1", { label: "x" })),
      entry("insert", "admin", T0, idp("c1")),
    ])).toBe("no-non-admin-write");
  });
});

describe("classifyIdpMappingHistory — a creation stamp: a first retained upsert or put by an administrator or the server", () => {
  const stamped = (extra: Record<string, unknown> = {}) => idp("c1", { createdAt: iso(T0), ...extra });

  it("takes the shapes the linker, the JIT provisioners and the Credential resource write as the creation", () => {
    // Admin REST POST/PUT and /mcp JIT: createdAt is the server's time, no lastUsedAt.
    expect(classifyIdpMappingHistory("c1", [entry("upsert", "admin", T0 + 1, stamped())])).toBe("no-non-admin-write");
    expect(classifyIdpMappingHistory("c1", [entry("upsert", undefined, T0 + 4, stamped())])).toBe("no-non-admin-write");
    // Linker and XAA JIT: lastUsedAt is the same value as createdAt.
    expect(classifyIdpMappingHistory("c1", [entry("upsert", "admin", T0 + 6, stamped({ lastUsedAt: iso(T0) }))])).toBe("no-non-admin-write");
    // An operations-API put.
    expect(classifyIdpMappingHistory("c1", [entry("put", "admin", T0 + 1, stamped())])).toBe("no-non-admin-write");
  });

  it("accepts a createdAt within the tolerance of the entry, and not beyond it", () => {
    expect(classifyIdpMappingHistory("c1", [entry("upsert", "admin", T0 + CREATION_STAMP_TOLERANCE_MS, stamped())])).toBe("no-non-admin-write");
    expect(classifyIdpMappingHistory("c1", [entry("upsert", "admin", T0 + CREATION_STAMP_TOLERANCE_MS + 1, stamped())])).toBe("unattributed");
    expect(classifyIdpMappingHistory("c1", [entry("upsert", "admin", T0 - CREATION_STAMP_TOLERANCE_MS - 1, stamped())])).toBe("unattributed");
    expect(classifyIdpMappingHistory("c1", [entry("upsert", "admin", T0, idp("c1", { createdAt: "not a time" }))])).toBe("unattributed");
  });

  it("does not take the server's use stamps on an existing row as a creation", () => {
    // XAA: a put that keeps the stored createdAt and sets a new lastUsedAt.
    expect(classifyIdpMappingHistory("c1", [entry("upsert", "admin", T0 + 10, stamped({ lastUsedAt: iso(T0 + 10) }))])).toBe("unattributed");
    // /mcp: a patch.
    expect(classifyIdpMappingHistory("c1", [entry("patch", undefined, T0 + 40, stamped({ lastUsedAt: iso(T0 + 40) }))])).toBe("unattributed");
  });

  it("does not take a merge (a patch) as a creation stamp, even with a fresh createdAt", () => {
    expect(classifyIdpMappingHistory("c1", [entry("patch", "admin", T0 + 5, stamped())])).toBe("unattributed");
    expect(classifyIdpMappingHistory("c1", [entry("patch", undefined, T0 + 5, stamped())])).toBe("unattributed");
  });

  it("never takes an entry by the non-admin agent user as a creation stamp", () => {
    for (const operation of ["upsert", "put"]) {
      const first = entry(operation, AGENT, T0 + 1, stamped());
      expect(classifyIdpMappingHistory("c1", [first]), operation).toBe("unattributed");
      expect(findingFor([first]).nonAdmin).toEqual([]);
    }
  });

  it("only upgrades a first retained entry: an upsert on a known row is judged as a change", () => {
    expect(classifyIdpMappingHistory("c1", [
      entry("insert", "admin", T0 - 5, idp("c1")),
      entry("patch", AGENT, T0 - 4, idp("c1", { idpSubject: "mallory" })),
      entry("upsert", "admin", T0 + 1, stamped({ idpSubject: "mallory" })),
    ])).toBe("non-admin-write");
  });
});

describe("classifyIdpMappingHistory — an administrator's re-stamp (operations-API update of createdAt)", () => {
  const restamp = (ts: number, extra: Record<string, unknown> = {}) => entry("update", "admin", ts, idp("c1", { createdAt: iso(ts), ...extra }));

  it("starts the row's history over after an unknown first entry or a non-admin write", () => {
    expect(classifyIdpMappingHistory("c1", [entry("patch", AGENT, T0, idp("c1", { label: "x" })), restamp(T0 + 100)])).toBe("no-non-admin-write");
    expect(classifyIdpMappingHistory("c1", [
      entry("insert", "admin", T0, idp("c1")),
      entry("patch", AGENT, T0 + 1, idp("c1", { idpSubject: "mallory" })),
      restamp(T0 + 100, { idpSubject: "mallory" }),
    ])).toBe("no-non-admin-write");
  });

  it("is not a re-stamp when made by the non-admin agent user, or with a createdAt outside the tolerance", () => {
    const first = entry("patch", AGENT, T0, idp("c1", { label: "x" }));
    expect(classifyIdpMappingHistory("c1", [first, entry("update", AGENT, T0 + 100, idp("c1", { createdAt: iso(T0 + 100) }))])).toBe("unattributed");
    expect(classifyIdpMappingHistory("c1", [first, entry("update", "admin", T0 + 100, idp("c1", { createdAt: iso(T0 - CREATION_STAMP_TOLERANCE_MS) }))])).toBe("unattributed");
  });
});

describe("classifyIdpMappingHistory — a retained history that does not show the row's creation", () => {
  it("does not list an owner's relabel or update that is the first retained entry; the row is unattributed", () => {
    // The creation expired: the first retained entry carries the whole row, and
    // nothing says what the row was before it.
    for (const first of [
      entry("patch", AGENT, T0, idp("c1", { label: "laptop" })),
      entry("upsert", AGENT, T0, idp("c1", { label: "laptop" })),
      entry("patch", AGENT, T0, idp("c1", { status: "revoked", label: "x" })),
    ]) {
      expect(classifyIdpMappingHistory("c1", [first]), String(first.operation)).toBe("unattributed");
      const finding = findingFor([first]);
      expect(finding.nonAdmin).toEqual([]);
    }
    expect(findingFor([entry("patch", AGENT, T0, idp("c1", { label: "laptop" }))]).unattributed).toEqual(["c1"]);
  });

  it("does not clear a row whose first retained entry is an administrator's write with no creation stamp", () => {
    for (const operation of ["upsert", "patch", "update", "put"]) {
      expect(classifyIdpMappingHistory("c1", [entry(operation, "admin", T0, idp("c1"))]), operation).toBe("unattributed");
    }
  });

  it("still lists a later non-admin change whose prior row is retained", () => {
    expect(classifyIdpMappingHistory("c1", [
      entry("upsert", "admin", T0, idp("c1")),
      entry("update", AGENT, T0 + 1, idp("c1", { idpSubject: "mallory" })),
    ])).toBe("non-admin-write");
  });

  it("makes a row with no retained entry, or an entry with no row image, unattributed", () => {
    expect(classifyIdpMappingHistory("c1", [])).toBe("unattributed");
    expect(findingFor([]).unattributed).toEqual(["c1"]);
    expect(classifyIdpMappingHistory("c1", [entry("insert", "admin", T0, idp("c1")), entry("patch", AGENT, T0 + 1, null)])).toBe("unattributed");
    // The write after an imageless entry has no known prior row, so it is not judged either.
    expect(classifyIdpMappingHistory("c1", [
      entry("insert", "admin", T0, idp("c1")),
      entry("patch", AGENT, T0 + 1, null),
      entry("patch", AGENT, T0 + 2, idp("c1", { idpSubject: "mallory" })),
    ])).toBe("unattributed");
    expect(classifyIdpMappingHistory("c1", [entry("insert", "admin", T0, idp("c1")), entry("delete", "admin", T0 + 1, null)])).toBe("unattributed");
  });
});

describe("describeIdpMappingWriters / idpMappingWriterReport", () => {
  it("checks only active mappings: a revoked row, or one naming no principal, is neither listed nor unattributed", () => {
    for (const row of [idp("c1", { status: "revoked" }), idp("c1", { principalId: "" }), idp("c1", { status: undefined })]) {
      const finding = findingFor([entry("insert", AGENT, T0, idp("c1"))], row);
      expect(finding.nonAdmin, JSON.stringify(row)).toEqual([]);
      expect(finding.unattributed, JSON.stringify(row)).toEqual([]);
      expect(finding.active).toBe(0);
      expect(finding.total).toBe(1);
    }
  });

  it("lists the non-admin mappings and the unattributed rows, sorted, each a finding with its commands", () => {
    const rows = [idp("c3"), idp("c1"), idp("c2", { principalId: "agent-2", idpProvider: "okta" }), idp("c4"), idp("c5"), idp("c6", { status: "revoked" })];
    const finding = describeIdpMappingWriters(rows, {
      c1: [entry("insert", AGENT, T0, idp("c1"))],
      c2: [entry("insert", AGENT, T0, idp("c2", { principalId: "agent-2", idpProvider: "okta" }))],
      c3: [entry("insert", "admin", T0, idp("c3"))],
      c5: [entry("upsert", "admin", T0, idp("c5"))],
    });
    expect(finding.total).toBe(6);
    expect(finding.active).toBe(5);
    expect(finding.nonAdmin).toEqual([
      { id: "c1", principalId: "agent-1", idpProvider: "github" },
      { id: "c2", principalId: "agent-2", idpProvider: "okta" },
    ]);
    expect(finding.unattributed).toEqual(["c4", "c5"]);
    const report = idpMappingWriterReport(finding, TARGET);
    expect(report.clear).toBeNull();
    expect(report.findings.length).toBe(2);
    const [nonAdmin, unattributed] = report.findings;
    expect(nonAdmin.warn).toContain("2 IdP mapping row(s) written by a non-admin agent (from the audit log)");
    expect(nonAdmin.warn).toContain("c1 (principal 'agent-1', provider 'github')");
    expect(nonAdmin.fix.join("\n")).toContain('{"id":"c1","status":"revoked"}');
    expect(unattributed.warn).toContain("2 IdP mapping row(s) cannot be attributed");
    expect(unattributed.warn).toContain("c4, c5");
    expect(unattributed.fix.join("\n")).toContain('{"id":"c4","createdAt":"');
    for (const f of report.findings) {
      expect(f.fix.join("\n")).toContain("curl -su admin ");
      expect(f.fix.at(-1)).toContain("Doctor changed nothing");
      expect(f.warn + f.fix.join("\n")).not.toContain("alice"); // no subject in the report
    }
  });

  it("prints commands whose bodies are the operations-API calls that re-stamp, revoke and read the rows", () => {
    const commands = idpMappingRemedyCommands(["c1", "c2"], TARGET)!;
    const body = (command: string) => {
      const m = command.match(/ -d '(.*)'$/s);
      expect(m, command).not.toBeNull();
      // The shell substitutes the current time where the body leaves the single quotes.
      return JSON.parse(m![1].replaceAll(`'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'`, "2026-10-01T00:00:00Z"));
    };
    for (const c of [commands.review, commands.restamp, commands.revoke]) expect(c.startsWith("curl -su admin -H 'Content-Type: application/json' http://127.0.0.1:9925/ -d '")).toBe(true);
    expect(body(commands.restamp)).toEqual({ operation: "update", database: "flair", table: "Credential", records: [{ id: "c1", createdAt: "2026-10-01T00:00:00Z" }, { id: "c2", createdAt: "2026-10-01T00:00:00Z" }] });
    expect(body(commands.revoke)).toEqual({ operation: "update", database: "flair", table: "Credential", records: [{ id: "c1", status: "revoked" }, { id: "c2", status: "revoked" }] });
    expect(body(commands.review).conditions.map((c: any) => c.search_value)).toEqual(["c1", "c2"]);
  });

  it("leaves an id with other characters out of the commands, and prints no command for an unsafe user", () => {
    const commands = idpMappingRemedyCommands(["c1", "x';touch y'"], TARGET)!;
    expect(commands.omitted).toBe(1);
    expect(commands.restamp).not.toContain("touch");
    expect(idpMappingRemedyCommands(["c1"], { ...TARGET, adminUser: "a b" })).toBeNull();
    expect(idpMappingRemedyCommands(["x y"], TARGET)).toBeNull();
  });

  it("reports unattributed rows as a finding, never as a clear result", () => {
    const report = idpMappingWriterReport(describeIdpMappingWriters([idp("c1")], {}), TARGET);
    expect(report.clear).toBeNull();
    expect(report.findings.map((f) => f.warn)).toEqual([expect.stringContaining("1 IdP mapping row(s) cannot be attributed")]);
  });

  it("names at most ten unattributed rows and counts the rest", () => {
    const rows = Array.from({ length: 12 }, (_, i) => idp(`c${String(i).padStart(2, "0")}`));
    const [line] = idpMappingWriterReport(describeIdpMappingWriters(rows, {}), TARGET).findings;
    expect(line.warn).toContain("12 IdP mapping row(s) cannot be attributed");
    expect(line.warn).toContain("c09 and 2 more");
    expect(line.warn).not.toContain("c10");
  });

  it("is clear only when every active row's history shows its creation and no non-admin mapping write", () => {
    const report = idpMappingWriterReport(describeIdpMappingWriters([idp("c1"), idp("c2", { status: "revoked" })], { c1: [entry("insert", "admin", T0, idp("c1"))] }), TARGET);
    expect(report.findings).toEqual([]);
    expect(report.clear).toContain("(1 active of 2 stored)");
    expect(report.note).toContain("flair-agent");
    expect(idpMappingWriterReport(describeIdpMappingWriters([idp("c2", { status: "revoked" })], {}), TARGET).clear)
      .toBe("No active IdP mapping rows (1 stored, none active).");
  });
});

describe("the ops-API reads", () => {
  const ok = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("readIdpMappingRows returns idp rows, and null on a failed or malformed read", async () => {
    const calls: any[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify([idp("c1"), { id: "c2", kind: "bearer-token" }, { kind: "idp" }]), { status: 200 });
    }) as typeof fetch;
    const rows = await readIdpMappingRows({ opsUrl: "http://127.0.0.1:1/", authHeader: "Basic x", fetchImpl });
    expect(rows?.map((r) => r.id)).toEqual(["c1"]);
    expect(calls[0]).toMatchObject({ operation: "search_by_value", table: "Credential", search_attribute: "kind", search_value: "idp" });
    expect(await readIdpMappingRows({ opsUrl: "x", authHeader: "y", fetchImpl: ok({ error: "no" }, 500) })).toBeNull();
    expect(await readIdpMappingRows({ opsUrl: "x", authHeader: "y", fetchImpl: ok({ rows: [] }) })).toBeNull();
  });

  it("readCredentialAudit batches ids, maps absent ids to no entries, and names an off or failed audit log", async () => {
    const batches: string[][] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      batches.push(body.search_values);
      return new Response(JSON.stringify({ [body.search_values[0]]: [entry("upsert", AGENT, 1, {})] }), { status: 200 });
    }) as typeof fetch;
    const ids = Array.from({ length: 150 }, (_, i) => `c${i}`);
    const read = await readCredentialAudit({ opsUrl: "x", authHeader: "y", ids, fetchImpl });
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.byId.c0.length).toBe(1);
      expect(read.byId.c1).toEqual([]);
      expect(read.byId.c100.length).toBe(1);
    }
    expect(await readCredentialAudit({ opsUrl: "x", authHeader: "y", ids: ["c1"], fetchImpl: ok({ error: "audit off" }, 400) })).toEqual({ kind: "disabled" });
    expect(await readCredentialAudit({ opsUrl: "x", authHeader: "y", ids: ["c1"], fetchImpl: ok({}, 500) })).toEqual({ kind: "failed" });
    expect(await readCredentialAudit({ opsUrl: "x", authHeader: "y", ids: ["c1"], fetchImpl: ok([]) })).toEqual({ kind: "failed" });
  });
});
