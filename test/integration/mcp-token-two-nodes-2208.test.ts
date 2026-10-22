/**
 * mcp-token-two-nodes-2208.test.ts — flair#2208.
 *
 * With flair#2194 (oauth 2.9.0) the MCP signing key defaults to the key
 * @harperfast/oauth generates on the first token mint and persists in its
 * `harper_oauth_mcp_keys` table. This file measures the replicated case: two
 * Harper nodes running flair with MCP on and NO pinned key, where a token
 * minted on one node verifies on the other.
 *
 * The two-node case requires Harper Pro: the open-source `harper` core ships no
 * replication transport (`server.replication.replicateOperation` rejects with
 * `Replication not implemented.`). Set `FLAIR_TEST_HARPER_PRO_DIR` to a Harper
 * Pro install root to run it. When the variable is absent the cross-node test
 * is skipped with that reason logged — never silently passed.
 *
 * The key isolation case needs only the open-source build and always runs: two
 * nodes pinned with DIFFERENT keys, where a token minted on one is 200 on its
 * own node and 401 on the peer. That is the false-pass guard for the cross-node
 * case: a peer 200 requires shared key material.
 *
 * Fixtures use neutral names (node-a/node-b, host-a/host-b).
 */
import { describe, test, expect, afterAll } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle.js";
import {
  PRO_INSTALL_DIR,
  REPO_ROOT,
  assertOwnedInstance,
  makeNodeWorkDir,
  replicatedPairUnsupportedReason,
  startReplicatedPair,
  waitUntil,
} from "../helpers/replicated-nodes.js";

// Neutral fixture host name — never a real fleet host.
const ISSUER_HOST = "node-a.flair.test";

/** The default unpinned MCP enablement environment for this file's boots: no
 *  signing key, so the component generates one on first mint. The key
 *  isolation case overrides the pin, with a different key for each node. */
const MCP_SERVER_ENV: Record<string, string | undefined> = {
  FLAIR_MCP_OAUTH: "true",
  FLAIR_MCP_ISSUER: `https://${ISSUER_HOST}`,
  FLAIR_MCP_SIGNING_KEY_PEM: undefined,
  OAUTH_GITHUB_CLIENT_ID: "host-a-client-id",
  OAUTH_GITHUB_CLIENT_SECRET: "host-a-client-secret",
  OAUTH_GITHUB_REDIRECT_URI: `https://${ISSUER_HOST}/oauth`,
};
// The shipped config carries NO `resource` key, so the component derives
// `<issuer>/mcp` at request time (flair#1180).
const RESOURCE = `https://${ISSUER_HOST}/mcp`;
const CLIENT_ID_A = "two-node-2208-client-a";
const CLIENT_ID_B = "two-node-2208-client-b";
const REDIRECT_URI = `https://${ISSUER_HOST}/callback`;
const HTTP_TIMEOUT_MS = 15_000;
/** Stated bound for one direction: mint start to peer HTTP 200. */
const CROSS_NODE_BOUND_MS = 60_000;

const PAIR_UNSUPPORTED = replicatedPairUnsupportedReason();
if (PRO_INSTALL_DIR && PAIR_UNSUPPORTED) {
  console.log(`[flair#2208] SKIPPING the cross-node convergence test: ${PAIR_UNSUPPORTED}.`);
}
if (!PRO_INSTALL_DIR) {
  console.log(
    "[flair#2208] SKIPPING the cross-node convergence test: FLAIR_TEST_HARPER_PRO_DIR is not set. " +
      "Multi-node replication is a Harper Pro feature; point that variable at a Harper Pro install root " +
      "(and NODE_BIN at a Node version that build supports) to run it.",
  );
}

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

