/**
 * federation-memory-whitelist-1940.test.ts — flair#1940 slice 1, A1'' item 8.
 *
 * Both federation directions must apply the SAME declared-attribute whitelist
 * the Memory writers apply, so a dirty row cannot carry a pointer field
 * (`hostSource` / `hostSourceScope` / `hostSourceVisibility`) either way: the
 * outbound read projects the whitelist (f1-out, in
 * test/unit/federation-sync-push-privacy.test.ts), and the inbound merge
 * strips it (f1-in, here).
 */
import { describe, it, expect } from "bun:test";
import { FEDERATION_MEMORY_ATTRIBUTES } from "../../src/lib/federation-memory-attributes";
import {
  DECLARED_MEMORY_ATTRIBUTES,
  UNDECLARED_ALLOWED,
  stripInboundMemoryRow,
} from "../../resources/memory-declared-attributes";

describe("flair#1940 A1'' item 8 — the federation Memory whitelist", () => {
  it("(f1-in) an inbound dirty Memory row's pointer field is stripped; bookkeeping survives", () => {
    const row: any = {
      id: "m",
      agentId: "a",
      content: "x",
      hostSource: '{"v":1,"host":"openclaw","kind":"run","id":"run-aaaaaaaa"}',
      hostSourceScope: "record",
      hostSourceVisibility: "shared",
      undeclaredProbe: "SENTINEL",
      _syncedFrom: "peer-1",
      _syncedAt: "2026-01-01T00:00:00.000Z",
      _originatorInstanceId: "inst-orig",
      meta: { seq: 1 },
      kind: "session",
    };
    const removed = stripInboundMemoryRow(row);
    expect(row.hostSource).toBeUndefined(); // assertion: the pointer field is stripped
    expect(row.hostSourceScope).toBeUndefined(); // assertion: the pointer scope is stripped
    expect(row.hostSourceVisibility).toBeUndefined(); // assertion: the forged stamp is stripped
    expect(row.undeclaredProbe).toBeUndefined(); // assertion: any other undeclared key is stripped
    expect(removed).toContain("hostSource"); // assertion: the removal is reported
    expect(row._syncedFrom).toBe("peer-1"); // assertion: federation bookkeeping survives
    expect(row._syncedAt).toBe("2026-01-01T00:00:00.000Z"); // assertion
    expect(row._originatorInstanceId).toBe("inst-orig"); // assertion
    expect(row.meta).toEqual({ seq: 1 }); // assertion: the named `meta` survives
    expect(row.kind).toBe("session"); // assertion: the named `kind` survives
  });

  it("(f1-drift) the outbound whitelist equals the writers' declared + named lists", () => {
    expect([...FEDERATION_MEMORY_ATTRIBUTES].sort()).toEqual(
      [...DECLARED_MEMORY_ATTRIBUTES, ...UNDECLARED_ALLOWED].sort(),
    ); // assertion: the CLI mirror and the resource whitelist cannot drift
  });
});
