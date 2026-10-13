/**
 * idp-mapping-audit.test.ts — `flair doctor`'s read-only check for IdP identity
 * mappings a non-admin agent wrote (src/lib/idp-mapping-audit.ts).
 *
 * The audit entries below have the shape Harper's `read_audit_log` (search by
 * primary key) returns: `{ operation, user_name, timestamp, records: [image] }`,
 * where a REST POST/PUT and an ops-API upsert record "upsert" with the whole
 * row and a REST PATCH records "patch". A verified non-admin agent's REST
 * writes run as `flair-agent`; an admin agent, the ops API and the server's
 * provisioners do not.
 */
import { describe, expect, it } from "bun:test";
import {
  describeIdpMappingWriters,
  idpMappingWriterLines,
  NON_ADMIN_AGENT_HARPER_USER,
  readCredentialAudit,
  readIdpMappingRows,
  writtenByNonAdmin,
  type CredentialAuditEntry,
} from "../../src/lib/idp-mapping-audit";

const AGENT = NON_ADMIN_AGENT_HARPER_USER;
const idp = (id: string, extra: Record<string, unknown> = {}) => ({
  id, principalId: "agent-1", kind: "idp", idpProvider: "github", idpSubject: "alice", status: "active", ...extra,
});
const entry = (operation: string, user: string, ts: number, record: Record<string, unknown>): CredentialAuditEntry =>
  ({ operation, user_name: user, timestamp: ts, records: [record] });

describe("writtenByNonAdmin", () => {
  it("flags a mapping a non-admin agent created", () => {
    expect(writtenByNonAdmin("c1", [entry("upsert", AGENT, 1, idp("c1"))])).toBe(true);
  });

  it("does not flag a mapping an administrator, the ops API or the server created", () => {
    expect(writtenByNonAdmin("c1", [entry("upsert", "admin", 1, idp("c1"))])).toBe(false);
    expect(writtenByNonAdmin("c1", [entry("upsert", "", 1, idp("c1"))])).toBe(false);
  });

  it("does not flag a non-admin relabelling or revoking an administrator's mapping", () => {
    expect(writtenByNonAdmin("c1", [
      entry("upsert", "admin", 1, idp("c1")),
      entry("patch", AGENT, 2, { label: "laptop", updatedAt: "x" }),
      entry("patch", AGENT, 3, { status: "revoked" }),
    ])).toBe(false);
  });

  it("flags a non-admin changing a mapping field of an administrator's mapping", () => {
    for (const change of [{ idpSubject: "mallory" }, { idpProvider: "other" }, { principalId: "agent-2" }]) {
      expect(writtenByNonAdmin("c1", [entry("upsert", "admin", 1, idp("c1")), entry("patch", AGENT, 2, change)])).toBe(true);
    }
  });

  it("flags a non-admin reactivating a mapping an administrator revoked", () => {
    expect(writtenByNonAdmin("c1", [
      entry("upsert", "admin", 1, idp("c1")),
      entry("update", "admin", 2, { id: "c1", status: "revoked" }),
      entry("patch", AGENT, 3, { status: "active" }),
    ])).toBe(true);
  });

  it("flags a non-admin turning its own credential into a mapping", () => {
    expect(writtenByNonAdmin("c1", [
      entry("upsert", AGENT, 1, { id: "c1", principalId: "agent-1", kind: "bearer-token", idpSubject: "alice", status: "active" }),
      entry("patch", AGENT, 2, { kind: "idp" }),
    ])).toBe(true);
  });

  it("judges a partial write with no retained prior state on what it wrote", () => {
    expect(writtenByNonAdmin("c1", [entry("patch", AGENT, 5, { label: "x" })])).toBe(false);
    expect(writtenByNonAdmin("c1", [entry("patch", AGENT, 5, { status: "revoked" })])).toBe(false);
    expect(writtenByNonAdmin("c1", [entry("patch", AGENT, 5, { idpSubject: "mallory" })])).toBe(true);
    expect(writtenByNonAdmin("c1", [entry("patch", AGENT, 5, { status: "active" })])).toBe(true);
  });

  it("replays entries in timestamp order and treats a delete as a fresh start", () => {
    // Out of order: the admin create is first in time, so the later relabel is allowed.
    expect(writtenByNonAdmin("c1", [
      entry("patch", AGENT, 2, { label: "x" }),
      entry("upsert", "admin", 1, idp("c1")),
    ])).toBe(false);
    expect(writtenByNonAdmin("c1", [
      entry("upsert", "admin", 1, idp("c1")),
      entry("delete", "admin", 2, { id: "c1" }),
      entry("upsert", AGENT, 3, idp("c1")),
    ])).toBe(true);
  });
});

describe("describeIdpMappingWriters / idpMappingWriterLines", () => {
  it("lists the non-admin mappings and the unattributed rows, sorted, with the remedy", () => {
    const rows = [idp("c3"), idp("c1"), idp("c2", { principalId: "agent-2", idpProvider: "okta" }), idp("c4")];
    const finding = describeIdpMappingWriters(rows, {
      c1: [entry("upsert", AGENT, 1, idp("c1"))],
      c2: [entry("upsert", AGENT, 1, idp("c2", { principalId: "agent-2", idpProvider: "okta" }))],
      c3: [entry("upsert", "admin", 1, idp("c3"))],
    });
    expect(finding.total).toBe(4);
    expect(finding.nonAdmin).toEqual([
      { id: "c1", principalId: "agent-1", idpProvider: "github" },
      { id: "c2", principalId: "agent-2", idpProvider: "okta" },
    ]);
    expect(finding.unattributed).toEqual(["c4"]);
    const lines = idpMappingWriterLines(finding);
    expect(lines.warn).toContain("2 IdP mapping row(s) written by a non-admin agent (from the audit log)");
    expect(lines.warn).toContain("c1 (principal 'agent-1', provider 'github')");
    expect(lines.warn).not.toContain("alice"); // no subject in the report
    expect(lines.fix).toContain("flair principal unlink");
    expect(lines.fix).toContain("Doctor changed nothing");
    expect(lines.info).toContain("1 IdP mapping row(s) have no retained audit entry");
  });

  it("reports nothing when every mapping has an administrator's history", () => {
    const lines = idpMappingWriterLines(describeIdpMappingWriters([idp("c1")], { c1: [entry("upsert", "admin", 1, idp("c1"))] }));
    expect(lines).toEqual({ warn: null, fix: null, info: null });
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
