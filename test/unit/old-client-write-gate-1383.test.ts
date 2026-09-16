/**
 * old-client-write-gate-1383.test.ts — flair#1383
 *
 * Fails-first fixture for the surviving #985 hazard: a pre-0.18.0
 * flair-client (and the adapters that shipped `dedup: true` into its
 * write()) runs a cosine-only preflight and, on a hit, returns the
 * existing record WITHOUT issuing the PUT. The match can be another
 * agent's `shared` memory. The server never sees the write.
 *
 *   1. The v0.17.0 write() algorithm against a shared-memory hit:
 *      `written: false`, a `mergedWith` id, zero PUTs.
 *   2. Main has no server-side refuse for an identified pre-0.18.0
 *      client on a write path (`refuseStaleClientWrite` / 426).
 *   3. `flair doctor` does not name the silent-drop hazard for a
 *      flair-mcp@0.17.0 pin — only generic staleness, if anything.
 *
 * On origin/main (1) still reproduces; (2) and (3) FAIL because the
 * gate and the doctor line do not exist. On this branch all three PASS.
 */
import { describe, expect, it } from "bun:test";

import {
  FLAIR_CLIENT_VERSION_HEADER,
  MIN_SAFE_FLAIR_CLIENT,
  STALE_CLIENT_ERROR,
  isOldClientWritePreflight,
  isUnsafeClientVersion,
  parseClientVersionToken,
  readDeclaredClientVersion,
  refuseStaleClientWrite,
  staleClientDenialBody,
  stripClientVersionPassthrough,
} from "../../resources/client-version-gate.ts";
import {
  MIN_SAFE_FLAIR_ADAPTER,
  STALE_CLIENT_WRITE_HAZARD,
  isUnsafeAdapterPin,
  unsafeAdapterPinDetail,
} from "../../src/lib/stale-client-pin.ts";

// ─── v0.17.0 write() fixture (packages/flair-client@0.17.0 MemoryApi.write) ─
//
// Copied as a closed algorithm, not imported from current client.ts — current
// write() always PUTs. This is the silent-suppress path the issue observed:
// search(limit:1, scoring:"raw") → on a hit, return the match, never PUT.

interface OldSearchHit {
  id: string;
  score: number;
}

interface OldMemoryRecord {
  id: string;
  agentId: string;
  content: string;
  visibility?: string;
}

async function oldClientWrite(
  content: string,
  opts: { dedup?: boolean; dedupThreshold?: number },
  deps: {
    search: (q: string, searchOpts: { limit: number; minScore: number; scoring: string }) => Promise<OldSearchHit[]>;
    get: (id: string) => Promise<OldMemoryRecord | null>;
    put: (record: Record<string, unknown>) => Promise<void>;
  },
): Promise<Record<string, unknown>> {
  if (opts.dedup && content.length >= 20) {
    const threshold = opts.dedupThreshold ?? 0.95;
    const existing = await deps.search(content, { limit: 1, minScore: threshold, scoring: "raw" });
    if (existing.length > 0) {
      const match = await deps.get(existing[0]!.id);
      if (match) {
        // Adapter layer (flair-mcp@0.17.0 memory_store) then reported
        // written:false / mergedWith — reproduce that caller-visible shape.
        return { ...match, deduped: true, written: false, mergedWith: match.id };
      }
    }
  }
  const id = `writer-${crypto.randomUUID()}`;
  const record = { id, agentId: "writer", content };
  await deps.put(record);
  return { ...record, written: true };
}

describe("flair#1383 — pre-0.18.0 client silently suppresses writes", () => {
  it("old write() returns written:false / mergedWith against another agent's shared memory and never PUTs", async () => {
    const shared: OldMemoryRecord = {
      id: "owner-shared-1",
      agentId: "owner",
      content: "The rotation lock lives in Harper's catalog, not in the app schema.",
      visibility: "shared",
    };
    const puts: Record<string, unknown>[] = [];
    const searches: Array<{ q: string; limit: number; scoring: string; minScore: number }> = [];

    const result = await oldClientWrite(
      "The rotation lock is stored in Harper's catalog, not the application schema.",
      { dedup: true, dedupThreshold: 0.95 },
      {
        search: async (q, searchOpts) => {
          searches.push({ q, limit: searchOpts.limit, scoring: searchOpts.scoring, minScore: searchOpts.minScore });
          return [{ id: shared.id, score: 0.97 }];
        },
        get: async (id) => (id === shared.id ? shared : null),
        put: async (record) => { puts.push(record); },
      },
    );

    expect(searches).toEqual([{
      q: "The rotation lock is stored in Harper's catalog, not the application schema.",
      limit: 1,
      scoring: "raw",
      minScore: 0.95,
    }]);
    expect(isOldClientWritePreflight({ limit: 1, scoring: "raw" })).toBe(true);
    expect(puts).toEqual([]);
    expect(result.written).toBe(false);
    expect(result.mergedWith).toBe("owner-shared-1");
    expect(result.id).toBe("owner-shared-1");
    expect(result.agentId).toBe("owner");
    expect(result.deduped).toBe(true);
  });

  it("old write() does PUT when the preflight misses — the suppress is match-gated, not unconditional", async () => {
    const puts: Record<string, unknown>[] = [];
    const result = await oldClientWrite(
      "A genuinely new finding about an unrelated subsystem, long enough.",
      { dedup: true },
      {
        search: async () => [],
        get: async () => null,
        put: async (record) => { puts.push(record); },
      },
    );
    expect(puts).toHaveLength(1);
    expect(result.written).toBe(true);
    expect(result.mergedWith).toBeUndefined();
  });
});

