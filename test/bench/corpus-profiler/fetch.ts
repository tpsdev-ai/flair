// ─── corpus-profiler: read the live instance, read-only ─────────────────────
//
// Enumerates Memory rows from a running Flair instance over its REST surface,
// authenticated with the same TPS-Ed25519 scheme scripts/flair-client.mjs uses.
//
// Two deliberate choices, both about not disturbing what we are measuring:
//
//  1. GET /Memory/ — the plain collection read — NOT POST /SemanticSearch.
//     SemanticSearch bumps `retrievalCount`/`lastRetrieved` on every record it
//     returns (resources/SemanticSearch.ts). Enumerating a corpus through it
//     would write to every row we touched and pollute a live ranking signal, so
//     the profiler would be changing the corpus in the act of measuring it.
//     The collection read has no such side effect.
//
//  2. The embeddings come back on the row (`Memory.embedding`, declared in
//     schemas/memory.graphql) and are used AS STORED. The profiler never
//     re-embeds. This matters more than it sounds: a profile computed with a
//     different embedding model measures a different space, and the whole
//     point is that the geometry corresponds to production retrieval.
//
// This module holds a full corpus in memory and hands it to the (pure)
// profiler. It never writes it anywhere.

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import type { ProfileRecord } from "./compute.ts";

const { subtle } = webcrypto;

export interface FetchOptions {
  /** Base URL of the live instance. */
  url: string;
  /** Agent identity used to sign the request. */
  agentId: string;
  /** Path to the agent's PKCS#8 Ed25519 private key, base64. */
  privateKeyPath: string;
  /**
   * Restrict to one owner. Omitted = every record inside the signing agent's
   * read scope, which is what "the corpus retrieval actually searches" means
   * for that agent.
   */
  ownerAgentId?: string;
}

/** Only the fields the profiler needs. Nothing else is carried forward. */
const KEEP = ["content", "createdAt", "agentId", "embedding", "embeddingModel", "durability", "tags", "archived"] as const;

export async function fetchCorpus(opts: FetchOptions): Promise<ProfileRecord[]> {
  const b64 = readFileSync(opts.privateKeyPath, "utf8").trim();
  const key = await subtle.importKey("pkcs8", Buffer.from(b64, "base64"), { name: "Ed25519" }, false, ["sign"]);

  const path = opts.ownerAgentId ? `/Memory/?agentId=${encodeURIComponent(opts.ownerAgentId)}` : "/Memory/";
  const ts = Date.now().toString();
  const nonce = webcrypto.randomUUID();
  const sig = await subtle.sign(
    "Ed25519",
    key,
    new TextEncoder().encode(`${opts.agentId}:${ts}:${nonce}:GET:${path}`),
  );
  const res = await fetch(`${opts.url}${path}`, {
    method: "GET",
    headers: {
      Authorization: `TPS-Ed25519 ${opts.agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`,
    },
  });
  if (!res.ok) {
    // Status only. The body of a failed authenticated request is not something
    // to echo into a terminal that may be transcribed somewhere.
    throw new Error(`GET ${path} failed with HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error(`GET ${path} returned ${typeof body}, expected an array of records`);
  }
  return body.map((row: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const f of KEEP) out[f] = row[f];
    return out as unknown as ProfileRecord;
  });
}
