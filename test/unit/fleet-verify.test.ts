// fleet-verify.test.ts — Unit tests for `flair fleet verify` (src/fleet-verify.ts, flair#636).
//
// Everything here mocks probe/fetchPeers/buildAuthedGet — no real network,
// no spawned Harper. The real round trip against a spawned instance is
// covered by test/integration/fleet-verify.test.ts.
import { describe, test, expect } from "bun:test";
import {
  classifyNode,
  decideFleetExitCode,
  describeFleetSweep,
  validatePeerEndpoint,
  sweepFleet,
  buildFabricAuthedGet,
  renderFleetSweepTable,
  renderFleetSweepVerdict,
  fleetSweepShouldAbort,
  FLEET_EXIT_OK,
  FLEET_EXIT_ORIGIN_FAILED,
  FLEET_EXIT_PEER_SKEW,
  FLEET_EXIT_PEER_UNREACHABLE,
  type FleetNodeResult,
  type FleetPeerRecord,
  type FleetSweepResult,
} from "../../src/fleet-verify";
import type { ProbeResult } from "../../src/probe";
import { shouldRunFleetVerify, fleetSweepCallerExitMessage } from "../../src/cli";

// ─── helpers ─────────────────────────────────────────────────────────────────

function okProbe(version: string, versionMatch: boolean | null = null): ProbeResult {
  return { healthy: true, authenticated: true, version, versionMatch, ok: versionMatch !== false };
}
function unhealthyProbe(error = "instance did not answer /Health"): ProbeResult {
  return { healthy: false, authenticated: null, version: null, versionMatch: null, ok: false, error };
}
function authFailedProbe(error = "403 forbidden"): ProbeResult {
  return { healthy: true, authenticated: false, version: null, versionMatch: null, ok: false, error };
}
function mismatchProbe(version: string, expected: string): ProbeResult {
  return {
    healthy: true, authenticated: true, version, versionMatch: false, ok: false,
    error: `version mismatch: expected ${expected}, instance reports ${version}`,
  };
}

function makeNode(overrides: Partial<FleetNodeResult> = {}): FleetNodeResult {
  return {
    id: "n", role: "peer", url: "https://n.example", method: "direct",
    healthy: true, authenticated: true, version: "1.0.0", versionMatch: true,
    status: "ok", detail: "healthy, running 1.0.0",
    ...overrides,
  };
}

// ─── classifyNode ────────────────────────────────────────────────────────────

describe("classifyNode", () => {
  test("method=none / probe=null → unverifiable, carries the given reason", () => {
    const r = classifyNode("peer", "peer-a", null, "none", null, "1.0.0", "no endpoint on file");
    expect(r.status).toBe("unverifiable");
    expect(r.method).toBe("none");
    expect(r.healthy).toBeNull();
    expect(r.detail).toBe("no endpoint on file");
  });

  test("method=none without an explicit reason falls back to a generic message", () => {
    const r = classifyNode("peer", "peer-a", null, "none", null, null);
    expect(r.status).toBe("unverifiable");
    expect(r.detail).toBeTruthy();
  });

  test("unhealthy probe → unreachable, no version/auth info leaked", () => {
    const r = classifyNode("peer", "peer-a", "https://a", "direct", unhealthyProbe("ECONNREFUSED"), "1.0.0");
    expect(r.status).toBe("unreachable");
    expect(r.healthy).toBe(false);
    expect(r.authenticated).toBeNull();
    expect(r.version).toBeNull();
    expect(r.detail).toBe("ECONNREFUSED");
  });

  test("healthy but authentication rejected → auth-failed, not unreachable", () => {
    const r = classifyNode("peer", "peer-a", "https://a", "direct", authFailedProbe("401 unauthorized"), "1.0.0");
    expect(r.status).toBe("auth-failed");
    expect(r.healthy).toBe(true);
    expect(r.authenticated).toBe(false);
    expect(r.detail).toBe("401 unauthorized");
  });

  test("healthy + authenticated + wrong version → skew, names both versions via probe.error", () => {
    const r = classifyNode("peer", "peer-a", "https://a", "direct", mismatchProbe("0.9.0", "1.0.0"), "1.0.0");
    expect(r.status).toBe("skew");
    expect(r.version).toBe("0.9.0");
    expect(r.versionMatch).toBe(false);
    expect(r.detail).toContain("0.9.0");
    expect(r.detail).toContain("1.0.0");
  });

  test("healthy + authenticated + matching version → ok", () => {
    const r = classifyNode("peer", "peer-a", "https://a", "direct", okProbe("1.0.0", true), "1.0.0");
    expect(r.status).toBe("ok");
    expect(r.version).toBe("1.0.0");
  });

  test("no expectVersion baseline (null) → health/auth-only ok, never falsely 'skew'", () => {
    // probeInstance itself returns versionMatch=null when it wasn't given an
    // expectVersion — classifyNode must not manufacture a skew verdict here.
    const probe: ProbeResult = { healthy: true, authenticated: true, version: "1.0.0", versionMatch: null, ok: true };
    const r = classifyNode("peer", "peer-a", "https://a", "direct", probe, null);
    expect(r.status).toBe("ok");
  });

  test("origin role works the same as peer (role is just carried through)", () => {
    const r = classifyNode("origin", "origin", "https://origin", "direct", okProbe("1.0.0", true), "1.0.0");
    expect(r.role).toBe("origin");
    expect(r.status).toBe("ok");
  });
});

