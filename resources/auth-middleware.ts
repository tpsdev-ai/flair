import { server, tables } from "harperdb";
import { initEmbeddings, getEmbedding } from "./embeddings-provider.js";

const WINDOW_MS = 30_000;
const nonceSeen = new Map<string, number>();

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

const keyCache = new Map<string, CryptoKey>();
async function importEd25519Key(publicKeyB64: string): Promise<CryptoKey> {
  if (keyCache.has(publicKeyB64)) return keyCache.get(publicKeyB64)!;
  const raw = b64ToArrayBuffer(publicKeyB64);
  const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" } as any, false, ["verify"]);
  keyCache.set(publicKeyB64, key);
  return key;
}

initEmbeddings().catch((err: any) => console.error("[embeddings] init:", err.message));

async function backfillEmbedding(memoryId: string): Promise<void> {
  try {
    const record = await (tables as any).Memory.get(memoryId);
    if (!record?.content) return;
    if (record.embedding?.length > 100) return;
    
    const embedding = await getEmbedding(record.content);
    if (!embedding) return;
    
    await (tables as any).Memory.put({ ...record, embedding });
    console.log(`[auto-embed] ${memoryId}: ${embedding.length}d`);
  } catch (err: any) {
    console.error(`[auto-embed] Failed for ${memoryId}: ${err.message}`);
  }
}

server.http(async (request: any, nextLayer: any) => {
  const url = new URL(request.url, "http://" + (request.headers.get("host") || "localhost"));
  if (url.pathname === "/health" || url.pathname === "/Health") return nextLayer(request);

  const header = request.headers.get("authorization") || "";
  const m = header.match(/^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/);

  let memoryId: string | null = null;
  let isMemoryWrite = false;

  if (m) {
    const [, agentId, tsRaw, nonce, signatureB64] = m;
    const ts = Number(tsRaw);
    const now = Date.now();

    if (!Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS)
      return new Response(JSON.stringify({ error: "timestamp_out_of_window" }), { status: 401 });

    for (const [k, signatureTs] of nonceSeen.entries())
      if (now - signatureTs > WINDOW_MS) nonceSeen.delete(k);

    const nonceKey = `${agentId}:${nonce}`;
    if (nonceSeen.has(nonceKey))
      return new Response(JSON.stringify({ error: "nonce_replay_detected" }), { status: 401 });

    const agent = await (tables as any).Agent.get(agentId);
    if (!agent) return new Response(JSON.stringify({ error: "unknown_agent" }), { status: 401 });

    try {
      const payload = `${agentId}:${tsRaw}:${nonce}:${request.method}:${url.pathname}${url.search}`;
      const key = await importEd25519Key(agent.publicKey);
      const ok = await crypto.subtle.verify(
        { name: "Ed25519" } as any, key,
        b64ToArrayBuffer(signatureB64),
        new TextEncoder().encode(payload)
      );
      if (!ok) return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: "signature_verification_failed", detail: e?.message }), { status: 401 });
    }

    nonceSeen.set(nonceKey, ts);
    request.tpsAgent = agentId;
    const superAuth = "Basic " + btoa("admin:admin123");
    request.headers.set("authorization", superAuth);
    if (request.headers.asObject) request.headers.asObject.authorization = superAuth;

    // Detect Memory writes
    isMemoryWrite = (request.method === "POST" || request.method === "PUT") && url.pathname.startsWith("/Memory");
    if (isMemoryWrite) {
      // Extract ID from URL path (PUT /Memory/id) or X-Memory-Id header (POST)
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length >= 2) {
        memoryId = decodeURIComponent(pathParts[1]);
      } else {
        // For POST /Memory/, client can send X-Memory-Id header
        memoryId = request.headers.get("x-memory-id");
      }
    }
  }

  const response = await nextLayer(request);

  // Post-process: backfill embedding after successful Memory write
  if (isMemoryWrite && memoryId && response.status >= 200 && response.status < 300) {
    backfillEmbedding(memoryId!).catch(() => {});
  }

  return response;
}, { runFirst: true });
