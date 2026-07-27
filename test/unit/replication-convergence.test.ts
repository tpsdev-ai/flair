/**
 * replication-convergence.test.ts — flair#878
 *
 * Unit tests for the decision logic behind "a peer-replication error is a
 * snapshot, not a verdict". No network: every test drives
 * src/replication-convergence.ts through its injected deps.
 *
 * The tests that matter most are the ones asserting a NEGATIVE: this module is
 * only allowed to say `converged: true` on positive, identity-guarded evidence.
 * A convergence check that reports success on a genuinely failed upgrade would
 * be far worse than the false alarm it replaces, so each way of failing to
 * observe (unaddressable node, DNS failure, shared address, HTTP failure,
 * absent component) has its own test proving it does NOT produce `converged`.
 */

import { describe, test, expect } from "bun:test";
import {
  parseReplicationFailure,
  fingerprintComponent,
  fingerprintDiffCount,
  resolvePeerUrl,
  awaitReplicationConvergence,
  awaitOriginQuiescent,
  type ConvergenceDeps,
} from "../../src/replication-convergence.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TARGET = "https://prod.acme.harperfabric.com";
const TARGET_HOST = "prod.acme.harperfabric.com";
const PEER_HOST = "node-b.acme.harperfabric.com";
const PEER_URL = "https://node-b.acme.harperfabric.com";

/** The exact message harper builds in components/operations.js. */
const REAL_ERROR =
  "Component 'flair' was deployed on the origin node but failed to replicate to 1 of 1 peer node(s): " +
  `${PEER_HOST} (Error: Connection closed  1006). See deployment 0f2c-9b1a (get_deployment) for details, ` +
  "or pass ignore_replication_errors: true to treat replication failures as non-fatal.";

type FileSpec = Record<string, { size: number; mtime: string }>;

function componentsBody(project: string, files: FileSpec, extraRoots: string[] = []): unknown {
  return {
    name: "components",
    entries: [
      ...extraRoots.map((n) => ({ name: n, entries: [{ name: "x", size: 1, mtime: "2026-07-27T00:00:00.000Z" }] })),
      {
        name: project,
        entries: Object.entries(files).map(([name, f]) => ({ name, size: f.size, mtime: f.mtime })),
      },
    ],
  };
}

const V1: FileSpec = {
  "config.yaml": { size: 2551, mtime: "2026-07-27T14:45:44.000Z" },
  "package.json": { size: 900, mtime: "2026-07-27T14:45:44.000Z" },
};
const V0: FileSpec = {
  "config.yaml": { size: 2551, mtime: "2026-07-01T09:00:00.000Z" },
  "package.json": { size: 900, mtime: "2026-07-01T09:00:00.000Z" },
};

/**
 * Deps with a VIRTUAL clock: `now` only advances when `sleep` is awaited, so
 * poll/deadline behaviour is deterministic and the suite never actually waits.
 */
