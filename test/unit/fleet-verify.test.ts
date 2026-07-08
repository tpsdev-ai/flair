// fleet-verify.test.ts — Unit tests for `flair fleet verify` (src/fleet-verify.ts, flair#636).
//
// Everything here mocks probe/fetchPeers/buildAuthedGet — no real network,
// no spawned Harper. The real round trip against a spawned instance is
// covered by test/integration/fleet-verify.test.ts.
import { describe, test, expect } from "bun:test";
import {
  classifyNode,
  decideFleetExitCode,
  validatePeerEndpoint,
  sweepFleet,
  buildFabricAuthedGet,
  FLEET_EXIT_OK,
  FLEET_EXIT_ORIGIN_FAILED,
  FLEET_EXIT_PEER_SKEW,
  FLEET_EXIT_PEER_UNREACHABLE,
  type FleetNodeResult,
  type FleetPeerRecord,
} from "../../src/fleet-verify";
import type { ProbeResult } from "../../src/probe";
import { shouldRunFleetVerify } from "../../src/cli";

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

  test("origin ok + one peer unverifiable → PEER_UNREACHABLE (unverifiable is never silently OK)", () => {
    const origin = makeNode({ role: "origin", id: "origin" });
    const peers = [makeNode({ id: "p1", status: "unverifiable" })];
    expect(decideFleetExitCode(origin, peers)).toBe(FLEET_EXIT_PEER_UNREACHABLE);
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

  test("a peer with no endpoint on file → unverifiable, never probed, PEER_UNREACHABLE", async () => {
    const peers: FleetPeerRecord[] = [{ id: "tunnel-peer", status: "paired", endpoint: null }];
    const result = await sweepFleet(
      { target: "https://origin.example", fabricUser: "u", fabricPassword: "p" },
      deps({ originProbe: okProbe("1.2.3", null), peers }),
    );
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].status).toBe("unverifiable");
    expect(result.peers[0].method).toBe("none");
    expect(result.peers[0].detail).toContain("no endpoint");
    expect(result.exitCode).toBe(FLEET_EXIT_PEER_UNREACHABLE);
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
    expect(result.exitCode).toBe(FLEET_EXIT_PEER_UNREACHABLE);
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

// ─── shouldRunFleetVerify (--no-fleet-verify plumbing, src/cli.ts) ──────────

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
