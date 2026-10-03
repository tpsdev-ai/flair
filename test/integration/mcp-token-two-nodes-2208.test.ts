/**
 * mcp-token-two-nodes-2208.test.ts — flair#2208.
 *
 * With flair#2194 (oauth 2.9.0) the MCP signing key defaults to the key
 * @harperfast/oauth generates on the first token mint and persists in its
 * `harper_oauth_mcp_keys` table. The open question: on two REPLICATED Harper
 * nodes running flair with MCP on and NO pinned key, does a token minted on one
 * node verify on the other — and how long does convergence take?
 *
 * What this file asserts:
 *
 *   1. CROSS-NODE CONVERGENCE (gated). Boots two real ephemeral Harpers through
 *      test/helpers/replicated-nodes, makes node B a replication peer of node A,
 *      mints an MCP token on each node (the component's real token endpoint, no
 *      seeded key), and measures how long the peer takes to verify it. The
 *      observed convergence time is PRINTED, never assumed immediate. Bounded:
 *      the test fails if a token never verifies on the peer within
 *      CROSS_NODE_BOUND_MS.
 *
 *      This test is GATED on replication being available in the installed
 *      Harper build. Multi-node replication is a Harper Pro feature; the OSS
 *      `harper` core that flair depends on does not ship the transport
 *      (`server.replication.replicateOperation` rejects with
 *      `Replication not implemented.`). `probeReplicationSupport()` measures
 *      that on the real build at collection time; when unsupported the test is
 *      registered with `describe.skipIf` and the reason (the exact error) is
 *      logged — an explicit skip, never a silent pass.
 *
 *   2. KEY ISOLATION / FALSE-PASS GUARD (always runs). Boots two independent
 *      nodes with DIFFERENT pinned signing keys and proves a token minted on
 *      node A is accepted by A (200) and REJECTED by B (401). This is the
 *      mutation the gated test would catch: cross-node verification can only
 *      pass when the peers share the same key material, so a green cross-node
 *      run is not a vacuous pass.
 *
 * Fixtures use neutral names (node-a/node-b, host-a/host-b).
 */
import { describe, test, expect, afterAll } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";
import {
  REPO_ROOT,
  assertOwnedInstance,
  makeNodeWorkDir,
  probeReplicationSupport,
  startReplicatedPair,
  waitUntil,
} from "../helpers/replicated-nodes.js";

// ── MCP enablement env, staged for every boot in this file ──────────────────
const MCP_ENV_KEYS = [
  "FLAIR_MCP_OAUTH",
  "FLAIR_MCP_ISSUER",
  "FLAIR_MCP_SIGNING_KEY_PEM",
  "OAUTH_GITHUB_CLIENT_ID",
  "OAUTH_GITHUB_CLIENT_SECRET",
  "OAUTH_GITHUB_REDIRECT_URI",
] as const;
let savedEnv: Record<(typeof MCP_ENV_KEYS)[number], string | undefined> | undefined;

/** Whole-token env ref staged ON by `flair mcp enable`; the component accepts
 *  only "true"/"false" (flair#1152). */
function setMcpEnv(): void {
  savedEnv ??= Object.fromEntries(MCP_ENV_KEYS.map((k) => [k, process.env[k]])) as Record<
    (typeof MCP_ENV_KEYS)[number],
    string | undefined
  >;
  process.env.FLAIR_MCP_OAUTH = "true";
  process.env.FLAIR_MCP_ISSUER = `https://${ISSUER_HOST}`;
  process.env.OAUTH_GITHUB_CLIENT_ID = "host-a-client-id";
  process.env.OAUTH_GITHUB_CLIENT_SECRET = "host-a-client-secret";
  process.env.OAUTH_GITHUB_REDIRECT_URI = `https://${ISSUER_HOST}/oauth`;
}

// Neutral fixture host name — never a real fleet host.
const ISSUER_HOST = "node-a.flair.test";
// The shipped config carries NO `resource` key, so the component derives
// `<issuer>/mcp` at request time (flair#1180).
const RESOURCE = `https://${ISSUER_HOST}/mcp`;
const CLIENT_ID = "two-node-2208-client";
const REDIRECT_URI = `https://${ISSUER_HOST}/callback`;
const HTTP_TIMEOUT_MS = 15_000;
const CROSS_NODE_BOUND_MS = 60_000;

