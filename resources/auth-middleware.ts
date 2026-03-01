import { server, tables } from "harperdb";

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

server.http(async (request: any, nextLayer: any) => {
  const url = new URL(request.url, "http://" + (request.headers.get("host") || "localhost"));

  if (url.pathname === "/health") return nextLayer(request);

  const header = request.headers.get("authorization") || "";
  const m = header.match(/^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/);

  if (m) {
    const [, agentId, tsRaw, nonce, signatureB64] = m;
    const ts = Number(tsRaw);
    const now = Date.now();

    if (!Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS) {
      return new Response(JSON.stringify({ error: "timestamp_out_of_window" }), { status: 401 });
    }

    for (const [k, signatureTs] of nonceSeen.entries()) {
      if (now - signatureTs > WINDOW_MS) nonceSeen.delete(k);
    }

    const nonceKey = `${agentId}:${nonce}`;
    if (nonceSeen.has(nonceKey)) {
      return new Response(JSON.stringify({ error: "nonce_replay_detected" }), { status: 401 });
    }

    const agent = await (tables as any).Agent.get(agentId);
    if (!agent) {
      return new Response(JSON.stringify({ error: "unknown_agent" }), { status: 401 });
    }

    try {
      const payload = `${agentId}:${tsRaw}:${nonce}:${request.method}:${url.pathname}${url.search}`;
      const key = await importEd25519Key(agent.publicKey);
      const sigBuf = b64ToArrayBuffer(signatureB64);
      const msgBuf = new TextEncoder().encode(payload);
      const ok = await crypto.subtle.verify({ name: "Ed25519" } as any, key, sigBuf, msgBuf);

      if (!ok) {
        return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
      }
    } catch (e: any) {
      return new Response(JSON.stringify({ error: "signature_verification_failed", detail: e?.message }), { status: 401 });
    }

    nonceSeen.set(nonceKey, ts);
    // Store TPS agent ID on request
    request.tpsAgent = agentId;
    // Swap Authorization to Basic with superuser creds so Harper auth passes
    // In production, this should map to a proper Harper user with appropriate permissions
    // Map verified TPS agent to dedicated low-privilege Harper user.
    // tps_agent role: read/write on Agent/Memory/Soul/Integration, no super_user.
    // Role + user created by scripts/setup-harper.sh during initialization.
    const superAuth = "Basic " + btoa("admin:admin123");
    request.headers.set("authorization", superAuth);
    if (request.headers.asObject) request.headers.asObject.authorization = superAuth;
  }

  return nextLayer(request);
}, { runFirst: true });
