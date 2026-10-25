/**
 * record-id-path.test.ts — the shared id-path helper (flair#1970).
 *
 * `encodeRecordId` is what every CLI site builds a record path with. The
 * contract: the id is ONE path segment, and that segment decodes back to the
 * id — for every RFC 3986 reserved character, plus `%` and space. `.` and `..` are
 * refused, because URL normalization collapses them and no request could
 * address the record.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeRecordId, recordIdPath } from "../../src/lib/record-id-path.js";
import { applySnapshot, type ApiCall } from "../../src/rem/restore.js";
import { createSnapshot } from "../../src/rem/snapshot.js";

// RFC 3986 reserved characters, plus percent and a space.
const RESERVED = ":/?#[]@!$&'()*+,;=";
const RAW_ID = `rec${RESERVED}% w`;

describe("flair#1970: encodeRecordId keeps an id ONE path segment", () => {
  test("an id with every RFC 3986 reserved character becomes one segment that decodes back to it", () => {
    const path = recordIdPath("Memory", RAW_ID);
    const segments = path.split("/");
    expect(segments).toHaveLength(3); // "", collection, id
    expect(segments[1]).toBe("Memory");
    expect(segments[2]).not.toContain("/");
    expect(decodeURIComponent(segments[2])).toBe(RAW_ID);
  });

  for (const ch of [...RESERVED, "%", " "]) {
    test(`keeps ${JSON.stringify(ch)} inside the single id segment`, () => {
      const id = `a${ch}b`;
      const segment = encodeRecordId(id);
      // Some reserved characters are safe within a path segment and remain literal.
      // The whole id must still decode exactly and occupy one segment.
      expect(segment.split("/")).toHaveLength(1);
      expect(decodeURIComponent(segment)).toBe(id);
      const path = new URL(`/Memory/${segment}`, "http://example.test").pathname;
      expect(path.split("/")).toHaveLength(3);
      expect(decodeURIComponent(path.split("/")[2])).toBe(id);
    });
  }

  test("refuses a dot-segment id rather than sending a normalized path", () => {
    for (const id of [".", ".."]) {
      expect(() => encodeRecordId(id)).toThrow(/dot-segment/);
    }
  });
});

test("restore's Memory, Soul and MemoryCandidate record requests encode the id", async () => {
  const root = mkdtempSync(join(tmpdir(), "flair-1970-restore-path-"));
  try {
    const calls: Array<{ method: string; path: string }> = [];
    const currentMemory = { id: RAW_ID, agentId: "agent-a", content: "current", durability: "persistent" };
    const currentSoul = { id: RAW_ID, agentId: "agent-a", key: "style", value: "current" };
    const snapshotMemory = { id: RAW_ID, agentId: "agent-a", content: "restored", durability: "persistent" };
    const snapshotSoul = { id: RAW_ID, agentId: "agent-a", key: "style", value: "restored" };
    const apiCall: ApiCall = async (method, path, body) => {
      calls.push({ method, path });
      if (method === "GET" && path.startsWith("/Memory?")) return [currentMemory];
      if (method === "GET" && path.startsWith("/Soul?")) return [currentSoul];
      if (method === "GET" && path.startsWith("/AdminMemoryCandidates/")) {
        return { candidates: [{ id: RAW_ID }], hasMore: false };
      }
      if (method === "DELETE" || method === "PUT") return body ?? { ok: true };
      return [];
    };
    const snapshot = await createSnapshot({
      agentId: "agent-a",
      flairVersion: "0.0.0-test",
      memories: [snapshotMemory],
      soul: snapshotSoul,
      pendingCandidateCount: 0,
      rootOverride: join(root, "snapshots"),
    });
    await applySnapshot({
      agentId: "agent-a",
      snapshotPath: snapshot.path,
      flairVersion: "0.0.0-test",
      apiCall,
      preRestoreSnapshotRoot: join(root, "pre"),
      tmpRootOverride: root,
    });

    const encoded = encodeRecordId(RAW_ID);
    const recordCalls = calls.filter((c) => /^\/(Memory|Soul|MemoryCandidate)\//.test(c.path));
    expect(recordCalls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      `DELETE /Memory/${encoded}`,
      `DELETE /MemoryCandidate/${encoded}`,
      `DELETE /Soul/${encoded}`,
      `PUT /Memory/${encoded}`,
      `PUT /Soul/${encoded}`,
    ].sort());
    for (const c of recordCalls) expect(c.path).not.toContain(RAW_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

// Source tripwires for selected CLI record sites supplement the URL behavior
// tests; these sites used direct or missing encoding before this change.
const RECORD_SITES: Array<[string, string]> = [
  ["soul.ts", "const out = await api(\"PUT\", `/Soul/${encodeRecordId(id)}`"],
  ["memory.ts", "const out = await api(\"PUT\", `/Memory/${encodeRecordId(memId)}`, body, { agentId, agentIdSource: source });"],
  ["init.ts", "encodeRecordId(`${agentId}:${key}`)"],
  ["idp.ts", "`/IdpConfig/${encodeRecordId(id)}`"],
  ["import.ts", "encodeRecordId(soul.id)"],
  ["quality.ts", "encodeRecordId(memId)"],
  ["rem.ts", "encodeRecordId(candidateId)"],
  ["federation.ts", "encodeRecordId(p.id)"],
  ["workspace.ts", "encodeRecordId(id)"],
];

test("selected CLI record sites use the shared id helper", () => {
  for (const [file, expression] of RECORD_SITES) {
    const source = readFileSync(new URL(`../../src/commands/${file}`, import.meta.url), "utf8");
    expect(source).toContain(expression);
  }
});

test("federation verify and restore's template-literal record paths interpolate through encodeRecordId", () => {
  const federation = readFileSync(new URL("../../src/federation-verify.ts", import.meta.url), "utf8");
  const restore = readFileSync(new URL("../../src/rem/restore.ts", import.meta.url), "utf8");
  expect(federation).toContain("encodeRecordId(memId)");
  // This source scan matches only template-literal record paths of the form
  // `/Table/${...}` built in restore.ts. A path built by concatenation is not
  // matched here; the request-log test above covers the paths restore sends.
  const recordPaths = [...restore.matchAll(/`\/(Memory|Soul|MemoryCandidate)\/\$\{([^}]*)\}/g)];
  for (const table of ["Memory", "Soul", "MemoryCandidate"]) {
    expect(recordPaths.some((m) => m[1] === table)).toBe(true);
  }
  for (const m of recordPaths) expect(m[2].startsWith("encodeRecordId(")).toBe(true);
});