// ─── decideFleetExitCode ─────────────────────────────────────────────────────

describe("decideFleetExitCode", () => {
  test("origin ok, no peers → OK", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    expect(decideFleetExitCode(origin, [])).toBe(FLEET_EXIT_OK);
  });

  test("origin ok, all peers ok → OK", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "p1" }), makeNode({ id: "p2" })];
    expect(decideFleetExitCode(origin, peers)).toBe(FLEET_EXIT_OK);
  });

  test("origin unreachable → ORIGIN_FAILED, regardless of peer states", () => {
    const origin = makeNode({ role: "origin", id: "origin", status: "unreachable" });
    const peers = [makeNode({ id: "p1", status: "ok" })];
    expect(decideFleetExitCode(origin, peers)).toBe(FLEET_EXIT_ORIGIN_FAILED);
  });

  test("origin auth-failed → ORIGIN_FAILED", () => {
    const origin = makeNode({ role: "origin", id: "origin", status: "auth-failed" });
    expect(decideFleetExitCode(origin, [])).toBe(FLEET_EXIT_ORIGIN_FAILED);
  });

  test("origin skewed (wrong version vs --expect-version) → ORIGIN_FAILED", () => {
    const origin = makeNode({ role: "origin", id: "origin", status: "skew" });
    expect(decideFleetExitCode(origin, [])).toBe(FLEET_EXIT_ORIGIN_FAILED);
  });

  test("origin ok + one peer skewed → PEER_SKEW", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "p1", status: "ok" }), makeNode({ id: "p2", status: "skew" })];
    expect(decideFleetExitCode(origin, peers)).toBe(FLEET_EXIT_PEER_SKEW);
  });

  test("origin ok + one peer unreachable (no skew anywhere) → PEER_UNREACHABLE", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "p1", status: "ok" }), makeNode({ id: "p2", status: "unreachable" })];
    expect(decideFleetExitCode(origin, peers)).toBe(FLEET_EXIT_PEER_UNREACHABLE);
  });

  test("origin ok + one peer unverifiable → OK (couldn't-check does not fail the run, flair#988)", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "p1", status: "unverifiable" })];
    expect(decideFleetExitCode(origin, peers)).toBe(FLEET_EXIT_OK);
  });

  test("origin ok + one peer auth-failed → PEER_UNREACHABLE", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "p1", status: "auth-failed" })];
    expect(decideFleetExitCode(origin, peers)).toBe(FLEET_EXIT_PEER_UNREACHABLE);
  });

  test("skew AND unreachable both present → PEER_SKEW wins (worse signal first)", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [
      makeNode({ id: "p1", status: "unreachable" }),
      makeNode({ id: "p2", status: "skew" }),
    ];
    expect(decideFleetExitCode(origin, peers)).toBe(FLEET_EXIT_PEER_SKEW);
  });

  test("priority order: ORIGIN_FAILED > PEER_SKEW > PEER_UNREACHABLE > OK", () => {
    const failedOrigin = makeNode({ role: "origin", id: "origin", status: "unreachable" });
    const peers = [makeNode({ id: "p1", status: "skew" }), makeNode({ id: "p2", status: "unreachable" })];
    // Even with BOTH a skewed and an unreachable peer, an origin failure still wins.
    expect(decideFleetExitCode(failedOrigin, peers)).toBe(FLEET_EXIT_ORIGIN_FAILED);
  });
});

