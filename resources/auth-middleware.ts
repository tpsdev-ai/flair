import { server, tables } from "harperdb";
import nacl from "tweetnacl";

const WINDOW_MS = 30_000;
const nonceSeen = new Map<string, number>();

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

    const payload = `${request.method}:${url.pathname}${url.search}:${tsRaw}:${nonce}`;
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(payload),
      Uint8Array.from(Buffer.from(signatureB64, "base64")),
      Uint8Array.from(Buffer.from(agent.publicKey, "base64")),
    );

    if (!ok) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
    }

    nonceSeen.set(nonceKey, ts);
    request.agentId = agentId;
    // Set native user for Harper auth layer recognition
    request.user = agentId;
  }

  // Requests without TPS-Ed25519 header fall through to Harper native auth (JWT/Session).
  // Intentional behavior: bypass for local dev is controlled by authorizeLocal in config.yaml.
  return nextLayer(request);
}, { runFirst: true });
