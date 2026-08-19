import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import nacl from "tweetnacl";
import { isPrivateVisibility, PRIVATE_VISIBILITY } from "../../resources/memory-visibility";

/**
 * federation-edge-hardening slice 2 (one rule, one place).
 *
 * The federation-sync PUSH (runFederationSyncOnce in src/cli.ts) pulls every
 * changed Memory row via the admin ops API with get_attributes:["*"] and,
 * before this slice, applied NO visibility filter — so `private` memories
 * were pushed to peer instances. This slice filters them out on the push
 * side, using the SAME "not private" rule as resources/memory-read-scope.ts's
 * resolveReadScope(): exclude ONLY visibility === "private"; a `shared` or
 * null/absent visibility (legacy, pre-dates the field) row must still sync
 * — that migration invariant is the critical regression this file guards.
 *
 * src/cli.ts cannot import resources/memory-visibility.ts directly (proven
 * packaging constraint — see the "Federation crypto helpers" / "Federation
 * push private-visibility filter" comments in src/cli.ts, and the 0.5.3
 * ERR_MODULE_NOT_FOUND postmortem: a relative `../resources/...` import from
 * dist/cli.js resolves OUTSIDE the published dist/ tree, since dist/cli.js
 * ships without a sibling top-level resources/ folder). So cli.ts inlines an
 * identical one-liner predicate. This file cross-checks the two: the
 * canonical resources/memory-visibility.ts predicate is imported directly,
 * and its verdicts are asserted against what actually happens when the same
 * visibility values flow through the real runFederationSyncOnce() push path
 * — the anti-drift check the two independent copies can't silently diverge
 * on.
 */

const origFetch = globalThis.fetch;