// ─── validatePeerEndpoint ────────────────────────────────────────────────────

describe("validatePeerEndpoint", () => {
  test("null/undefined/empty endpoint → error, names tunnel-pairing as a possibility", () => {
    for (const v of [null, undefined, ""]) {
      const r = validatePeerEndpoint(v);
      expect("error" in r).toBe(true);
      if ("error" in r) expect(r.error.toLowerCase()).toContain("endpoint");
    }
  });

  test("malformed URL → error naming the bad value", () => {
    const r = validatePeerEndpoint("not a url");
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("not a url");
  });

  test("non-http(s) scheme (e.g. file:) rejected — protocol allowlist", () => {
    const r = validatePeerEndpoint("file:///etc/passwd");
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("file:");
  });

  test("valid http(s) URL passes through unchanged", () => {
    const r = validatePeerEndpoint("https://peer.example.harperfabric.com");
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.url).toBe("https://peer.example.harperfabric.com");
  });

  test("plain http is accepted too (not just https)", () => {
    const r = validatePeerEndpoint("http://10.0.0.5:9926");
    expect("error" in r).toBe(false);
  });
});

// ─── buildFabricAuthedGet ────────────────────────────────────────────────────

describe("buildFabricAuthedGet", () => {
  test("sends Basic auth built from user:password, never the raw password, on the wire as anything but the header", async () => {
    let sawAuthHeader = "";
    let sawUrl = "";
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any, init: any) => {
      sawUrl = String(url);
      sawAuthHeader = init.headers.Authorization;
      return { ok: true, text: async () => JSON.stringify({ version: "1.0.0" }) } as any;
    };
    try {
      const authedGet = buildFabricAuthedGet("https://fabric.example/", "flint-admin", "s3cr3t");
      const body = await authedGet("/HealthDetail");
      expect(body).toEqual({ version: "1.0.0" });
      expect(sawUrl).toBe("https://fabric.example/HealthDetail"); // trailing slash on base collapsed
      expect(sawAuthHeader).toBe(`Basic ${Buffer.from("flint-admin:s3cr3t").toString("base64")}`);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("throws on a non-2xx response (matches probeInstance's authedGet contract)", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, status: 401, text: async () => "unauthorized" }) as any;
    try {
      const authedGet = buildFabricAuthedGet("https://fabric.example", "u", "p");
      await expect(authedGet("/HealthDetail")).rejects.toThrow("unauthorized");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// ─── sweepFleet (orchestration, fully mocked) ────────────────────────────────

describe("sweepFleet", () => {
  function deps(opts: {
    originProbe: ProbeResult;
    peerProbes?: Record<string, ProbeResult>;
    peers?: FleetPeerRecord[];
    peersError?: Error;
  }) {
    return {
      probe: async (baseUrl: string) => {
        if (baseUrl === "https://origin.example") return opts.originProbe;
        const found = Object.entries(opts.peerProbes ?? {}).find(([url]) => url === baseUrl);
        if (found) return found[1];
        throw new Error(`unexpected probe target in test: ${baseUrl}`);
      },
      fetchPeers: async () => {
        if (opts.peersError) throw opts.peersError;
        return opts.peers ?? [];
      },
      buildAuthedGet: (baseUrl: string) => async (_path: string) => ({ baseUrl }),
    };
  }

  test("origin ok, zero peers → exitCode OK, expectVersionSource=origin", async () => {
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({ originProbe: okProbe("1.2.3", null) }),
    );
    expect(result.origin.status).toBe("ok");
    expect(result.peers).toEqual([]);
    expect(result.exitCode).toBe(FLEET_EXIT_OK);
    expect(result.expectVersion).toBe("1.2.3");
    expect(result.expectVersionSource).toBe("origin");
  });

  test("explicit --expect-version wins over the origin's own reported version", async () => {
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p", expectVersion: "9.9.9" },
      deps({ originProbe: okProbe("1.2.3", false) }), // origin itself doesn't match 9.9.9
    );
    expect(result.expectVersion).toBe("9.9.9");
    expect(result.expectVersionSource).toBe("explicit");
    // origin mismatching the EXPLICIT expectation is an origin failure, not a peer concern.
    expect(result.exitCode).toBe(FLEET_EXIT_ORIGIN_FAILED);
  });

  test("origin unreachable → ORIGIN_FAILED, no baseline available for peers", async () => {
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({ originProbe: unhealthyProbe() }),
    );
    expect(result.origin.status).toBe("unreachable");
    expect(result.exitCode).toBe(FLEET_EXIT_ORIGIN_FAILED);
    expect(result.expectVersionSource).toBe("none");
  });

  test("reachable peer skew + unverifiable peers → PEER_SKEW (do not hide divergence, flair#988)", async () => {
    const peers: FleetPeerRecord[] = [
      { id: "west", status: "paired", endpoint: "https://west.example" },
      { id: "tunnel", status: "paired", endpoint: null },
    ];
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({
        originProbe: okProbe("0.32.0", null),
        peers,
        peerProbes: { "https://west.example": mismatchProbe("0.31.0", "0.32.0") },
      }),
    );
    expect(result.exitCode).toBe(FLEET_EXIT_PEER_SKEW);
    expect(result.verdict.kind).toBe("diverged");
    expect(result.verdict.summary).toBe("NOT converged — west diverged.");
    expect(result.verdict.warning).toContain("1 peer(s) unverifiable");
    expect(fleetSweepShouldAbort(result.verdict)).toBe(true);
    expect(fleetSweepCallerExitMessage(result)).toContain("NOT converged — west diverged.");
  });

  test("a reachable peer running a different version than the origin → PEER_SKEW", async () => {
    const peers: FleetPeerRecord[] = [{ id: "peer-a", status: "paired", endpoint: "https://peer-a.example" }];
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({
        originProbe: okProbe("1.2.3", null),
        peers,
        peerProbes: { "https://peer-a.example": mismatchProbe("1.2.2", "1.2.3") },
      }),
    );
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].status).toBe("skew");
    expect(result.exitCode).toBe(FLEET_EXIT_PEER_SKEW);
  });

  test("a peer with no endpoint on file → unverifiable, never probed, exit OK with warning (flair#988)", async () => {
    const peers: FleetPeerRecord[] = [{ id: "tunnel-peer", status: "paired", endpoint: null }];
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({ originProbe: okProbe("1.2.3", null), peers }),
    );
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].status).toBe("unverifiable");
    expect(result.peers[0].method).toBe("none");
    expect(result.peers[0].detail).toContain("no endpoint");
    expect(result.exitCode).toBe(FLEET_EXIT_OK);
    expect(result.verdict.kind).toBe("converged");
    expect(result.verdict.warning).toContain("1 peer(s) unverifiable");
    expect(result.verdict.summary).toBe("converged.");
  });

  test("a peer that never answers /Health → unreachable (distinct from unverifiable), PEER_UNREACHABLE", async () => {
    const peers: FleetPeerRecord[] = [{ id: "down-peer", status: "paired", endpoint: "https://down.example" }];
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({
        originProbe: okProbe("1.2.3", null),
        peers,
        peerProbes: { "https://down.example": unhealthyProbe("ECONNREFUSED") },
      }),
    );
    expect(result.peers[0].status).toBe("unreachable");
    expect(result.peers[0].method).toBe("direct"); // we DID attempt it — distinguishes from "no endpoint"
    expect(result.exitCode).toBe(FLEET_EXIT_PEER_UNREACHABLE);
  });

  test("revoked peers are filtered out entirely (decommissioned, not noise)", async () => {
    const peers: FleetPeerRecord[] = [{ id: "gone", status: "revoked", endpoint: "https://gone.example" }];
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({ originProbe: okProbe("1.2.3", null), peers }),
    );
    expect(result.peers).toEqual([]);
    expect(result.exitCode).toBe(FLEET_EXIT_OK);
  });

  test("peer enumeration itself failing → synthetic unverifiable row, never silently '0 peers = clean'", async () => {
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({ originProbe: okProbe("1.2.3", null), peersError: new Error("403 forbidden") }),
    );
    expect(result.peerEnumerationError).toContain("403 forbidden");
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].status).toBe("unverifiable");
    expect(result.peers[0].detail).toContain("FederationPeers");
    // Enumeration failure is "couldn't check," not "verified wrong" — listed
    // as unverifiable with a warning, does not share the diverged exit.
    expect(result.exitCode).toBe(FLEET_EXIT_OK);
    expect(result.verdict.warning).toContain("unverifiable");
    expect(result.verdict.kind).toBe("converged");
  });

  test("origin ok + reachable ok peer + unverifiable peers → exit 0, warning, not diverged (flair#988)", async () => {
    const peers: FleetPeerRecord[] = [
      { id: "paired", status: "paired", endpoint: "https://paired.example" },
      { id: "flair_28b15b9a", status: "paired", endpoint: null },
      { id: "flair_5ca1b7ab", status: "paired", endpoint: null },
    ];
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({
        originProbe: okProbe("0.32.0", null),
        peers,
        peerProbes: { "https://paired.example": okProbe("0.32.0", true) },
      }),
    );
    expect(result.origin.status).toBe("ok");
    expect(result.peers.filter((p) => p.status === "ok")).toHaveLength(1);
    expect(result.peers.filter((p) => p.status === "unverifiable")).toHaveLength(2);
    expect(result.exitCode).toBe(FLEET_EXIT_OK);
    expect(result.verdict.kind).toBe("converged");
    expect(result.verdict.diverged).toBe(false);
    expect(result.verdict.warning).toBe(
      "2 peer(s) unverifiable — could not check (no endpoint); converged among the 2 verifiable node(s).",
    );
    expect(fleetSweepCallerExitMessage(result)).toBeNull();
  });

  test("multiple peers all ok, matching the origin's version → OK", async () => {
    const peers: FleetPeerRecord[] = [
      { id: "p1", status: "paired", endpoint: "https://p1.example" },
      { id: "p2", status: "connected", endpoint: "https://p2.example" },
    ];
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({
        originProbe: okProbe("1.2.3", null),
        peers,
        peerProbes: {
          "https://p1.example": okProbe("1.2.3", true),
          "https://p2.example": okProbe("1.2.3", true),
        },
      }),
    );
    expect(result.peers.every((p) => p.status === "ok")).toBe(true);
    expect(result.exitCode).toBe(FLEET_EXIT_OK);
  });
});

