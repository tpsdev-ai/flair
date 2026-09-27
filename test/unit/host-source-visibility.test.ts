/**
 * host-source-visibility.test.ts — flair#1940 slice 1 (A3). The read
 * projection: the pointer is content, never wider than its record. Both
 * directions (opted in / not opted in) plus the widening rule, the withheld
 * literal, and the URL query/fragment strip. Also a drift tripwire asserting
 * every read surface wires the projection (source-text scan, the same idiom as
 * the record-types registry tripwire).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_SOURCE_WITHHELD,
  hostSourceAuthor,
  narrowerVisibility,
  projectHostSource,
  projectHostSourceResult,
  renderHostSourceUrl,
} from "../../resources/host-source-visibility.ts";

const ROOT = join(import.meta.dir, "../..");
const POINTER = '{"v":1,"host":"openclaw","kind":"run","id":"run-aaaaaaaa"}';

function prov(agentId: string | null): string {
  return JSON.stringify({ v: 1, verified: { agentId, timestamp: "2026-01-01T00:00:00.000Z", receivedAt: "2026-01-01T00:00:00.000Z" } });
}

/** A record as it would be stored: author "agent-a". */
function record(extra: Record<string, unknown> = {}): any {
  return {
    agentId: "agent-a",
    visibility: "shared",
    provenance: prov("agent-a"),
    hostSource: POINTER,
    ...extra,
  };
}

describe("A3 — the read projection, both directions", () => {
  test("not opted in: the author sees the pointer", () => {
    const out = projectHostSource(record(), "agent-a");
    expect(out.hostSource).toBe(POINTER); // assertion: author gets the pointer
  });

  test("not opted in: another reader gets 'withheld'", () => {
    const out = projectHostSource(record(), "agent-b");
    expect(out.hostSource).toBe(HOST_SOURCE_WITHHELD); // assertion: withheld
  });

  test("opted in (shared at write): a reader of the record gets the pointer", () => {
    const out = projectHostSource(record({ hostSourceVisibility: "shared" }), "agent-b");
    expect(out.hostSource).toBe(POINTER); // assertion: opted in → reader sees it
  });

  test("opted in but private at write: another reader still gets 'withheld'", () => {
    const out = projectHostSource(record({ hostSourceVisibility: "private" }), "agent-b");
    expect(out.hostSource).toBe(HOST_SOURCE_WITHHELD); // assertion
  });

  test("widening the record AFTER the write does NOT widen the pointer", () => {
    // Opted in when the record was private; the record is later widened to
    // shared. The stored write-time value (private) is narrower → withheld.
    const widened = record({ hostSourceVisibility: "private", visibility: "shared" });
    expect(projectHostSource(widened, "agent-b").hostSource).toBe(HOST_SOURCE_WITHHELD); // assertion
    // And narrowing after a shared opt-in narrows the pointer too.
    const narrowed = record({ hostSourceVisibility: "shared", visibility: "private" });
    expect(projectHostSource(narrowed, "agent-b").hostSource).toBe(HOST_SOURCE_WITHHELD); // assertion
  });

  test("a record with no hostSource is unchanged (null stays null)", () => {
    const noPointer = record({ hostSource: null });
    const out = projectHostSource(noPointer, "agent-b");
    expect(out.hostSource).toBeNull(); // assertion: untouched
  });

  test("a URL renders as scheme/host/path only (query + fragment stripped)", () => {
    const stored = '{"v":1,"host":"cursor","kind":"launch","id":"x","url":"https://example.test/a/b?tok=secret#frag"}';
    const out = projectHostSource(record({ hostSource: stored, hostSourceVisibility: "shared" }), "agent-b");
    expect(out.hostSource).toBe('{"v":1,"host":"cursor","kind":"launch","id":"x","url":"https://example.test/a/b"}'); // assertion
    expect(out.hostSource).not.toContain("secret");
    expect(out.hostSource).not.toContain("#frag");
  });

  test("the author id is read from provenance, never the record's agentId field", () => {
    // agentId says one thing, provenance says another (a forged field): the
    // server-stamped provenance author decides.
    const forged = { agentId: "agent-b", visibility: "shared", provenance: prov("agent-a"), hostSource: POINTER };
    expect(hostSourceAuthor(forged)).toBe("agent-a"); // assertion
    expect(projectHostSource(forged, "agent-b").hostSource).toBe(HOST_SOURCE_WITHHELD); // b is not the author
  });

  test("narrowerVisibility: private wins", () => {
    expect(narrowerVisibility("shared", "private")).toBe("private");
    expect(narrowerVisibility(null, "shared")).toBe("shared");
    expect(narrowerVisibility("private", "private")).toBe("private");
  });

  test("renderHostSourceUrl strips query + fragment", () => {
    expect(renderHostSourceUrl("https://h.test/a/b?x=1#y")).toBe("https://h.test/a/b");
    expect(renderHostSourceUrl("not-a-url")).toBe("not-a-url");
  });

  test("projectHostSourceResult maps an async iterable", async () => {
    const src = (async function* () {
      yield record();
      yield record({ hostSourceVisibility: "shared" });
    })();
    const seen: any[] = [];
    for await (const row of projectHostSourceResult(src, "agent-b")) seen.push(row);
    expect(seen.map((r) => r.hostSource)).toEqual([HOST_SOURCE_WITHHELD, POINTER]); // assertion
  });
});

describe("A3 drift tripwire — every read surface wires the projection", () => {
  const surfaces: Array<[string, RegExp]> = [
    ["resources/Memory.ts", /projectHostSource(Result)?\s*\(/], // search() + get()
    ["resources/SemanticSearch.ts", /projectHostSource\s*\(/],
    ["resources/MemoryBootstrap.ts", /projectHostSource\s*\(/],
  ];
  for (const [file, re] of surfaces) {
    test(`${file} calls the projection`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(re.test(src)).toBe(true); // assertion: wired
    });
  }
});