describe("flair#1383 — server write-path gate (missing on main)", () => {
  it("thresholds: pre-0.18.0 is unsafe; 0.18.0 and current are not; missing is not", () => {
    expect(MIN_SAFE_FLAIR_CLIENT).toBe("0.18.0");
    expect(MIN_SAFE_FLAIR_ADAPTER).toBe("0.18.0");
    expect(isUnsafeClientVersion("0.17.0")).toBe(true);
    expect(isUnsafeClientVersion("0.17.9")).toBe(true);
    expect(isUnsafeClientVersion("0.18.0")).toBe(false);
    expect(isUnsafeClientVersion("0.54.2")).toBe(false);
    expect(isUnsafeClientVersion(null)).toBe(false);
    expect(isUnsafeClientVersion("")).toBe(false);
    expect(isUnsafeClientVersion("not-a-version")).toBe(false);
  });

  it("parses flair-client / flair-mcp / bare tokens", () => {
    expect(parseClientVersionToken("flair-client/0.17.0")).toBe("0.17.0");
    expect(parseClientVersionToken("flair-mcp/0.17.0")).toBe("0.17.0");
    expect(parseClientVersionToken("0.17.0")).toBe("0.17.0");
    expect(parseClientVersionToken("flair-client/not-semver")).toBeNull();
    expect(parseClientVersionToken("")).toBeNull();
  });

  it("reads X-Flair-Client from get() or asObject, header winning over body", () => {
    const req = {
      headers: {
        get: (name: string) => name.toLowerCase() === FLAIR_CLIENT_VERSION_HEADER ? "flair-client/0.17.0" : null,
      },
    };
    expect(readDeclaredClientVersion(req)).toBe("0.17.0");
    expect(readDeclaredClientVersion(
      { headers: { asObject: { "x-flair-client": "flair-mcp/0.16.1" } } },
    )).toBe("0.16.1");
    expect(readDeclaredClientVersion({}, { flairClientVersion: "0.17.0" })).toBe("0.17.0");
    expect(readDeclaredClientVersion(req, { flairClientVersion: "0.99.0" })).toBe("0.17.0");
    expect(readDeclaredClientVersion({}, {})).toBeNull();
  });

  it("refuseStaleClientWrite returns 426 naming the adapter-not-server remedy", async () => {
    const req = {
      headers: {
        get: (name: string) => name.toLowerCase() === "x-flair-client" ? "flair-client/0.17.0" : null,
      },
    };
    const denied = refuseStaleClientWrite(req);
    expect(denied).toBeInstanceOf(Response);
    expect(denied!.status).toBe(426);
    const body = await denied!.json();
    expect(body).toEqual(staleClientDenialBody("0.17.0"));
    expect(body.error).toBe(STALE_CLIENT_ERROR);
    expect(body.message).toContain("silently drops writes");
    expect(body.message).toContain("another agent's shared memories");
    expect(body.message).toContain("Upgrade the adapter, not the server");
    expect(body.message).toContain("flair upgrade");
    expect(body.minimumClientVersion).toBe("0.18.0");
  });

  it("refuseStaleClientWrite serves missing version, 0.18.0, and body-stripped passthrough", () => {
    expect(refuseStaleClientWrite({})).toBeNull();
    expect(refuseStaleClientWrite(undefined)).toBeNull();
    expect(refuseStaleClientWrite({
      headers: { get: () => "flair-client/0.18.0" },
    })).toBeNull();
    const content: Record<string, unknown> = { flairClientVersion: "0.17.0", text: "keep" };
    expect(refuseStaleClientWrite({}, content)).toBeInstanceOf(Response);
    stripClientVersionPassthrough(content);
    expect(content).toEqual({ text: "keep" });
  });

  it("/mcp in-process (x-tps-agent only) and raw HTTP with no version are served", () => {
    // resources/mcp-tools.ts delegationContext: headers.get returns only
    // x-tps-agent. In-process /mcp never sets X-Flair-Client.
    const mcpInProcess = {
      tpsAgent: "agent-1",
      tpsAgentIsAdmin: false,
      headers: {
        get: (k: string) => (k.toLowerCase() === "x-tps-agent" ? "agent-1" : undefined),
      },
    };
    expect(refuseStaleClientWrite(mcpInProcess)).toBeNull();
    // Signed REST: auth middleware stamps tpsAgent. No library version.
    expect(refuseStaleClientWrite({ tpsAgent: "agent-1", tpsAgentIsAdmin: false })).toBeNull();
  });
});

describe("flair#1383 — doctor names the silent-drop hazard for a 0.17 pin", () => {
  it("0.17.0 pins are unsafe; 0.18.0+ and missing are not", () => {
    expect(isUnsafeAdapterPin("0.17.0")).toBe(true);
    expect(isUnsafeAdapterPin("0.18.0")).toBe(false);
    expect(isUnsafeAdapterPin("0.54.2")).toBe(false);
    expect(isUnsafeAdapterPin(null)).toBe(false);
    expect(isUnsafeAdapterPin("latest")).toBe(false);
  });

  it("the doctor detail tells the operator to upgrade the adapter, not the server", () => {
    const detail = unsafeAdapterPinDetail("MCP server", "claude-code", "0.17.0");
    expect(detail).toContain("flair-mcp@0.17.0");
    expect(detail).toContain(STALE_CLIENT_WRITE_HAZARD);
    expect(detail).not.toContain("installed CLI is");
    expect(unsafeAdapterPinDetail("package.json", "cwd", "0.17.0", "flair-client"))
      .toContain("flair-client@0.17.0");
  });
});