// ─── describeFleetSweep / caller messages (flair#988 three-state verdict) ───

function makeSweep(origin: FleetNodeResult, peers: FleetNodeResult[]): FleetSweepResult {
  const verdict = describeFleetSweep(origin, peers);
  return {
    target: "https://origin.example",
    expectVersion: "1.0.0",
    expectVersionSource: "explicit",
    origin,
    peers,
    peerEnumerationError: null,
    exitCode: verdict.exitCode,
    verdict,
  };
}

describe("describeFleetSweep — three states (flair#988)", () => {
  test("acceptance: origin OK + unverifiable peers only → exit 0, warning, never 'NOT converged'", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [
      makeNode({ id: "flair_28b15b9a", status: "unverifiable", method: "none", url: null }),
      makeNode({ id: "flair_5ca1b7ab", status: "unverifiable", method: "none", url: null }),
      makeNode({ id: "flair_61e4b66b", status: "unverifiable", method: "none", url: null }),
    ];
    const v = describeFleetSweep(origin, peers);
    expect(v.exitCode).toBe(FLEET_EXIT_OK);
    expect(v.kind).toBe("converged");
    expect(v.diverged).toBe(false);
    expect(v.summary).toBe("converged.");
    expect(v.summary).not.toMatch(/NOT converged/i);
    expect(v.warning).toBe(
      "3 peer(s) unverifiable — could not check (no endpoint); converged among the 1 verifiable node(s).",
    );
    expect(fleetSweepShouldAbort(v)).toBe(false);

    const rendered = renderFleetSweepVerdict(v);
    expect(rendered).toContain("WARNING");
    expect(rendered).toContain("3 peer(s) unverifiable");
    expect(rendered).not.toMatch(/NOT converged/i);
    expect(rendered).not.toMatch(/NOT fully converged/i);

    const caller = fleetSweepCallerExitMessage(makeSweep(origin, peers));
    expect(caller).toBeNull();
  });

  test("acceptance: reachable peer on the wrong version → non-zero, 'NOT converged — <node> diverged'", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [
      makeNode({ id: "ok-peer", status: "ok" }),
      makeNode({ id: "west", status: "skew", version: "0.31.0", versionMatch: false }),
    ];
    const v = describeFleetSweep(origin, peers);
    expect(v.exitCode).toBe(FLEET_EXIT_PEER_SKEW);
    expect(v.exitCode).not.toBe(FLEET_EXIT_OK);
    expect(v.kind).toBe("diverged");
    expect(v.diverged).toBe(true);
    expect(v.divergedNodeId).toBe("west");
    expect(v.summary).toBe("NOT converged — west diverged.");
    expect(fleetSweepShouldAbort(v)).toBe(true);

    const caller = fleetSweepCallerExitMessage(makeSweep(origin, peers));
    expect(caller).toContain("NOT converged — west diverged.");
    expect(caller).not.toMatch(/NOT fully converged/i);
    expect(caller).toContain(`exit ${FLEET_EXIT_PEER_SKEW}`);
  });

  test("acceptance: all probed OK, no unverifiable → exit 0 'converged.'", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "p1" }), makeNode({ id: "p2" })];
    const v = describeFleetSweep(origin, peers);
    expect(v.exitCode).toBe(FLEET_EXIT_OK);
    expect(v.kind).toBe("converged");
    expect(v.summary).toBe("converged.");
    expect(v.warning).toBeNull();
    expect(fleetSweepShouldAbort(v)).toBe(false);
    expect(renderFleetSweepVerdict(v)).toContain("converged.");
  });

  test("hazard: unverifiable + diverged → diverged wins (must NOT always exit 0)", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [
      makeNode({ id: "tunnel", status: "unverifiable", method: "none" }),
      makeNode({ id: "east", status: "skew" }),
    ];
    const v = describeFleetSweep(origin, peers);
    expect(v.exitCode).toBe(FLEET_EXIT_PEER_SKEW);
    expect(v.kind).toBe("diverged");
    expect(v.summary).toBe("NOT converged — east diverged.");
    expect(v.warning).toContain("1 peer(s) unverifiable");
    expect(fleetSweepShouldAbort(v)).toBe(true);
    expect(v.exitCode).not.toBe(FLEET_EXIT_OK);
  });

  test("reachable peer unreachable is check-failed (exit 3), not 'NOT fully converged', and not the unverifiable exit", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "down", status: "unreachable" })];
    const v = describeFleetSweep(origin, peers);
    expect(v.exitCode).toBe(FLEET_EXIT_PEER_UNREACHABLE);
    expect(v.kind).toBe("check-failed");
    expect(v.diverged).toBe(false);
    expect(v.summary).toContain("down");
    expect(v.summary).toContain("unreachable");
    expect(v.summary).not.toMatch(/NOT converged/i);
    expect(v.exitCode).not.toBe(FLEET_EXIT_PEER_SKEW);

    const caller = fleetSweepCallerExitMessage(makeSweep(origin, peers));
    expect(caller).not.toBeNull();
    expect(caller).not.toMatch(/NOT fully converged/i);
    expect(caller).not.toMatch(/NOT converged/i);
  });

  test("deploy/upgrade caller never prints 'NOT fully converged' for unverifiable-only", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "flair_28b15b9a", status: "unverifiable", method: "none" })];
    const sweep = makeSweep(origin, peers);
    const table = renderFleetSweepTable(sweep);
    expect(table).not.toMatch(/NOT fully converged/i);
    expect(table).not.toMatch(/NOT converged/i);
    expect(table).toContain("WARNING");
    expect(table).toContain("unverifiable");
    expect(fleetSweepCallerExitMessage(sweep)).toBeNull();
    expect(sweep.exitCode).toBe(0);
  });

  test("deploy/upgrade caller for a diverged peer names the node, not a blanket 'NOT fully converged'", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "west", status: "skew" })];
    const sweep = makeSweep(origin, peers);
    const table = renderFleetSweepTable(sweep);
    expect(table).toContain("NOT converged — west diverged.");
    expect(table).not.toMatch(/NOT fully converged/i);
    const caller = fleetSweepCallerExitMessage(sweep);
    expect(caller).toBe("fleet verify failed (exit 2) — NOT converged — west diverged.");
  });
});

describe("shouldRunFleetVerify", () => {
  test("defaults to true when the flag is never passed (opts.fleetVerify undefined)", () => {
    expect(shouldRunFleetVerify({})).toBe(true);
  });

  test("--no-fleet-verify (commander sets fleetVerify=false) disables the sweep", () => {
    expect(shouldRunFleetVerify({ fleetVerify: false })).toBe(false);
  });

  test("an explicit true (shouldn't normally happen, but must not disable) stays enabled", () => {
    expect(shouldRunFleetVerify({ fleetVerify: true })).toBe(true);
  });
});
