// federation-verify.test.ts — `flair federation verify` (src/federation-verify.ts, flair#823).
//
// Same class as fleet-verify / flair#988: couldn't-check ≠ verified-wrong.
// Everything here mocks api/sync/fetch — no real network, no spawned Harper.
import { describe, test, expect } from "bun:test";
import {
  classifyMissingAfterWindow,
  classifyProbeHttpStatus,
  decideFederationVerifyExitCode,
  describeFederationVerify,
  lastSyncFreshness,
  renderFederationVerifyVerdict,
  runFederationVerify,
  selectPeersToProbe,
  FED_VERIFY_EXIT_OK,
  FED_VERIFY_EXIT_DIVERGED,
  type FederationPeerRecord,
  type FederationPeerResult,
  type FederationVerifyClock,
  type FederationVerifyDeps,
  type FederationVerifyOptions,
} from "../../src/federation-verify";
import { assertVisibilityAllowedForDurability } from "../../resources/memory-visibility";

function makePeer(overrides: Partial<FederationPeerResult> = {}): FederationPeerResult {
  return {
    id: "hub",
    status: "ok",
    detail: "memory found after 1s",
    lastSyncAt: "2026-09-12T00:00:00.000Z",
    authenticated: true,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<FederationPeerRecord> = {}): FederationPeerRecord {
  return {
    id: "hub",
    role: "hub",
    status: "paired",
    endpoint: "https://hub.example",
    lastSyncAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

// ─── classifyProbeHttpStatus ─────────────────────────────────────────────────

describe("classifyProbeHttpStatus", () => {
  test("401 → auth (couldn't check, never FAIL)", () => {
    expect(classifyProbeHttpStatus(401)).toBe("auth");
  });

  test("403 → auth (couldn't check, never FAIL)", () => {
    expect(classifyProbeHttpStatus(403)).toBe("auth");
  });

  test("200 → parse body", () => {
    expect(classifyProbeHttpStatus(200)).toBe("found-ok");
  });

  test("500 → other (retry / unverifiable, not verified-wrong)", () => {
    expect(classifyProbeHttpStatus(500)).toBe("other");
  });
});

// ─── lastSyncFreshness / classifyMissingAfterWindow ──────────────────────────

describe("lastSyncFreshness", () => {
  test("absent or unparseable lastSyncAt is not fresh", () => {
    expect(lastSyncFreshness(null, 1_000, 600_000).fresh).toBe(false);
    expect(lastSyncFreshness("not-a-date", 1_000, 600_000).fresh).toBe(false);
  });

  test("contact inside the window is fresh; outside is stale", () => {
    const now = Date.parse("2026-09-12T00:10:00.000Z");
    expect(lastSyncFreshness("2026-09-12T00:05:00.000Z", now, 600_000).fresh).toBe(true);
    expect(lastSyncFreshness("2026-09-12T00:00:00.000Z", now, 60_000).fresh).toBe(false);
  });
});

describe("classifyMissingAfterWindow", () => {
  const nowMs = Date.parse("2026-09-12T00:10:00.000Z");
  const freshAt = "2026-09-12T00:09:00.000Z";
  const staleAt = "2026-09-11T00:00:00.000Z";

  test("successful push + missing canary → FAIL (do not silence real divergence)", () => {
    const r = classifyMissingAfterWindow({
      pushed: true, lastSyncAt: freshAt, nowMs, freshnessMs: 900_000, waitSeconds: 60,
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("after push");
  });

  test("no push + fresh lastSyncAt → UNVERIFIABLE (couldn't inject, not verified-wrong)", () => {
    const r = classifyMissingAfterWindow({
      pushed: false, lastSyncAt: freshAt, nowMs, freshnessMs: 900_000, waitSeconds: 60,
    });
    expect(r.status).toBe("unverifiable");
    expect(r.detail).toContain("could not push");
    expect(r.detail).toContain("fresh");
  });

  test("no push + stale lastSyncAt → FAIL (stale reachable peer)", () => {
    const r = classifyMissingAfterWindow({
      pushed: false, lastSyncAt: staleAt, nowMs, freshnessMs: 900_000, waitSeconds: 60,
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("stale");
  });
});

// ─── selectPeersToProbe ──────────────────────────────────────────────────────

describe("selectPeersToProbe", () => {
  test("revoked peers are not HTTP-probed (Cos: UNVERIFIABLE, not FAIL)", () => {
    const r = selectPeersToProbe([
      makeRecord({ id: "hub" }),
      makeRecord({ id: "old", status: "revoked" }),
    ]);
    expect(r.probe.map((p) => p.id)).toEqual(["hub"]);
    expect(r.skippedRevoked.map((p) => p.id)).toEqual(["old"]);
  });

  test("--peer on a revoked row still surfaces it as revoked, not as a probe target", () => {
    const r = selectPeersToProbe([
      makeRecord({ id: "hub" }),
      makeRecord({ id: "old", status: "revoked" }),
    ], "old");
    expect(r.probe).toEqual([]);
    expect(r.skippedRevoked.map((p) => p.id)).toEqual(["old"]);
  });

  test("--peer on a live row does not drag unrelated revoked peers into the set", () => {
    const r = selectPeersToProbe([
      makeRecord({ id: "hub" }),
      makeRecord({ id: "old", status: "revoked" }),
    ], "hub");
    expect(r.probe.map((p) => p.id)).toEqual(["hub"]);
    expect(r.skippedRevoked).toEqual([]);
  });
});

// ─── describeFederationVerify / exit codes ───────────────────────────────────

describe("describeFederationVerify — three states (flair#823 / #988)", () => {
  test("all ok → PASS, exit 0", () => {
    const v = describeFederationVerify([makePeer(), makePeer({ id: "spoke" })]);
    expect(v.kind).toBe("ok");
    expect(v.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(v.summary).toContain("PASS");
    expect(v.warning).toBeNull();
  });

  test("401-style unverifiable-only → warning, exit 0 (couldn't-check does not fail)", () => {
    const v = describeFederationVerify([
      makePeer({ id: "hub", status: "unverifiable", authenticated: false, detail: "HTTP 401" }),
    ]);
    expect(v.kind).toBe("unverifiable-only");
    expect(v.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(v.warning).toContain("unverifiable");
    expect(v.summary).not.toContain("FAIL");
    expect(v.summary).not.toContain("did not see the memory");
  });

  test("ok + unverifiable → exit 0 with warning, not diverged", () => {
    const v = describeFederationVerify([
      makePeer(),
      makePeer({ id: "tunnel", status: "unverifiable", authenticated: false }),
    ]);
    expect(v.kind).toBe("ok");
    expect(v.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(v.warning).toContain("1 peer(s) unverifiable");
  });

  test("reachable missing canary → FAIL exit 1 (do not always exit 0)", () => {
    const v = describeFederationVerify([
      makePeer({ id: "hub", status: "fail", detail: "timeout — reachable peer did not have the canary" }),
    ]);
    expect(v.kind).toBe("diverged");
    expect(v.exitCode).toBe(FED_VERIFY_EXIT_DIVERGED);
    expect(v.summary).toContain("FAIL");
  });

  test("diverged + unverifiable → FAIL (do not hide divergence behind couldn't-check)", () => {
    const v = describeFederationVerify([
      makePeer({ id: "hub", status: "fail" }),
      makePeer({ id: "old", status: "unverifiable" }),
    ]);
    expect(v.exitCode).toBe(FED_VERIFY_EXIT_DIVERGED);
    expect(v.kind).toBe("diverged");
    expect(v.warning).toContain("unverifiable");
  });

  test("empty → exit 0, no warning", () => {
    const v = describeFederationVerify([]);
    expect(v.kind).toBe("empty");
    expect(v.exitCode).toBe(FED_VERIFY_EXIT_OK);
  });
});

describe("decideFederationVerifyExitCode", () => {
  test("unverifiable is not a failure; fail is", () => {
    expect(decideFederationVerifyExitCode([makePeer({ status: "unverifiable" })])).toBe(FED_VERIFY_EXIT_OK);
    expect(decideFederationVerifyExitCode([makePeer({ status: "fail" })])).toBe(FED_VERIFY_EXIT_DIVERGED);
  });
});

describe("renderFederationVerifyVerdict", () => {
  test("unverifiable-only prints WARNING, not FAIL: did not see the memory", () => {
    const text = renderFederationVerifyVerdict(describeFederationVerify([
      makePeer({ status: "unverifiable", detail: "HTTP 401" }),
    ]));
    expect(text).toContain("WARNING");
    expect(text).not.toMatch(/FAIL:.*did not see the memory/);
  });

  test("diverged prints FAIL and diagnostics", () => {
    const text = renderFederationVerifyVerdict(describeFederationVerify([
      makePeer({ status: "fail" }),
    ]));
    expect(text).toContain("FAIL");
    expect(text).toContain("flair federation status");
  });
});

// ─── runFederationVerify (injected I/O) ──────────────────────────────────────

function advancingClock(start = 1_700_000_000_000): FederationVerifyClock {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
  };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function baseOpts(overrides: Partial<FederationVerifyOptions> = {}): FederationVerifyOptions {
  return {
    agentId: "tester",
    waitMs: 10_000,
    waitSeconds: 10,
    tag: "fed-verify-test",
    syncOpts: {},
    freshnessMs: 900_000,
    probeTimeoutMs: 50,
    pollIntervalMs: 5_000,
    ...overrides,
  };
}

function makeDeps(overrides: {
  peers?: FederationPeerRecord[];
  listError?: Error;
  writeError?: Error;
  deleteError?: Error;
  sync?: FederationVerifyDeps["syncOnce"];
  fetchImpl?: typeof fetch;
  clock?: FederationVerifyClock;
  writes?: unknown[];
  deletes?: string[];
} = {}): FederationVerifyDeps & { writes: unknown[]; deletes: string[] } {
  const writes: unknown[] = overrides.writes ?? [];
  const deletes: string[] = overrides.deletes ?? [];
  const clock = overrides.clock ?? advancingClock();
  return {
    writes,
    deletes,
    clock,
    log: () => {},
    error: () => {},
    syncOnce: overrides.sync ?? (async () => ({ pushed: 1, skipped: 0 })),
    fetch: overrides.fetchImpl ?? (async () => jsonRes(200, { results: [] })),
    api: async (method, path, body) => {
      if (method === "PUT" && path.startsWith("/Memory/")) {
        if (overrides.writeError) throw overrides.writeError;
        writes.push(body);
        return {};
      }
      if (method === "DELETE" && path.startsWith("/Memory/")) {
        if (overrides.deleteError) throw overrides.deleteError;
        deletes.push(path);
        return {};
      }
      if (method === "GET" && path === "/FederationPeers") {
        if (overrides.listError) throw overrides.listError;
        return { peers: overrides.peers ?? [makeRecord()] };
      }
      throw new Error(`unexpected api ${method} ${path}`);
    },
  };
}

describe("runFederationVerify", () => {
  test("canary is standard+shared (legal under #1257, federable, not ephemeral+shared)", async () => {
    const deps = makeDeps({
      fetchImpl: async () => jsonRes(200, { results: [{ content: "fed-verify-test — ok" }] }),
    });
    await runFederationVerify(baseOpts(), deps);
    const body = deps.writes[0] as { visibility?: string; durability?: string };
    expect(body.visibility).toBe("shared");
    expect(body.durability).toBe("standard");
    expect((body as { type?: string }).type).toBe("session");
    expect(assertVisibilityAllowedForDurability(body.durability, body.visibility)).toBeNull();
    expect(assertVisibilityAllowedForDurability("ephemeral", "shared")).not.toBeNull();
  });

  test("verify pushes itself before probing (bring-up has no daemon)", async () => {
    let syncCalls = 0;
    const deps = makeDeps({
      sync: async () => {
        syncCalls += 1;
        return { pushed: 1, skipped: 0 };
      },
      fetchImpl: async () => jsonRes(200, { results: [{ content: "fed-verify-test — ok" }] }),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    // Inject + archive-push (DELETE does not federate).
    expect(syncCalls).toBe(2);
    expect(r.pushed).toBe(true);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
  });

  test("successful push archives the canary and syncs that update before local delete", async () => {
    const deps = makeDeps({
      fetchImpl: async () => jsonRes(200, { results: [{ content: "fed-verify-test — ok" }] }),
    });
    await runFederationVerify(baseOpts(), deps);
    const archive = deps.writes.find((w) => (w as { archived?: boolean }).archived === true) as
      { archived?: boolean; type?: string } | undefined;
    expect(archive?.archived).toBe(true);
    expect(archive?.type).toBe("session");
    expect(deps.deletes.length).toBe(1);
  });

  test("zero-record sync does not archive-push (canary never left this instance)", async () => {
    let syncCalls = 0;
    const now = Date.parse("2026-09-12T00:10:00.000Z");
    const deps = makeDeps({
      clock: advancingClock(now),
      sync: async () => {
        syncCalls += 1;
        return { pushed: 0, skipped: 0 };
      },
      peers: [makeRecord({ lastSyncAt: "2026-09-12T00:09:00.000Z" })],
      fetchImpl: async () => jsonRes(200, { results: [] }),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.pushed).toBe(false);
    expect(syncCalls).toBe(1);
    expect(deps.writes.some((w) => (w as { archived?: boolean }).archived === true)).toBe(false);
  });

  test("HTTP 401 → UNVERIFIABLE, exit 0, never FAIL", async () => {
    const deps = makeDeps({
      fetchImpl: async () => jsonRes(401, { error: "unauthorized" }),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(r.peers[0]?.status).toBe("unverifiable");
    expect(r.peers[0]?.detail).toContain("401");
    expect(r.verdict.kind).toBe("unverifiable-only");
    expect(r.verdict.summary).not.toContain("FAIL");
  });

  test("HTTP 403 → UNVERIFIABLE, exit 0", async () => {
    const deps = makeDeps({
      fetchImpl: async () => jsonRes(403, { error: "forbidden" }),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(r.peers[0]?.status).toBe("unverifiable");
    expect(r.peers[0]?.detail).toContain("403");
  });

  test("unreachable peer → UNVERIFIABLE, exit 0", async () => {
    const deps = makeDeps({
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(r.peers[0]?.status).toBe("unverifiable");
    expect(r.peers[0]?.detail).toContain("unreachable");
  });

  test("no endpoint (tunnel-paired) → UNVERIFIABLE, not FAIL", async () => {
    const deps = makeDeps({
      peers: [makeRecord({ endpoint: null })],
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(r.peers[0]?.status).toBe("unverifiable");
    expect(r.peers[0]?.detail.toLowerCase()).toContain("endpoint");
  });

  test("revoked peer is UNVERIFIABLE (warn), never probed, never FAIL", async () => {
    let fetches = 0;
    const deps = makeDeps({
      peers: [
        makeRecord({ id: "hub" }),
        makeRecord({ id: "old", status: "revoked", endpoint: "https://old.example" }),
      ],
      fetchImpl: async () => {
        fetches += 1;
        return jsonRes(200, { results: [{ content: "fed-verify-test — ok" }] });
      },
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.skippedRevoked.map((p) => p.id)).toEqual(["old"]);
    expect(r.peers.find((p) => p.id === "old")?.status).toBe("unverifiable");
    expect(r.peers.find((p) => p.id === "old")?.detail).toContain("revoked");
    expect(r.peers.find((p) => p.id === "hub")?.status).toBe("ok");
    expect(fetches).toBe(1);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(r.verdict.warning).toContain("unverifiable");
  });

  test("revoked-only set → UNVERIFIABLE warning, exit 0 (not FAIL)", async () => {
    const deps = makeDeps({
      peers: [makeRecord({ id: "old", status: "revoked", endpoint: "https://old.example" })],
      fetchImpl: async () => {
        throw new Error("revoked peer must not be fetched");
      },
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(r.verdict.kind).toBe("unverifiable-only");
    expect(r.peers[0]?.status).toBe("unverifiable");
    expect(r.verdict.summary).not.toContain("FAIL");
  });

  test("healthy sync: canary found → exit 0", async () => {
    const deps = makeDeps({
      fetchImpl: async () => jsonRes(200, { results: [{ content: "hello fed-verify-test world" }] }),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(r.peers[0]?.status).toBe("ok");
    expect(r.verdict.kind).toBe("ok");
  });

  test("reachable peer missing canary after push → FAIL exit 1 (do not always exit 0)", async () => {
    const deps = makeDeps({
      fetchImpl: async () => jsonRes(200, { results: [{ content: "unrelated" }] }),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.pushed).toBe(true);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_DIVERGED);
    expect(r.peers[0]?.status).toBe("fail");
    expect(r.verdict.kind).toBe("diverged");
  });

  test("zero-record sync is not a push — missing canary + fresh lastSyncAt → UNVERIFIABLE", async () => {
    const now = Date.parse("2026-09-12T00:10:00.000Z");
    const deps = makeDeps({
      clock: advancingClock(now),
      sync: async () => ({ pushed: 0, skipped: 0 }),
      peers: [makeRecord({ lastSyncAt: "2026-09-12T00:09:00.000Z" })],
      fetchImpl: async () => jsonRes(200, { results: [] }),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.pushed).toBe(false);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(r.peers[0]?.status).toBe("unverifiable");
    expect(r.peers[0]?.detail).toContain("could not push");
  });

  test("no push + fresh lastSyncAt + missing canary → UNVERIFIABLE, exit 0", async () => {
    const now = Date.parse("2026-09-12T00:10:00.000Z");
    const deps = makeDeps({
      clock: advancingClock(now),
      sync: async () => ({ pushed: 0, skipped: 0, error: new Error("No hub peer configured") }),
      peers: [makeRecord({ lastSyncAt: "2026-09-12T00:09:00.000Z" })],
      fetchImpl: async () => jsonRes(200, { results: [] }),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.pushed).toBe(false);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_OK);
    expect(r.peers[0]?.status).toBe("unverifiable");
    expect(r.peers[0]?.detail).toContain("could not push");
  });

  test("no push + stale lastSyncAt + missing canary → FAIL (stale reachable peer)", async () => {
    const now = Date.parse("2026-09-12T00:10:00.000Z");
    const deps = makeDeps({
      clock: advancingClock(now),
      sync: async () => ({ pushed: 0, skipped: 0, error: new Error("sync down") }),
      peers: [makeRecord({ lastSyncAt: "2026-09-01T00:00:00.000Z" })],
      fetchImpl: async () => jsonRes(200, { results: [] }),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_DIVERGED);
    expect(r.peers[0]?.status).toBe("fail");
    expect(r.peers[0]?.detail).toContain("stale");
  });

  test("401 on one peer does not hide a diverged reachable peer", async () => {
    const deps = makeDeps({
      peers: [
        makeRecord({ id: "hub", endpoint: "https://hub.example" }),
        makeRecord({ id: "spoke", endpoint: "https://spoke.example" }),
      ],
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("hub.example")) return jsonRes(401, {});
        return jsonRes(200, { results: [] });
      },
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_DIVERGED);
    expect(r.peers.find((p) => p.id === "hub")?.status).toBe("unverifiable");
    expect(r.peers.find((p) => p.id === "spoke")?.status).toBe("fail");
  });

  test("cleanup always runs after a successful write", async () => {
    const deps = makeDeps({
      fetchImpl: async () => jsonRes(401, {}),
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.cleanedUp).toBe(true);
    expect(deps.deletes.length).toBe(1);
  });

  test("local write failure exits 1 and does not probe", async () => {
    let fetches = 0;
    const deps = makeDeps({
      writeError: new Error("disk full"),
      fetchImpl: async () => {
        fetches += 1;
        return jsonRes(200, { results: [] });
      },
    });
    const r = await runFederationVerify(baseOpts(), deps);
    expect(r.exitCode).toBe(FED_VERIFY_EXIT_DIVERGED);
    expect(r.memId).toBeNull();
    expect(fetches).toBe(0);
    expect(deps.deletes.length).toBe(0);
  });
});