async function seedClientAndCode(h: HarperInstance, clientId: string, code: string, challenge: string): Promise<void> {
  const clientRes = await adminOp(h, {
    operation: "insert",
    database: "oauth",
    table: "harper_oauth_mcp_clients",
    records: [{
      client_id: clientId,
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
      client_id: clientId,
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
async function mint(
  h: HarperInstance,
  clientId: string,
  code: string,
  verifier: string,
): Promise<{ token: string; mintStartedAt: number }> {
  const mintStartedAt = Date.now();
  const res = await fetch(`${h.httpURL}/oauth/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
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
  return { token: json.access_token as string, mintStartedAt };
}

/** POST /mcp with a bearer token; returns the status code only. */
async function postMcp(h: HarperInstance, token: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<number> {
  const res = await fetch(`${h.httpURL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    signal: AbortSignal.timeout(timeoutMs),
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

// ── 1. Cross-node convergence (requires Harper Pro) ─────────────────────────

describe(
  "flair#2208 cross-node convergence: an MCP token minted on one replicated node verifies on the peer",
  () => {
    let stopPair: (() => Promise<void>) | undefined;

    afterAll(async () => {
      if (stopPair) await stopPair();
    }, HARPER_STOP_BUDGET_MS);

    test.skipIf(!PRO_INSTALL_DIR || PAIR_UNSUPPORTED !== null)(
      "tokens minted on each node verify on the other after a measured wait",
      async () => {
        const pair = await startReplicatedPair({ serverEnv: MCP_SERVER_ENV });
        stopPair = pair.stop;
        try {
          assertOwnedInstance(pair.a, "node-a");
          assertOwnedInstance(pair.b, "node-b");
          await pair.connect();

          // Sequential on purpose: the first mint on node-a creates and persists
          // the key, and replication carries that row to node-b. Node-b's mint
          // then reuses it. Minting on both at once is a different scenario: each
          // node may generate its own key before the rows meet.
          const mintAndVerify = async (
            node: HarperInstance,
            peer: HarperInstance,
            clientId: string,
            code: string,
          ): Promise<number> => {
            const pkce = pkcePair();
            await seedClientAndCode(node, clientId, code, pkce.challenge);
            const { token, mintStartedAt } = await mint(node, clientId, code, pkce.verifier);
            expect(jwtKid(token)).toBeDefined();
            expect(await postMcp(node, token), `${code}: node verifies its own token`).toBe(200);
            return waitUntil(
              async () =>
                (await postMcp(
                  peer,
                  token,
                  Math.max(1, Math.min(HTTP_TIMEOUT_MS, CROSS_NODE_BOUND_MS - (Date.now() - mintStartedAt))),
                )) === 200,
              { startMs: mintStartedAt, timeoutMs: CROSS_NODE_BOUND_MS, what: `${code}: peer verification` },
            );
          };

          const abMs = await mintAndVerify(pair.a, pair.b, CLIENT_ID_A, "code-node-a");
          const baMs = await mintAndVerify(pair.b, pair.a, CLIENT_ID_B, "code-node-b");
          console.log(
            `[flair#2208] elapsed from mint request start to peer HTTP 200 ` +
              `(includes mint request and self-verification): node-a→node-b ${abMs}ms, node-b→node-a ${baMs}ms`,
          );
          expect(abMs).toBeLessThanOrEqual(CROSS_NODE_BOUND_MS);
          expect(baMs).toBeLessThanOrEqual(CROSS_NODE_BOUND_MS);
        } finally {
          await pair.stop();
          stopPair = undefined;
        }
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
    // flair#2568: concurrent, so the set settles within one stop deadline.
    await stopHarpers(instances).catch(() => { /* best effort */ });
    for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }, HARPER_STOP_BUDGET_MS);

  test(
    "two nodes with different pinned keys: node-a's token is 200 on node-a and 401 on node-b",
    async () => {
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

      const dirA = makeNodeWorkDir("flair-test-2208-keyiso-a-", pinConfig);
      tempDirs.push(dirA);
      const nodeA = await startHarper({
        cwd: dirA,
        harperBinDir: REPO_ROOT,
        multiWorkerUnsafe: false,
        serverEnv: { ...MCP_SERVER_ENV, FLAIR_MCP_SIGNING_KEY_PEM: keyA },
      });
      instances.push(nodeA);

      const dirB = makeNodeWorkDir("flair-test-2208-keyiso-b-", pinConfig);
      tempDirs.push(dirB);
      const nodeB = await startHarper({
        cwd: dirB,
        harperBinDir: REPO_ROOT,
        multiWorkerUnsafe: false,
        serverEnv: { ...MCP_SERVER_ENV, FLAIR_MCP_SIGNING_KEY_PEM: keyB },
      });
      instances.push(nodeB);

      assertOwnedInstance(nodeA, "node-a");
      assertOwnedInstance(nodeB, "node-b");

      const pkceA = pkcePair();
      await seedClientAndCode(nodeA, CLIENT_ID_A, "code-node-a", pkceA.challenge);
      const { token: tokenA } = await mint(nodeA, CLIENT_ID_A, "code-node-a", pkceA.verifier);

      const pkceB = pkcePair();
      await seedClientAndCode(nodeB, CLIENT_ID_B, "code-node-b", pkceB.challenge);
      const { token: tokenB } = await mint(nodeB, CLIENT_ID_B, "code-node-b", pkceB.verifier);

      expect(await postMcp(nodeA, tokenA), "node-a accepts its own token").toBe(200);
      expect(await postMcp(nodeB, tokenB), "node-b accepts its own token").toBe(200);
      expect(await postMcp(nodeB, tokenA), "node-b rejects a token signed with node-a's key").toBe(401);
      expect(await postMcp(nodeA, tokenB), "node-a rejects a token signed with node-b's key").toBe(401);
    },
    10 * 60_000,
  );
});
