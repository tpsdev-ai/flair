import nacl from "tweetnacl";
import type { Request, Response, NextFunction } from "express";
import { getAgent } from "./store.js";

const WINDOW_MS = 30_000;
const nonceSeen = new Map<string, number>();

function cleanNonceCache(now: number) {
  for (const [k, signatureTs] of nonceSeen.entries()) {
    if (now - signatureTs > WINDOW_MS) nonceSeen.delete(k);
  }
}

function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64"));
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health") return next();

  const header = req.header("authorization") || "";
  const m = header.match(/^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/);
  if (!m) {
    res.status(401).json({ error: "missing_or_invalid_auth_header" });
    return;
  }

  const [, agentId, tsRaw, nonce, signatureB64] = m;
  const ts = Number(tsRaw);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS) {
    res.status(401).json({ error: "timestamp_out_of_window" });
    return;
  }

  cleanNonceCache(now);
  const nonceKey = `${agentId}:${nonce}`;
  if (nonceSeen.has(nonceKey)) {
    res.status(401).json({ error: "nonce_replay_detected" });
    return;
  }

  const agent = getAgent(agentId);
  if (!agent) {
    res.status(401).json({ error: "unknown_agent" });
    return;
  }

  const payload = `${req.method.toUpperCase()}:${req.originalUrl}:${tsRaw}:${nonce}`;
  const ok = nacl.sign.detached.verify(
    Buffer.from(payload, "utf-8"),
    b64ToBytes(signatureB64),
    b64ToBytes(agent.publicKey),
  );

  if (!ok) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  // Cache signature timestamp (not server now) to avoid future-ts replay window bypass.
  nonceSeen.set(nonceKey, ts);
  (req as any).agentId = agentId;
  next();
}
