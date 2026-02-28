import { beforeEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";

let authMiddleware: (req: Request, res: Response, next: () => void) => void;
let secretKeyB64 = "";

function signHeader(method: string, originalUrl: string, agentId: string, secretKey: string, nonce: string, ts: number): string {
  const payload = `${method}:${originalUrl}:${ts}:${nonce}`;
  const sig = nacl.sign.detached(Buffer.from(payload), Buffer.from(secretKey, "base64"));
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

function mkReq(path: string, originalUrl: string, auth: string): any {
  return {
    path,
    originalUrl,
    method: "GET",
    header: (k: string) => (k.toLowerCase() === "authorization" ? auth : undefined),
  };
}

function mkRes() {
  const out: any = { code: 200, body: null };
  out.status = (c: number) => { out.code = c; return out; };
  out.json = (b: any) => { out.body = b; return out; };
  return out;
}

beforeEach(async () => {
  const dbRoot = mkdtempSync(join(tmpdir(), "flair-auth-db-"));
  process.env.FLAIR_DB_PATH = join(dbRoot, "db.json");

  const kp = nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString("base64");
  secretKeyB64 = Buffer.from(kp.secretKey).toString("base64");

  writeFileSync(process.env.FLAIR_DB_PATH, JSON.stringify({
    agents: [{ id: "flint", name: "Flint", publicKey, createdAt: new Date().toISOString() }],
    integrations: [],
  }));

  ({ authMiddleware } = await import(`../src/auth.js?x=${Date.now()}`));
});

describe("auth middleware", () => {
  test("binds signature to query params via originalUrl", () => {
    const ts = Date.now();
    const nonce = "n1";
    const header = signHeader("GET", "/Integration?agentId=flint", "flint", secretKeyB64, nonce, ts);

    const tamperedReq = mkReq("/Integration", "/Integration?agentId=victim", header);
    const res = mkRes();
    let called = false;

    authMiddleware(tamperedReq, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.code).toBe(401);
    expect(res.body.error).toBe("invalid_signature");
  });


});
