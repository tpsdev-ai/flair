/**
 * deploy-replication-convergence.test.ts — flair#878 (integration)
 *
 * Reproduces the reported flake signature end-to-end rather than through
 * stubbed decision logic:
 *
 *   - a REAL child process is spawned as the `harper deploy` binary and exits 1
 *     with the exact peer-replication message Harper emits, on stderr, so the
 *     tee-capture + regex + parser path is the real one;
 *   - the convergence poll makes REAL HTTP operations-API calls against two
 *     REAL servers, one per "node", each answering `get_components` with a real
 *     component file tree;
 *   - the fingerprint, the origin/peer comparison and the retry decision are
 *     all production code, unmocked.
 *
 * ── What is NOT real here, and why ──────────────────────────────────────────
 * The node-identity guard requires the deploy target and the peer to resolve to
 * DIFFERENT addresses (see src/replication-convergence.ts — a Fabric cluster
 * endpoint is steered to one member node, so comparing a node against itself
 * would be a false all-clear). Giving this test two genuinely distinct
 * addresses needs a second loopback address, and binding 127.0.0.2 fails with
 * EADDRNOTAVAIL on macOS without a `sudo ifconfig lo0 alias` — a system change
 * a test must not make. So `resolveHostAddresses` is the ONE injected seam:
 * `localhost` and `127.0.0.1` are declared to be distinct nodes. Everything
 * else — process spawn, HTTP, JSON, fingerprinting, decision — is real.
 *
 * The remaining unexercised gap, stated plainly: nothing here proves the
 * behaviour against a real multi-node Harper Fabric cluster with real
 * asynchronous replication. That requires a live cluster, which this fix must
 * not touch.
 */

import { describe, test, expect } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deploy, REQUIRED_PACKAGE_FILES } from "../../src/deploy.js";
import {
  buildOpsGetComponents,
  type ConvergenceDeps,
} from "../../src/replication-convergence.js";

const FABRIC_USER = "admin";
const FABRIC_PASSWORD = "not-a-real-password";

const MTIME_NEW = "2026-07-27T14:45:44.000Z";
const MTIME_OLD = "2026-07-01T09:00:00.000Z";

function componentTree(mtime: string): unknown {
  return {
    name: "components",
    entries: [
      {
        name: "flair",
        entries: [
          { name: "config.yaml", size: 2551, mtime },
          { name: "package.json", size: 903, mtime },
          { name: "dist", entries: [{ name: "cli.js", size: 128_004, mtime }] },
        ],
      },
    ],
  };
}

interface OpsNode {
  server: Server;
  port: number;
  calls: number;
  close: () => Promise<void>;
}

/**
 * A minimal Harper operations API: POST / with {operation:"get_components"}.
 * `failWith` makes the node answer that status instead — a node that is up but
 * refuses to answer, which must never read as "converged".
 */
