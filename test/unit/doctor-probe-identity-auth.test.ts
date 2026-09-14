import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

import { verifySemanticSearch, verifyAuditLog } from "../../src/cli.ts";
import {
  ProbeAuthServer,
  PROBE_ADMIN_PASS,
  PROBE_ADMIN_USER,
  PROBE_BASE_URL,
  PROBE_OPS_URL,
} from "../helpers/probe-auth-server.ts";

/**
 * flair#1501 — a probe against a healthy agent-keyed instance must succeed,
 * and a genuine auth rejection must still be reported.
 *
 * The reported bug: on a healthy agent-keyed install, `flair doctor` reported
 *   ⚠ Embeddings: not verified (… HTTP 401 {"error":"invalid_signature"})
 *   ⚠ Audit log: UNVERIFIED (… HTTP 401)
 * while signed writes on the same box succeeded. The probe had picked a local
 * key that sorted first but was NOT registered on the instance, signed with it,
 * and reported the resulting 401 as a soft "not verified".
 *
 * These are the fails-on-old / passes-on-fix tests: pre-#1501 the probe signed
 * with the first `.key` on disk and returned `skipped` (probe-failed, 401);
 * here it resolves the identity the way a real command does — `--agent` flag >
 * `FLAIR_AGENT_ID` env, else the first LOCAL agent key the instance ACCEPTS —
 * and returns `ok`.
 *
 * The hazard (must still surface a real failure) is covered by the
 * `invalid_signature` / `unknown_agent` named-identity tests below.
 */

let keysDir: string;
let server: ProbeAuthServer;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  keysDir = mkdtempSync(join(tmpdir(), "flair-1501-keys-"));
  server = new ProbeAuthServer();
  for (const k of ["FLAIR_AGENT_ID", "FLAIR_KEY_DIR"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // `resolveKeyPath` reads FLAIR_KEY_DIR before falling back to ~/.flair/keys.
  // Point it at THIS test's isolated dir so identity resolution cannot pick up
  // a real key installed on the host (true in CI, false on a release host).
  process.env.FLAIR_KEY_DIR = keysDir;
});

afterEach(() => {
  server.restore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(keysDir, { recursive: true, force: true });
});

describe("verifySemanticSearch — a healthy agent-keyed instance passes (flair#1501)", () => {
  it("★ signs as the registered key even when an unregistered key sorts first", async () => {
    // Pre-#1501 this returned skipped/probe-failed HTTP 401 unknown_agent.
    server.writeKey(keysDir, "aaa-stale", false);
    server.writeKey(keysDir, "flint", true);
    server.install();

    const result = await verifySemanticSearch(PROBE_BASE_URL, undefined, keysDir);
    expect(result.state).toBe("ok");
    // The probe checked the stale key, moved on, then wrote as the registered one.
    expect(server.calls.some((c) => c.method === "GET" && c.path === "/Agent/aaa-stale")).toBe(true);
    expect(server.calls.some((c) => c.method === "GET" && c.path === "/Agent/flint")).toBe(true);
  });

  it("still succeeds when the identity is named explicitly", async () => {
    server.writeKey(keysDir, "aaa-stale", false);
    server.writeKey(keysDir, "flint", true);
    server.install();
    const result = await verifySemanticSearch(PROBE_BASE_URL, "flint", keysDir);
    expect(result.state).toBe("ok");
  });

  it("succeeds via the FLAIR_AGENT_ID env identity", async () => {
    server.writeKey(keysDir, "flint", true);
    server.install();
    process.env.FLAIR_AGENT_ID = "flint";
    const result = await verifySemanticSearch(PROBE_BASE_URL, undefined, keysDir);
    expect(result.state).toBe("ok");
  });

  it("reports a genuine 401 invalid_signature as 'failed', naming identity + key path + server reason", async () => {
    // flint exists on the instance but with a DIFFERENT public key — a real
    // stale-signature defect. The hazard: this must still surface, not be
    // papered over by falling back to another key.
    const staleOwnKey = nacl.sign.keyPair();
    writeFileSync(join(keysDir, "flint.key"), Buffer.from(staleOwnKey.secretKey.slice(0, 32)));
    server.registeredPub.set("flint", nacl.sign.keyPair().publicKey);
    server.install();

    const result = await verifySemanticSearch(PROBE_BASE_URL, "flint", keysDir);
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.detail).toContain("flint");
      expect(result.detail).toContain("flint.key");
      expect(result.detail).toContain("invalid_signature");
    }
  });

  it("reports an unregistered named identity as 'failed' (unknown_agent), never a soft skip", async () => {
    server.writeKey(keysDir, "flint", false);
    server.install();
    const result = await verifySemanticSearch(PROBE_BASE_URL, "flint", keysDir);
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.detail).toContain("unknown_agent");
      expect(result.detail).toContain("flint");
    }
  });

  it("stays 'skipped' (no-agent) when nothing is named and no local key is registered", async () => {
    server.writeKey(keysDir, "aaa-stale", false);
    server.install();
    const result = await verifySemanticSearch(PROBE_BASE_URL, undefined, keysDir);
    expect(result.state).toBe("skipped");
    if (result.state === "skipped") {
      expect(result.reason).toBe("no-agent");
      expect(result.detail).toContain("aaa-stale");
    }
  });
});

describe("verifyAuditLog — same identity resolution, same loud auth rejection (flair#1501)", () => {
  it("★ signs probe writes as the registered key when an unregistered key sorts first", async () => {
    server.writeKey(keysDir, "aaa-stale", false);
    server.writeKey(keysDir, "flint", true);
    server.install();
    const result = await verifyAuditLog(PROBE_BASE_URL, undefined, keysDir, PROBE_OPS_URL, PROBE_ADMIN_USER, PROBE_ADMIN_PASS);
    expect(result.state).toBe("ok");
  });

  it("reports a named unregistered identity as 'failed'", async () => {
    server.writeKey(keysDir, "flint", false);
    server.install();
    const result = await verifyAuditLog(PROBE_BASE_URL, "flint", keysDir, PROBE_OPS_URL, PROBE_ADMIN_USER, PROBE_ADMIN_PASS);
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.detail).toContain("flint.key");
      expect(result.detail).toContain("unknown_agent");
    }
  });

  it("reports a genuine invalid_signature on the probe write as 'failed'", async () => {
    const staleOwnKey = nacl.sign.keyPair();
    writeFileSync(join(keysDir, "flint.key"), Buffer.from(staleOwnKey.secretKey.slice(0, 32)));
    server.registeredPub.set("flint", nacl.sign.keyPair().publicKey);
    server.install();
    const result = await verifyAuditLog(PROBE_BASE_URL, "flint", keysDir, PROBE_OPS_URL, PROBE_ADMIN_USER, PROBE_ADMIN_PASS);
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.detail).toContain("invalid_signature");
  });
});