function makeDeps(cfg: {
  /** baseUrl -> body, or a function called once per read (to script a sequence). */
  trees: Record<string, unknown | (() => unknown) | Error>;
  addresses: Record<string, string[]>;
}): ConvergenceDeps & { reads: string[]; clock: () => number } {
  let t = 0;
  const reads: string[] = [];
  return {
    reads,
    clock: () => t,
    getComponents: async (baseUrl: string) => {
      reads.push(baseUrl);
      const entry = cfg.trees[baseUrl];
      if (entry === undefined) throw new Error(`get_components returned HTTP 502`);
      if (entry instanceof Error) throw entry;
      return typeof entry === "function" ? (entry as () => unknown)() : entry;
    },
    resolveHostAddresses: async (hostname: string) => {
      const addrs = cfg.addresses[hostname];
      if (!addrs) throw new Error("ENOTFOUND");
      return addrs;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

const DISTINCT_ADDRESSES = { [TARGET_HOST]: ["203.0.113.10"], [PEER_HOST]: ["203.0.113.20"] };

// ─── parseReplicationFailure ────────────────────────────────────────────────

describe("flair#878: parseReplicationFailure", () => {
  test("recovers the peer node name, counts and deployment id from harper's real message", () => {
    const parsed = parseReplicationFailure(REAL_ERROR);
    expect(parsed.peers).toEqual([{ node: PEER_HOST, error: "Error: Connection closed  1006" }]);
    expect(parsed.failedCount).toBe(1);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.deploymentId).toBe("0f2c-9b1a");
  });

  test("recovers every peer from a multi-peer failure", () => {
    const msg =
      "Component 'flair' was deployed on the origin node but failed to replicate to 2 of 3 peer node(s): " +
      "node-b.example.com (Error: Connection closed 1006), node-c.example.com (timeout). See deployment abc (get_deployment) for details.";
    const parsed = parseReplicationFailure(msg);
    expect(parsed.peers.map((p) => p.node)).toEqual(["node-b.example.com", "node-c.example.com"]);
    expect(parsed.failedCount).toBe(2);
    expect(parsed.totalCount).toBe(3);
  });

  test("returns no peers for output that isn't a replication failure", () => {
    expect(parseReplicationFailure("Error: 401 Unauthorized").peers).toEqual([]);
    expect(parseReplicationFailure("").peers).toEqual([]);
  });
});

// ─── fingerprintComponent ───────────────────────────────────────────────────

describe("flair#878: fingerprintComponent", () => {
  test("fingerprints only the named component, recursing into directories", () => {
    const body = {
      entries: [
        { name: "other", entries: [{ name: "z", size: 1, mtime: "2026-01-01T00:00:00.000Z" }] },
        {
          name: "flair",
          entries: [
            { name: "config.yaml", size: 2551, mtime: "2026-07-27T14:45:44.000Z" },
            { name: "dist", entries: [{ name: "cli.js", size: 42, mtime: "2026-07-27T14:45:44.000Z" }] },
          ],
        },
      ],
    };
    const fp = fingerprintComponent(body, "flair");
    expect(fp).toContain("config.yaml 2551 2026-07-27T14:45:44.000Z");
    expect(fp).toContain("dist/cli.js 42 2026-07-27T14:45:44.000Z");
    expect(fp).not.toContain("z 1");
  });

  test("is order-independent — the same tree listed in a different order fingerprints identically", () => {
    const a = { entries: [{ name: "flair", entries: [{ name: "a", size: 1, mtime: "2026-01-01T00:00:00.000Z" }, { name: "b", size: 2, mtime: "2026-01-01T00:00:00.000Z" }] }] };
    const b = { entries: [{ name: "flair", entries: [{ name: "b", size: 2, mtime: "2026-01-01T00:00:00.000Z" }, { name: "a", size: 1, mtime: "2026-01-01T00:00:00.000Z" }] }] };
    expect(fingerprintComponent(a, "flair")).toBe(fingerprintComponent(b, "flair"));
  });

  test("mtime is part of the fingerprint — same sizes, different extraction times do NOT match", () => {
    // This is the stale-peer case: a peer still holding the previous release
    // can match on every file SIZE (a same-length version string, unchanged
    // assets) and must still be reported as not converged.
    expect(fingerprintComponent(componentsBody("flair", V1), "flair")).not.toBe(
      fingerprintComponent(componentsBody("flair", V0), "flair"),
    );
  });

  test("returns null (never an empty fingerprint) for a missing or empty component", () => {
    expect(fingerprintComponent({ entries: [] }, "flair")).toBeNull();
    expect(fingerprintComponent({ entries: [{ name: "flair", entries: [] }] }, "flair")).toBeNull();
    expect(fingerprintComponent(null, "flair")).toBeNull();
    expect(fingerprintComponent({ nope: true }, "flair")).toBeNull();
  });

  test("fingerprintDiffCount counts entries present on only one side", () => {
    const a = fingerprintComponent(componentsBody("flair", V1), "flair")!;
    const b = fingerprintComponent(componentsBody("flair", V0), "flair")!;
    expect(fingerprintDiffCount(a, b)).toBe(4); // 2 files, each differing in both directions
    expect(fingerprintDiffCount(a, a)).toBe(0);
  });
});

// ─── resolvePeerUrl ─────────────────────────────────────────────────────────

describe("flair#878: resolvePeerUrl", () => {
  test("addresses a bare node name with the deploy target's scheme and port", () => {
    expect(resolvePeerUrl(PEER_HOST, TARGET)).toBe(PEER_URL);
    expect(resolvePeerUrl("node-b", "https://origin.example.com:9925")).toBe("https://node-b:9925");
  });

  test("honours an explicit port on the node name, and an absolute URL", () => {
    expect(resolvePeerUrl("node-b.example.com:9925", TARGET)).toBe("https://node-b.example.com:9925");
    expect(resolvePeerUrl("http://node-b.example.com:9925/x", TARGET)).toBe("http://node-b.example.com:9925");
  });

  test("refuses to guess an address for anything that isn't a host — including harper's 'unknown' fallback", () => {
    // harper writes `peer.node ?? 'unknown'` and the detail is free text, so a
    // guessed address could reach a machine that has nothing to do with this
    // cluster. Refusing yields "cannot check", which is safe.
    expect(resolvePeerUrl("unknown", TARGET)).toBeNull();
    expect(resolvePeerUrl("timeout waiting for ack", TARGET)).toBeNull();
    expect(resolvePeerUrl("", TARGET)).toBeNull();
    expect(resolvePeerUrl("node b", TARGET)).toBeNull();
    expect(resolvePeerUrl("node/b", TARGET)).toBeNull();
  });
});

// ─── awaitReplicationConvergence ────────────────────────────────────────────

describe("flair#878: awaitReplicationConvergence — the converged case must report success", () => {
  test("peer holding the same tree as the origin reports converged", async () => {
    const deps = makeDeps({
      trees: { [TARGET]: componentsBody("flair", V1), [PEER_URL]: componentsBody("flair", V1) },
      addresses: DISTINCT_ADDRESSES,
    });
    const res = await awaitReplicationConvergence(
      { targetUrl: TARGET, project: "flair", peers: [{ node: PEER_HOST, error: "1006" }] },
      deps,
    );
    expect(res.converged).toBe(true);
    expect(res.conclusive).toBe(true);
    expect(res.peers[0].state).toBe("converged");
  });

  test("converges on a LATER poll — this is the async-replication window the whole fix exists for", async () => {
    let reads = 0;
    const deps = makeDeps({
      trees: {
        [TARGET]: componentsBody("flair", V1),
        // Still stale for the first two reads, converged on the third.
        [PEER_URL]: () => (++reads >= 3 ? componentsBody("flair", V1) : componentsBody("flair", V0)),
      },
      addresses: DISTINCT_ADDRESSES,
    });
    const res = await awaitReplicationConvergence(
      {
        targetUrl: TARGET,
        project: "flair",
        peers: [{ node: PEER_HOST, error: "1006" }],
        timeoutMs: 60_000,
        pollIntervalMs: 5_000,
      },
      deps,
    );
    expect(res.converged).toBe(true);
    expect(res.elapsedMs).toBeGreaterThan(0); // it actually waited
  });
});

describe("flair#878: awaitReplicationConvergence — no path infers success from missing evidence", () => {
  test("a peer that never catches up is diverged, and conclusively so", async () => {
    const deps = makeDeps({
      trees: { [TARGET]: componentsBody("flair", V1), [PEER_URL]: componentsBody("flair", V0) },
      addresses: DISTINCT_ADDRESSES,
    });
    const res = await awaitReplicationConvergence(
      { targetUrl: TARGET, project: "flair", peers: [{ node: PEER_HOST, error: "1006" }], timeoutMs: 20_000, pollIntervalMs: 10_000 },
      deps,
    );
    expect(res.converged).toBe(false);
    expect(res.conclusive).toBe(true);
    expect(res.peers[0].state).toBe("diverged");
  });

  test("GTM STEERING GUARD: a peer resolving to the deploy target's own address is never reported converged", async () => {
    // A Fabric cluster endpoint is steered to ONE member node. If it steers to
    // the failed peer, comparing "origin" against "peer" compares a node with
    // ITSELF and would trivially match. That would turn a false alarm into a
    // false all-clear, which is the one outcome worse than the bug being fixed.
    const deps = makeDeps({
      trees: { [TARGET]: componentsBody("flair", V0), [PEER_URL]: componentsBody("flair", V0) },
      addresses: { [TARGET_HOST]: ["203.0.113.20"], [PEER_HOST]: ["203.0.113.20"] },
    });
    const res = await awaitReplicationConvergence(
      { targetUrl: TARGET, project: "flair", peers: [{ node: PEER_HOST, error: "1006" }], timeoutMs: 10_000, pollIntervalMs: 10_000 },
      deps,
    );
    expect(res.converged).toBe(false);
    expect(res.conclusive).toBe(false);
    expect(res.peers[0].state).toBe("unknown");
    expect(res.peers[0].detail).toContain("same address as the deploy target");
  });

  test("a node name that is not an addressable host is unknown, and costs no network call", async () => {
    const deps = makeDeps({ trees: {}, addresses: {} });
    const res = await awaitReplicationConvergence(
      { targetUrl: TARGET, project: "flair", peers: [{ node: "timeout waiting for ack", error: "x" }] },
      deps,
    );
    expect(res.converged).toBe(false);
    expect(res.conclusive).toBe(false);
    expect(deps.reads).toEqual([]);
  });

  test("a peer whose hostname does not resolve is unknown, not converged", async () => {
    const deps = makeDeps({
      trees: { [TARGET]: componentsBody("flair", V1), [PEER_URL]: componentsBody("flair", V1) },
      addresses: { [TARGET_HOST]: ["203.0.113.10"] }, // peer host absent → ENOTFOUND
    });
    const res = await awaitReplicationConvergence(
      { targetUrl: TARGET, project: "flair", peers: [{ node: PEER_HOST, error: "1006" }], timeoutMs: 10_000, pollIntervalMs: 10_000 },
      deps,
    );
    expect(res.converged).toBe(false);
    expect(res.peers[0].state).toBe("unknown");
    expect(res.peers[0].detail).toContain("did not resolve");
  });

  test("a peer that refuses the operations call is unknown, not converged", async () => {
    const deps = makeDeps({
      trees: { [TARGET]: componentsBody("flair", V1), [PEER_URL]: new Error("get_components returned HTTP 401") },
      addresses: DISTINCT_ADDRESSES,
    });
    const res = await awaitReplicationConvergence(
      { targetUrl: TARGET, project: "flair", peers: [{ node: PEER_HOST, error: "1006" }], timeoutMs: 10_000, pollIntervalMs: 10_000 },
      deps,
    );
    expect(res.converged).toBe(false);
    expect(res.peers[0].state).toBe("unknown");
  });

  test("a peer reporting no such component at all is diverged, never converged", async () => {
    const deps = makeDeps({
      trees: { [TARGET]: componentsBody("flair", V1), [PEER_URL]: componentsBody("something-else", V1) },
      addresses: DISTINCT_ADDRESSES,
    });
    const res = await awaitReplicationConvergence(
      { targetUrl: TARGET, project: "flair", peers: [{ node: PEER_HOST, error: "1006" }], timeoutMs: 10_000, pollIntervalMs: 10_000 },
      deps,
    );
    expect(res.converged).toBe(false);
    expect(res.peers[0].state).toBe("diverged");
  });

  test("BOTH nodes missing the component do NOT match — an absent tree is not a fingerprint", async () => {
    const deps = makeDeps({
      trees: { [TARGET]: { entries: [] }, [PEER_URL]: { entries: [] } },
      addresses: DISTINCT_ADDRESSES,
    });
    const res = await awaitReplicationConvergence(
      { targetUrl: TARGET, project: "flair", peers: [{ node: PEER_HOST, error: "1006" }], timeoutMs: 10_000, pollIntervalMs: 10_000 },
      deps,
    );
    expect(res.converged).toBe(false);
  });

  test("no named peers at all is not convergence", async () => {
    const deps = makeDeps({ trees: {}, addresses: {} });
    const res = await awaitReplicationConvergence({ targetUrl: TARGET, project: "flair", peers: [] }, deps);
    expect(res.converged).toBe(false);
    expect(res.conclusive).toBe(false);
  });

  test("with two peers, ONE converged and one not is not convergence", async () => {
    const otherHost = "node-c.acme.harperfabric.com";
    const deps = makeDeps({
      trees: {
        [TARGET]: componentsBody("flair", V1),
        [PEER_URL]: componentsBody("flair", V1),
        [`https://${otherHost}`]: componentsBody("flair", V0),
      },
      addresses: { ...DISTINCT_ADDRESSES, [otherHost]: ["203.0.113.30"] },
    });
    const res = await awaitReplicationConvergence(
      {
        targetUrl: TARGET,
        project: "flair",
        peers: [{ node: PEER_HOST, error: "1006" }, { node: otherHost, error: "1006" }],
        timeoutMs: 10_000,
        pollIntervalMs: 10_000,
      },
      deps,
    );
    expect(res.converged).toBe(false);
    expect(res.peers.map((p) => p.state)).toEqual(["converged", "diverged"]);
  });
});

// ─── awaitOriginQuiescent ───────────────────────────────────────────────────

describe("flair#878: awaitOriginQuiescent — the clean-first retry precondition", () => {
  test("two identical consecutive reads count as settled", async () => {
    const deps = makeDeps({ trees: { [TARGET]: componentsBody("flair", V1) }, addresses: DISTINCT_ADDRESSES });
    const res = await awaitOriginQuiescent({ targetUrl: TARGET, project: "flair", pollIntervalMs: 1_000 }, deps);
    expect(res.quiescent).toBe(true);
  });

  test("a component tree that keeps changing is NOT quiescent — a retry there is what produces ENOTEMPTY", async () => {
    let n = 0;
    const deps = makeDeps({
      trees: {
        [TARGET]: () => componentsBody("flair", { "f": { size: ++n, mtime: "2026-07-27T14:45:44.000Z" } }),
      },
      addresses: DISTINCT_ADDRESSES,
    });
    const res = await awaitOriginQuiescent(
      { targetUrl: TARGET, project: "flair", timeoutMs: 10_000, pollIntervalMs: 5_000 },
      deps,
    );
    expect(res.quiescent).toBe(false);
    expect(res.detail).toContain("did not settle");
  });

  test("an unreadable origin is NOT quiescent (absence of evidence is never a licence to retry)", async () => {
    const deps = makeDeps({ trees: { [TARGET]: new Error("HTTP 503") }, addresses: DISTINCT_ADDRESSES });
    const res = await awaitOriginQuiescent(
      { targetUrl: TARGET, project: "flair", timeoutMs: 10_000, pollIntervalMs: 5_000 },
      deps,
    );
    expect(res.quiescent).toBe(false);
  });
});
