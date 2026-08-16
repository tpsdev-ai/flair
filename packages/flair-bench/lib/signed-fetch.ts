/**
 * signed-fetch.ts — the ONE authenticated read/write path both eval layers use.
 *
 * Extracted verbatim (behaviourally) from test/bench/recall-harness/run.ts so
 * the Layer 1 deterministic recall eval (#17) and the later Layer 2
 * LongMemEval_s harness (#1216-b) issue byte-identical Ed25519 TPS-signed
 * requests. A divergence in HOW memories get written or queried between the two
 * layers would be a silent confound — Layer 1 would validate recall on one
 * ingestion/retrieval and Layer 2 would run its number on another. One module,
 * two layers on top (Kern's shared-plumbing design, #1216).
 *
 * Pure transport: no Harper lifecycle, no corpus, no metrics. Callers pass a
 * running HarperInstance (spawned via test/helpers/harper-lifecycle) and a
 * TestAgent. Nothing here touches ~/.flair or any live service.
 */
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";

/** An ephemeral test/bench identity. Ed25519 keypair minted per run — never a
 *  real agent, never persisted. `id` is the Flair `agentId` all writes/queries
 *  are scoped to (Kern's `userId` maps to this — Flair memory is agent-scoped). */
export interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

/** The minimal shape of a running ephemeral Harper this module talks to.
 *  Structurally compatible with harper-lifecycle's HarperInstance so callers
 *  can pass that straight through without importing the lifecycle here (keeps
 *  this transport layer free of the test-helper dependency). */
export interface HarperEndpoint {
  httpURL: string;
  opsURL: string;
  admin: { username: string; password: string };
}

export interface SignedResponse {
  ok: boolean;
  status: number;
  body: any;
}

export function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

export function ed25519Header(agent: TestAgent, method: string, p: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${p}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** Ed25519 TPS-signed request — the exact same authenticated read path
 *  `flair memory search` and the recall-harness use. Parses JSON when it can,
 *  falls back to raw text. */
export async function signedFetch(
  harper: HarperEndpoint,
  agent: TestAgent,
  method: string,
  p: string,
  body?: unknown,
): Promise<SignedResponse> {
  const res = await fetch(`${harper.httpURL}${p}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, p), "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** Basic-auth admin operation against Harper's ops API (agent registration,
 *  bulk field updates). Returns the raw Response so callers can inspect status
 *  + body themselves. */
export async function adminOp(harper: HarperEndpoint, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64"),
    },
    body: JSON.stringify(op),
  });
}

/** Register a bench agent so its Ed25519 public key resolves at auth time.
 *  Idempotent enough for bench use (a fresh ephemeral Harper has no prior
 *  record); throws with the HTTP status + body on failure so a seeding bug is
 *  never mistaken for a recall regression. */
export async function registerAgent(harper: HarperEndpoint, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: agent.id, name: agent.id, kind: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  if (!res.ok) throw new Error(`registerAgent(${agent.id}): HTTP ${res.status} ${await res.text().catch(() => "")}`);
}