// ── Collection-time capability probe ────────────────────────────────────────
// Boots one ephemeral Harper and measures whether replication is implemented in
// this build. Decides the gate; the reason is logged so a skip is never silent.
const support = await probeReplicationSupport();
if (!support.supported) {
  console.log(
    `[flair#2208] GATING the cross-node convergence test: this Harper build does not implement ` +
      `multi-node replication (Harper Pro feature), so two replicated nodes cannot be started. ` +
      `Observed: ${support.error}`,
  );
}

afterAll(async () => {
  if (savedEnv) {
    for (const k of MCP_ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── MCP mint/verify helpers (the component's real endpoints) ────────────────

function basicHeader(h: HarperInstance): string {
  return "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");
}

async function adminOp(h: HarperInstance, op: Record<string, unknown>): Promise<Response> {
  return fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicHeader(h) },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function seedClientAndCode(h: HarperInstance, code: string, challenge: string): Promise<void> {
  const clientRes = await adminOp(h, {
    operation: "insert",
    database: "oauth",
    table: "harper_oauth_mcp_clients",
    records: [{
      client_id: CLIENT_ID,
      grant_types: JSON.stringify(["authorization_code"]),
      response_types: JSON.stringify(["code"]),
      redirect_uris: JSON.stringify([REDIRECT_URI]),
      token_endpoint_auth_method: "none",
    }],
  });
  expect(clientRes.status, `seed client on ${h.httpURL}`).toBe(200);
  const codeRes = await adminOp(h, {
    operation: "insert",
    database: "oauth",
    table: "mcp_auth_codes",
    records: [{
      code,
      client_id: CLIENT_ID,
      user: "agent-a",
      resource: RESOURCE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: REDIRECT_URI,
      scope: "",
      client_auth_method: "none",
    }],
  });
  expect(codeRes.status, `seed code on ${h.httpURL}`).toBe(200);
}

/** Exchange a seeded code at the live token endpoint — the plugin's real mint. */
async function mint(h: HarperInstance, code: string, verifier: string): Promise<string> {
  const res = await fetch(`${h.httpURL}/oauth/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  expect(res.status, `token endpoint ${h.httpURL} → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  const json = JSON.parse(text) as { access_token?: unknown };
  expect(typeof json.access_token).toBe("string");
  return json.access_token as string;
}

/** POST /mcp with a bearer token; returns the status code only. */
async function postMcp(h: HarperInstance, token: string): Promise<number> {
  const res = await fetch(`${h.httpURL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return res.status;
}

function jwtKid(token: string): string | undefined {
  try {
    return JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"))?.kid;
  } catch {
    return undefined;
  }
}

// ── 1. Cross-node convergence (gated on replication availability) ───────────

describe(
  "flair#2208 cross-node convergence: an MCP token minted on one replicated node verifies on the peer",
  () => {
    const instances: HarperInstance[] = [];
    let stopPair: (() => Promise<void>) | undefined;

    afterAll(async () => {
      if (stopPair) await stopPair();
      for (const h of instances) { try { await stopHarper(h); } catch { /* best effort */ } }
    });

    test.skipIf(!support.supported)(
      "each node's freshly minted token verifies on the other after a measured wait",
      async () => {
        setMcpEnv();
        delete process.env.FLAIR_MCP_SIGNING_KEY_PEM; // NO pin, on purpose.

        const pair = await startReplicatedPair();
        stopPair = pair.stop;
        instances.push(pair.a, pair.b);
        // Never call anything but the ephemeral instances this test started.
        assertOwnedInstance(pair.a, "node-a");
        assertOwnedInstance(pair.b, "node-b");

        // A token minted on EACH node, using that node's own seeded client/code.
        const pkceA = pkcePair();
        await seedClientAndCode(pair.a, "code-node-a", pkceA.challenge);
        const tokenA = await mint(pair.a, "code-node-a", pkceA.verifier);
        expect(await postMcp(pair.a, tokenA), "node-a verifies its own token").toBe(200);

        const pkceB = pkcePair();
        await seedClientAndCode(pair.b, "code-node-b", pkceB.challenge);
        const tokenB = await mint(pair.b, "code-node-b", pkceB.verifier);
        expect(await postMcp(pair.b, tokenB), "node-b verifies its own token").toBe(200);

        expect(jwtKid(tokenA), "both nodes sign with the shared replicated key").toBe(jwtKid(tokenB));

        // Cross-verification, MEASURED: poll the peer until it accepts the
        // token minted elsewhere, and report the observed convergence time.
        const abMs = await waitUntil(async () => (await postMcp(pair.b, tokenA)) === 200, {
          timeoutMs: CROSS_NODE_BOUND_MS,
          what: `node-a's token never verified on node-b within ${CROSS_NODE_BOUND_MS}ms`,
        });
        const baMs = await waitUntil(async () => (await postMcp(pair.a, tokenB)) === 200, {
          timeoutMs: CROSS_NODE_BOUND_MS,
          what: `node-b's token never verified on node-a within ${CROSS_NODE_BOUND_MS}ms`,
        });
        console.log(`[flair#2208] measured MCP-token convergence: node-a→node-b ${abMs}ms, node-b→node-a ${baMs}ms`);
        expect(abMs).toBeLessThanOrEqual(CROSS_NODE_BOUND_MS);
        expect(baMs).toBeLessThanOrEqual(CROSS_NODE_BOUND_MS);
      },
      10 * 60_000,
    );
  },
);

// ── 2. Key isolation / false-pass guard (always runs) ───────────────────────

describe("flair#2208 key isolation: a token verifies only where the signing key matches", () => {
  const instances: HarperInstance[] = [];
  const tempDirs: string[] = [];

  afterAll(async () => {
    for (const h of instances) { try { await stopHarper(h); } catch { /* best effort */ } }
    for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  test(
    "two nodes with different pinned keys: node-a's token is 200 on node-a and 401 on node-b",
    async () => {
      setMcpEnv();
      const keyA = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      }).privateKey;
      const keyB = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      }).privateKey;

      // Each node declares the signingKeyPem pin and boots with a DIFFERENT key.
      const pinConfig = (shipped: string) =>
        shipped.replace(
          "    enabled: ${FLAIR_MCP_OAUTH}",
          "    enabled: ${FLAIR_MCP_OAUTH}\n    signingKeyPem: ${FLAIR_MCP_SIGNING_KEY_PEM}",
        );

      process.env.FLAIR_MCP_SIGNING_KEY_PEM = keyA;
      const dirA = makeNodeWorkDir("flair-test-2208-keyiso-a-", pinConfig);
      tempDirs.push(dirA);
      const nodeA = await startHarper({ cwd: dirA, harperBinDir: REPO_ROOT });
      instances.push(nodeA);

      process.env.FLAIR_MCP_SIGNING_KEY_PEM = keyB;
      const dirB = makeNodeWorkDir("flair-test-2208-keyiso-b-", pinConfig);
      tempDirs.push(dirB);
      const nodeB = await startHarper({ cwd: dirB, harperBinDir: REPO_ROOT });
      instances.push(nodeB);

      assertOwnedInstance(nodeA, "node-a");
      assertOwnedInstance(nodeB, "node-b");

      const pkceA = pkcePair();
      await seedClientAndCode(nodeA, "code-node-a", pkceA.challenge);
      const tokenA = await mint(nodeA, "code-node-a", pkceA.verifier);

      const pkceB = pkcePair();
      await seedClientAndCode(nodeB, "code-node-b", pkceB.challenge);
      const tokenB = await mint(nodeB, "code-node-b", pkceB.verifier);
      // Both nodes have minted, so each has now persisted its own pinned key.
      // The 401s below are therefore a key MISMATCH, not an empty key store
      // (a node only persists a key on first mint).

      expect(await postMcp(nodeA, tokenA), "node-a accepts its own token").toBe(200);
      expect(await postMcp(nodeB, tokenB), "node-b accepts its own token").toBe(200);
      expect(await postMcp(nodeB, tokenA), "node-b rejects a token signed with node-a's key").toBe(401);
      expect(await postMcp(nodeA, tokenB), "node-a rejects a token signed with node-b's key").toBe(401);
    },
    10 * 60_000,
  );
});