async function startOpsNode(tree: () => unknown, failWith?: number): Promise<OpsNode> {
  const node: Partial<OpsNode> & { calls: number } = { calls: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.headers.authorization?.startsWith("Basic ")) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      let op: string | undefined;
      try {
        op = JSON.parse(body)?.operation;
      } catch {
        /* fall through to 400 */
      }
      if (op !== "get_components") {
        res.writeHead(400).end("unsupported operation");
        return;
      }
      node.calls++;
      if (failWith) {
        res.writeHead(failWith).end("operation failed");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(tree()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    get calls() {
      return node.calls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as OpsNode;
}

/** A package root plus a scripted stand-in for the bundled `harper` binary. */
function synthPackageRoot(behaviours: string[], peerNodeName: string): { root: string; counter: string } {
  const root = mkdtempSync(join(tmpdir(), "flair-878-integration-"));
  for (const f of REQUIRED_PACKAGE_FILES) {
    const p = join(root, f);
    if (f.endsWith(".yaml")) writeFileSync(p, "port: 9926\n");
    else mkdirSync(p, { recursive: true });
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "9.9.9-test" }));

  const binDir = join(root, "node_modules", "harper", "dist", "bin");
  mkdirSync(binDir, { recursive: true });
  const counter = join(root, ".attempt-count");
  writeFileSync(counter, "0");
  writeFileSync(
    join(binDir, "harper.js"),
    `
const fs = require('fs');
const counterPath = ${JSON.stringify(counter)};
const behaviours = ${JSON.stringify(behaviours)};
let n = (parseInt(fs.readFileSync(counterPath, 'utf8'), 10) || 0) + 1;
fs.writeFileSync(counterPath, String(n));
const b = behaviours[Math.min(n - 1, behaviours.length - 1)];
if (b === 'success') { console.log('Successfully deployed'); process.exit(0); }
if (b === 'replication-fail') {
  console.error("Component 'flair' was deployed on the origin node but failed to replicate to 1 of 1 peer node(s): ${peerNodeName} (Error: Connection closed  1006). See deployment 0f2c-9b1a (get_deployment) for details, or pass ignore_replication_errors: true to treat replication failures as non-fatal.");
  process.exit(1);
}
console.error("npm error code ENOTEMPTY");
console.error("npm error ENOTEMPTY: directory not empty, rmdir '/home/harperdb/harper/components/flair/node_modules/node-llama-cpp/dist'");
console.error("error: Failed to install dependencies for flair using npm default. Exit code: 217 (500)");
process.exit(1);
`,
  );
  return { root, counter };
}

/**
 * Real ops calls, real clock; only the hostname→address mapping is declared
 * (see the header for why). `localhost` is the deploy target, `127.0.0.1` the
 * peer — both genuinely resolvable, so `fetch` reaches the real servers.
 */
function depsWithDeclaredTopology(): ConvergenceDeps {
  const getComponents = buildOpsGetComponents(FABRIC_USER, FABRIC_PASSWORD);
  const addresses: Record<string, string[]> = {
    localhost: ["198.51.100.1"],
    "127.0.0.1": ["198.51.100.2"],
  };
  return {
    getComponents,
    resolveHostAddresses: async (hostname: string) => {
      const a = addresses[hostname];
      if (!a) throw new Error("ENOTFOUND");
      return a;
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

describe("flair#878 (integration): a peer-replication error over real HTTP", () => {
  test("CONVERGED — harper exits 1 on replication, both nodes hold the same tree, deploy SUCCEEDS", async () => {
    const origin = await startOpsNode(() => componentTree(MTIME_NEW));
    const peer = await startOpsNode(() => componentTree(MTIME_NEW));
    const { root, counter } = synthPackageRoot(["replication-fail"], `127.0.0.1:${peer.port}`);
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: any) => { warnings.push(String(m)); };
    try {
      const result = await deploy({
        target: `http://localhost:${origin.port}`,
        fabricUser: FABRIC_USER,
        fabricPassword: FABRIC_PASSWORD,
        packageRoot: root,
        verify: false,
        deployRetries: 2,
        deployRetryBackoffMs: [1, 1],
        convergenceDeps: depsWithDeclaredTopology(),
      });

      expect(result.convergedAfterReplicationError).toBe(true);
      expect(result.replicationWarning).toBe(false);
      // Both nodes were really queried over HTTP...
      expect(origin.calls).toBeGreaterThan(0);
      expect(peer.calls).toBeGreaterThan(0);
      // ...and nothing was re-deployed once convergence was confirmed.
      expect(Number(require("node:fs").readFileSync(counter, "utf8"))).toBe(1);
      expect(warnings.some((w) => /CONVERGED on its own/.test(w))).toBe(true);
    } finally {
      console.warn = warn;
      rmSync(root, { recursive: true, force: true });
      await origin.close();
      await peer.close();
    }
  }, 30_000);

  test("NOT CONVERGED then ENOTEMPTY on the retry — the reported failure is still the replication one", async () => {
    const origin = await startOpsNode(() => componentTree(MTIME_NEW));
    const peer = await startOpsNode(() => componentTree(MTIME_OLD)); // stuck on the old release
    const { root, counter } = synthPackageRoot(["replication-fail", "enotempty"], `127.0.0.1:${peer.port}`);
    try {
      const err = await deploy({
        target: `http://localhost:${origin.port}`,
        fabricUser: FABRIC_USER,
        fabricPassword: FABRIC_PASSWORD,
        packageRoot: root,
        verify: false,
        deployRetries: 1,
        deployRetryBackoffMs: [1],
        // Keep the poll short: the peer never converges, so the default would
        // wait out the full window. The origin quiescence gate still runs at
        // its real cadence.
        convergenceTimeoutMs: 1,
        convergencePollIntervalMs: 1,
        convergenceDeps: depsWithDeclaredTopology(),
      }).then(() => null, (e: Error) => e);

      expect(err).not.toBeNull();
      const msg = err!.message;
      expect(Number(require("node:fs").readFileSync(counter, "utf8"))).toBe(2);
      expect(msg.split("\n")[0]).toMatch(/peer replication was reported failed/);
      expect(msg.split("\n")[0]).not.toMatch(/ENOTEMPTY/);
      expect(msg).toMatch(/CONSEQUENCE of retrying/);
      expect(msg).toMatch(/convergence check: peer replication did NOT converge/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      await origin.close();
      await peer.close();
    }
  }, 60_000);

  test("a peer whose operations API refuses to answer is never reported converged", async () => {
    const origin = await startOpsNode(() => componentTree(MTIME_NEW));
    // Peer is up but every get_components 500s — "we could not look" must not
    // become "fine".
    const peer = await startOpsNode(() => componentTree(MTIME_NEW), 500);
    const { root } = synthPackageRoot(["replication-fail"], `127.0.0.1:${peer.port}`);
    try {
      const err = await deploy({
        target: `http://localhost:${origin.port}`,
        fabricUser: FABRIC_USER,
        fabricPassword: FABRIC_PASSWORD,
        packageRoot: root,
        verify: false,
        deployRetries: 0,
        convergenceTimeoutMs: 1,
        convergencePollIntervalMs: 1,
        convergenceDeps: depsWithDeclaredTopology(),
      }).then(() => null, (e: Error) => e);

      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/peer replication was reported failed/);
      expect(err!.message).toMatch(/convergence check: convergence could NOT be determined/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      await origin.close();
      await peer.close();
    }
  }, 30_000);
});
