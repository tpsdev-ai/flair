import { writeFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";

/**
 * A signature-verifying Flair server mock for the doctor/init probe tests
 * (flair#1501).
 *
 * Unlike the other doctor tests' method-routing mocks, this one actually
 * verifies the `TPS-Ed25519` header the way resources/auth-middleware.ts does:
 * it parses `agentId:ts:nonce:sig`, looks up the agent's registered public key,
 * and checks the signature over `${agentId}:${ts}:${nonce}:${METHOD}:${path}`.
 * That is what lets the #1501 tests distinguish the two auth failures a probe
 * can provoke — `unknown_agent` (the key isn't registered) from
 * `invalid_signature` (the key doesn't match the registered public key) — from
 * a healthy authenticated request.
 */

export const PROBE_BASE_URL = "http://127.0.0.1:19926";
export const PROBE_OPS_URL = "http://127.0.0.1:19925";
export const PROBE_ADMIN_USER = "admin";
export const PROBE_ADMIN_PASS = "test-admin-pass";

export interface ProbeAuthServerOptions {
  baseUrl?: string;
  opsUrl?: string;
  adminUser?: string;
  adminPass?: string;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export class ProbeAuthServer {
  readonly baseUrl: string;
  readonly opsUrl: string;
  readonly adminUser: string;
  readonly adminPass: string;
  /** agentId -> the public key the INSTANCE has registered for it. */
  readonly registeredPub = new Map<string, Uint8Array>();
  /** Every request the probe made, in order. */
  readonly calls: Array<{ method: string; path: string }> = [];
  /** The last probe memory id written — echoed back by /SemanticSearch. */
  probeId = "";
  private readonly realFetch: typeof globalThis.fetch;

  constructor(opts: ProbeAuthServerOptions = {}) {
    this.baseUrl = opts.baseUrl ?? PROBE_BASE_URL;
    this.opsUrl = opts.opsUrl ?? PROBE_OPS_URL;
    this.adminUser = opts.adminUser ?? PROBE_ADMIN_USER;
    this.adminPass = opts.adminPass ?? PROBE_ADMIN_PASS;
    this.realFetch = globalThis.fetch;
  }

  /** Write a 32-byte Ed25519 seed to `<keysDir>/<agentId>.key`; register the
   *  matching public key on the mock instance when `register` is true. */
  writeKey(keysDir: string, agentId: string, register: boolean, keypair: nacl.SignKeyPair = nacl.sign.keyPair()): nacl.SignKeyPair {
    writeFileSync(join(keysDir, `${agentId}.key`), Buffer.from(keypair.secretKey.slice(0, 32)));
    if (register) this.registeredPub.set(agentId, keypair.publicKey);
    return keypair;
  }

  install(): void {
    globalThis.fetch = (async (input: any, init?: any) => {
      const rawUrl = typeof input === "string" ? input : input.url;
      const url = new URL(rawUrl);
      init = { ...init, method: (init?.method ?? "GET").toUpperCase() };
      this.calls.push({ method: init.method, path: url.pathname });
      if (rawUrl.startsWith(this.opsUrl)) return this.handleOps(init);
      const denial = this.authenticate(init, url.pathname);
      if (denial) return denial;
      return this.handleApi(init, url.pathname);
    }) as typeof fetch;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }

  private authenticate(init: any, pathname: string): Response | null {
    const header = init?.headers?.Authorization ?? init?.headers?.authorization;
    if (typeof header !== "string" || !header.startsWith("TPS-Ed25519 ")) {
      return jsonResponse(401, { error: "authentication required" });
    }
    const [agentId, ts, nonce, sig] = header.slice("TPS-Ed25519 ".length).split(":");
    if (!agentId || !ts || !nonce || !sig) return jsonResponse(401, { error: "invalid_signature" });
    const pub = this.registeredPub.get(agentId);
    if (!pub) return jsonResponse(401, { error: "unknown_agent" });
    const payload = `${agentId}:${ts}:${nonce}:${init.method}:${pathname}`;
    const ok = nacl.sign.detached.verify(Buffer.from(payload), Buffer.from(sig, "base64"), pub);
    return ok ? null : jsonResponse(401, { error: "invalid_signature" });
  }

  /** The ops API is a DIFFERENT credential (Basic admin), never Ed25519. */
  private handleOps(init: any): Response {
    const auth = init?.headers?.Authorization ?? init?.headers?.authorization;
    const expected = `Basic ${Buffer.from(`${this.adminUser}:${this.adminPass}`).toString("base64")}`;
    if (auth !== expected) return jsonResponse(401, { error: "unauthorized" });
    return jsonResponse(200, { [this.probeId]: [{ operation: "upsert" }, { operation: "patch" }] });
  }

  private handleApi(init: any, pathname: string): Response {
    if (pathname.startsWith("/Agent/")) return jsonResponse(200, { id: pathname.split("/").pop() });
    if (init.method === "PUT") {
      this.probeId = pathname.split("/Memory/")[1] ?? "";
      return jsonResponse(200, { id: this.probeId });
    }
    if (init.method === "PATCH") return new Response(null, { status: 204 });
    if (init.method === "DELETE") return jsonResponse(200, { ok: true });
    if (init.method === "POST" && pathname === "/SemanticSearch") {
      return jsonResponse(200, { results: [{ id: this.probeId, _rawScore: 0.72, _score: 0.5 }] });
    }
    return jsonResponse(404, { error: "unexpected" });
  }
}