/** Build a minimal Response mock with proper headers.get(). */
function res(ok: boolean, status: number, body: any) {
  return {
    ok,
    status,
    headers: {
      get: (name: string) =>
        name === "content-length" ? String(JSON.stringify(body).length) : null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const testKp = nacl.sign.keyPair();
const SINCE = "2025-01-01T00:00:00.000Z";

describe("federation sync push — private-visibility filter", () => {
  let capturedCalls: Array<{ url: string; body?: any; method?: string }> = [];

  beforeEach(() => {
    capturedCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  /**
   * Install a content-dispatched fetch mock (NOT a fixed call-index array —
   * whether a table's sendBatch/loadInstanceSecretKey calls happen at all
   * depends on whether that table has any rows left AFTER the privacy
   * filter, so the exact call count/order varies per test case). Only the
   * Memory table's `updatedAt > since` query returns `memoryRows`; every
   * other query (Memory's null-updatedAt query, and all of Soul/Agent/
   * Relationship) is empty.
   */
  function installMock(memoryRows: any[]) {
    globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? urlInput : urlInput.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      capturedCalls.push({ url, body, method });

      if (method === "GET" && url.includes("/FederationPeers")) {
        return res(true, 200, { peers: [{ id: "hub-1", role: "hub", status: "connected", endpoint: "http://hub:9926", lastSyncAt: SINCE }] });
      }
      if (method === "GET" && url.includes("/FederationInstance")) {
        return res(true, 200, { id: "spoke-alpha", publicKey: Buffer.from(testKp.publicKey).toString("base64url"), role: "spoke" });
      }
      if (body?.operation === "search_by_conditions") {
        const isMemoryUpdatedAtQuery = body.table === "Memory" && body.conditions?.[0]?.search_type === "greater_than";
        return res(true, 200, isMemoryUpdatedAtQuery ? memoryRows : []);
      }
      if (body?.operation === "search_by_value") {
        // loadInstanceSecretKey DB fallback (keystore is empty in test env)
        return res(true, 200, [{ id: "spoke-alpha", _keySeed: Buffer.from(testKp.secretKey.slice(0, 32)).toString("base64url") }]);
      }
      if (body?.operation === "update") {
        // local hub.lastSyncAt advance
        return res(true, 200, { ok: true });
      }
      if (method === "POST" && url.includes("/FederationSync")) {
        // sendBatch (has records) or the no-change liveness ping (empty records)
        const records = body?.records ?? [];
        return res(true, 200, { merged: records.length, skipped: 0 });
      }
      throw new Error(`Unexpected fetch call: ${method} ${url} body=${JSON.stringify(body)}`);
    }) as any;
  }

  function hubSyncCalls() {
    return capturedCalls.filter((c) => c.url.includes("/FederationSync") && c.method === "POST");
  }

  /** The batch actually POSTed with non-empty records (excludes the liveness ping, if any). */
  function pushedRecordIds(): string[] {
    const ids: string[] = [];
    for (const call of hubSyncCalls()) {
      for (const r of call.body?.records ?? []) ids.push(r.id);
    }
    return ids;
  }

  it("excludes a private Memory row from the push batch entirely", async () => {
    installMock([
      { id: "mem-private", agentId: "a1", content: "secret stuff", visibility: "private", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    expect(pushedRecordIds()).toEqual([]);
  });

  /**
   * flair#1232: the quiet path used to print "No changes since last sync."
   * whenever totalBatches === 0 — including the case where rows WERE found
   * since the cursor and every one was withheld as private. That message
   * sent operators on a cursor/token/hub-loss hunt. The two stories below
   * lock the distinction: withheld-private vs truly empty. Count + reason
   * only; private content must not appear in the printed line.
   */
  function captureLogs(): { stdout: string[]; restore: () => void } {
    const stdout: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { stdout.push(args.map((a) => String(a)).join(" ")); };
    return { stdout, restore: () => { console.log = origLog; } };
  }

  it("quiet path reports withheld-private count when every found row is private", async () => {
    const secret = "SECRET CONTENT MUST NOT APPEAR IN THE MESSAGE";
    const privateRows = Array.from({ length: 35 }, (_, i) => ({
      id: `mem-private-${i}`,
      agentId: "a1",
      content: secret,
      visibility: "private",
      updatedAt: "2025-06-01T00:00:00.000Z",
      createdAt: "2025-06-01T00:00:00.000Z",
    }));
    installMock(privateRows);

    const logs = captureLogs();
    try {
      const { runFederationSyncOnce } = await import("../../src/cli");
      const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

      expect(result.error).toBeUndefined();
      expect(pushedRecordIds()).toEqual([]);
      expect(logs.stdout).toContain("No federable changes since last sync (35 rows held back: private visibility).");
      expect(logs.stdout).not.toContain("No changes since last sync.");
      expect(logs.stdout.join("\n")).not.toContain(secret);
      // Liveness ping still fires — observability change only.
      const emptyPings = hubSyncCalls().filter((c) => (c.body?.records ?? []).length === 0);
      expect(emptyPings).toHaveLength(1);
    } finally {
      logs.restore();
    }
  });

  it("quiet path still reads as no changes when nothing was found since the cursor", async () => {
    installMock([]);

    const logs = captureLogs();
    try {
      const { runFederationSyncOnce } = await import("../../src/cli");
      const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

      expect(result.error).toBeUndefined();
      expect(pushedRecordIds()).toEqual([]);
      expect(logs.stdout).toContain("No changes since last sync.");
      expect(logs.stdout.join("\n")).not.toContain("held back");
      expect(logs.stdout.join("\n")).not.toContain("private visibility");
    } finally {
      logs.restore();
    }
  });

  it("pushes a shared Memory row", async () => {
    installMock([
      { id: "mem-shared", agentId: "a1", content: "team update", visibility: "shared", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    expect(pushedRecordIds()).toEqual(["mem-shared"]);
  });

  it("pushes a null/absent-visibility (legacy) Memory row — migration-safety invariant", async () => {
    // No `visibility` key at all — mirrors a pre-visibility-field row exactly
    // as it comes back from Harper's ops API (field simply absent, not null).
    installMock([
      { id: "mem-legacy", agentId: "a1", content: "old memory, no visibility field", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    expect(pushedRecordIds()).toEqual(["mem-legacy"]);
  });

  it("pushes an explicit-null visibility Memory row the same as absent", async () => {
    installMock([
      { id: "mem-null", agentId: "a1", content: "explicit null visibility", visibility: null, updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    expect(pushedRecordIds()).toEqual(["mem-null"]);
  });

  it("mixed batch: excludes only the private row, keeps shared + legacy-null", async () => {
    installMock([
      { id: "mem-private", agentId: "a1", content: "secret", visibility: "private", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
      { id: "mem-shared", agentId: "a1", content: "shared", visibility: "shared", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
      { id: "mem-legacy", agentId: "a1", content: "legacy", updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
    ]);

    const { runFederationSyncOnce } = await import("../../src/cli");
    const result = await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(result.error).toBeUndefined();
    expect(pushedRecordIds().sort()).toEqual(["mem-legacy", "mem-shared"]);
  });

  /**
   * Anti-drift cross-check: cli.ts inlines its own copy of the "is this
   * private" predicate (isFederationPrivateVisibility, not exported — see
   * the packaging-constraint comment in src/cli.ts). It cannot be imported
   * directly here. Instead, run the SAME table of visibility values through
   * both the canonical resources/memory-visibility.ts predicate (imported
   * directly) and through the real push path (one Memory row per value),
   * and assert the include/exclude decision agrees for every value. If the
   * two copies ever drift, this test — not just the individual cases above
   * — catches it.
   */
  it("push-path inclusion agrees with resources/memory-visibility.ts's isPrivateVisibility for every value", async () => {
    const cases: Array<{ visibility: string | null | undefined; label: string }> = [
      { visibility: "private", label: "private" },
      { visibility: "shared", label: "shared" },
      { visibility: null, label: "null" },
      { visibility: undefined, label: "undefined" },
      { visibility: "office", label: "office-legacy-value" },
    ];

    const memoryRows = cases.map((c, i) => {
      const row: any = { id: `mem-${i}-${c.label}`, agentId: "a1", content: c.label, updatedAt: "2025-06-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" };
      if (c.visibility !== undefined) row.visibility = c.visibility;
      return row;
    });

    installMock(memoryRows);
    const { runFederationSyncOnce } = await import("../../src/cli");
    await runFederationSyncOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    const pushedIds = new Set(pushedRecordIds());

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const id = `mem-${i}-${c.label}`;
      const expectedPushed = !isPrivateVisibility(c.visibility);
      expect(pushedIds.has(id)).toBe(expectedPushed);
    }
  });

  it("PRIVATE_VISIBILITY constant is the literal string 'private' (matches resources/memory-read-scope.ts)", () => {
    expect(PRIVATE_VISIBILITY).toBe("private");
    expect(isPrivateVisibility("private")).toBe(true);
    expect(isPrivateVisibility("shared")).toBe(false);
    expect(isPrivateVisibility(null)).toBe(false);
    expect(isPrivateVisibility(undefined)).toBe(false);
  });
});
