/**
 * host-source-visibility.test.ts — flair#1940 slice 1 (A3, A1'). The pure
 * read projection: the pointer is content, never wider than its record. After
 * A1' the pointer is a MemoryHostSource ROW, passed to the projection by the
 * caller (the join reads the row, the projection decides). Both directions
 * (opted in / not opted in), the widening rule, the withheld literal, the URL
 * query/fragment strip, and the three outcomes (pointer | "withheld" | none).
 */
import { describe, expect, test } from "bun:test";
import {
  HOST_SOURCE_WITHHELD,
  narrowerVisibility,
  pointerOutcomeFor,
  projectHostSource,
  renderHostSourceUrl,
  type PointerRow,
} from "../../resources/host-source-visibility.ts";

const POINTER = '{"v":1,"host":"openclaw","kind":"run","id":"run-aaaaaaaa"}';
const POINTER_OBJ = { v: 1, host: "openclaw", kind: "run", id: "run-aaaaaaaa" } as const;

function prov(agentId: string | null): string {
  return JSON.stringify({ v: 1, verified: { agentId, timestamp: "2026-01-01T00:00:00.000Z", receivedAt: "2026-01-01T00:00:00.000Z" } });
}

/** A record as it would be stored: author "agent-a". */
function record(extra: Record<string, unknown> = {}): any {
  return {
    agentId: "agent-a",
    visibility: "shared",
    instanceToken: "tok-1",
    provenance: prov("agent-a"),
    ...extra,
  };
}

/** A MemoryHostSource row. */
function pointer(extra: Partial<PointerRow> = {}): PointerRow {
  return { memoryId: "mem-1", hostSource: POINTER, scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: "tok-1", ...extra };
}

describe("A3 — the read projection, both directions", () => {
  test("not opted in: the author sees the pointer", () => {
    const out = projectHostSource(record(), "agent-a", pointer());
    expect(out.hostSource).toEqual(POINTER_OBJ); // assertion: author gets the validated object
  });

  test("not opted in: another reader gets 'withheld'", () => {
    const out = projectHostSource(record(), "agent-b", pointer());
    expect(out.hostSource).toBe(HOST_SOURCE_WITHHELD); // assertion: withheld
  });

  test("opted in (shared at write): a reader of the record gets the pointer", () => {
    const out = projectHostSource(record({ visibility: "shared" }), "agent-b", pointer({ scopeAtWrite: "shared" }));
    expect(out.hostSource).toEqual(POINTER_OBJ); // assertion: opted in → reader sees it
  });

  test("opted in but private at write: another reader still gets 'withheld'", () => {
    const out = projectHostSource(record({ visibility: "shared" }), "agent-b", pointer({ scopeAtWrite: "private" }));
    expect(out.hostSource).toBe(HOST_SOURCE_WITHHELD); // assertion
  });

  test("widening the record AFTER the write does NOT widen the pointer", () => {
    // Opted in when the record was private; the record is later widened to
    // shared. The stored write-time value (private) is narrower → withheld.
    expect(projectHostSource(record({ visibility: "shared" }), "agent-b", pointer({ scopeAtWrite: "private" })).hostSource).toBe(HOST_SOURCE_WITHHELD); // assertion
    // And narrowing after a shared opt-in narrows the pointer too.
    expect(projectHostSource(record({ visibility: "private" }), "agent-b", pointer({ scopeAtWrite: "shared" })).hostSource).toBe(HOST_SOURCE_WITHHELD); // assertion
  });

  test("no pointer row → the record is unchanged (no hostSource key added)", () => {
    const out = projectHostSource(record(), "agent-b", null);
    expect("hostSource" in (out as any)).toBe(false); // assertion: untouched
    expect(pointerOutcomeFor(record(), "agent-b", null)).toBe("none"); // assertion: "nothing"
  });

  test("a URL renders as scheme/host/path only (query + fragment stripped)", () => {
    const stored = '{"v":1,"host":"cursor","kind":"launch","id":"x","url":"https://example.test/a/b?tok=secret#frag"}';
    const out = projectHostSource(record({ visibility: "shared" }), "agent-b", pointer({ hostSource: stored, scopeAtWrite: "shared" }));
    expect(out.hostSource).toEqual({ v: 1, host: "cursor", kind: "launch", id: "x", url: "https://example.test/a/b" }); // assertion
    expect(JSON.stringify(out.hostSource)).not.toContain("secret");
    expect(JSON.stringify(out.hostSource)).not.toContain("#frag");
  });

  test("the author id is the POINTER row's authorId, never Memory provenance", () => {
    // A1'' item 4: the pointer row's authorId is server-stamped at Memory write
    // time; the projection compares the reader with THAT. Provenance (which a
    // default SemanticSearch select omits) is irrelevant to the join.
    const forged: any = { agentId: "agent-b", visibility: "shared", instanceToken: "tok-1", provenance: prov("agent-a") };
    // provenance says agent-a, the pointer row says agent-b: the pointer wins
    // (the token matches and authorId === agentId).
    expect(projectHostSource(forged, "agent-b", pointer({ authorId: "agent-b" })).hostSource).toEqual(POINTER_OBJ); // assertion: b IS the pointer author
    expect(projectHostSource(forged, "agent-a", pointer({ authorId: "agent-b" })).hostSource).toBe(HOST_SOURCE_WITHHELD); // assertion: a is not
  });

  test("narrowerVisibility: private wins", () => {
    expect(narrowerVisibility("shared", "private")).toBe("private"); // assertion
    expect(narrowerVisibility("private", undefined)).toBe("private"); // assertion
    expect(narrowerVisibility("shared", undefined)).toBe("shared"); // assertion
    // A null scopeAtWrite is not "private" here — it is handled by the caller
    // (author-only); narrowerVisibility itself only compares known visibilities.
  });

  test("renderHostSourceUrl strips query/fragment; a non-URL passes through", () => {
    expect(renderHostSourceUrl("https://h.test/a/b?x=1#y")).toBe("https://h.test/a/b"); // assertion
    expect(renderHostSourceUrl("not a url")).toBe("not a url"); // assertion
  });
});
