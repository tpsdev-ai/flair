// upgrade-verify-preflight.test.ts — Unit tests for flair#741's
// verifyAuthedGet: the Ed25519 agent-key fallback layered on top of api()'s
// existing local-credential resolution, used by `flair upgrade`'s pre-flight
// (fix #1) and post-restart/post-rollback verification (fix #2). See
// cli.ts's verifyAuthedGet doc comment for the full design rationale.
//
// In-process, mocked globalThis.fetch — but every baseUrl used here is
// intentionally NON-local (a hostname other than 127.0.0.1/localhost/::1),
// so api()'s admin-pass-FILE fallback (resolveLocalAdminPass's
// isRemoteTarget guard) short-circuits before ever touching this machine's
// real HOME / ~/.flair/admin-pass — the same technique
// local-no-auth.test.ts's in-process describe block uses, and for the same
// reason documented in that file's header: Bun's os.homedir() does not
// re-read a live process.env.HOME mutation mid-process, so in-process HOME
// isolation doesn't reliably work; staying off the local-target code path
// sidesteps the problem entirely. Real Ed25519 keys are still used (via
// tweetnacl, written to a tmpdir keysDir passed explicitly to
// verifyAuthedGet as a parameter — no HOME dependency for that half either,
// mirroring doctor-client-network.test.ts's checkAgentRegistered(...,
// keysDir) technique).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { verifyAuthedGet } from "../../src/cli";

const BASE_URL = "https://verify-test.invalid:19926";

function writeAgentKey(keysDir: string, agentId: string): void {
  const kp = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${agentId}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
}

function authHeaderOf(opts: any): string | undefined {
  const h = opts?.headers ?? {};
  return typeof h.Authorization === "string" ? h.Authorization : typeof h.authorization === "string" ? h.authorization : undefined;
}

describe("verifyAuthedGet — agent-key fallback (flair#741 fix #2)", () => {
  let keysDir: string;
  let origFetch: typeof globalThis.fetch;
  const envKeys = ["FLAIR_TOKEN", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_AGENT_ID"] as const;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    keysDir = mkdtempSync(join(tmpdir(), "flair-verify-authedget-keys-"));
    origFetch = globalThis.fetch;
    origEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    for (const k of envKeys) delete process.env[k];
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    for (const k of envKeys) {
      const v = origEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(keysDir, { recursive: true, force: true });
  });

  test("no admin credentials, empty keysDir → rethrows api()'s original no-credentials hint", async () => {
    globalThis.fetch = (async (_url: any, opts: any) => {
      expect(authHeaderOf(opts)).toBeUndefined();
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }) as unknown as typeof fetch;

    await expect(verifyAuthedGet(BASE_URL, "/HealthDetail", keysDir)).rejects.toThrow(/no credentials sent/);
  });

  test("no admin credentials, one registered key in keysDir → falls back to a signed request and returns the body", async () => {
    writeAgentKey(keysDir, "agent-a");
    let sawEd25519 = false;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      if (auth?.startsWith("TPS-Ed25519 agent-a:")) {
        sawEd25519 = true;
        return new Response(JSON.stringify({ ok: true, version: "1.2.3" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }) as unknown as typeof fetch;

    const body = await verifyAuthedGet(BASE_URL, "/HealthDetail", keysDir);
    expect(sawEd25519).toBe(true);
    expect(body.version).toBe("1.2.3");
  });

  test("multiple keys: sorted filename order, first (unregistered) fails, second (registered) is tried next and succeeds", async () => {
    // "a-agent" sorts before "z-agent" — proves the loop moves on to the
    // NEXT key on failure rather than stopping at the first alphabetically.
    writeAgentKey(keysDir, "a-agent-unregistered");
    writeAgentKey(keysDir, "z-agent-registered");
    const attemptedInOrder: string[] = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      if (!auth?.startsWith("TPS-Ed25519 ")) return new Response("{}", { status: 403 });
      const agentId = auth.slice("TPS-Ed25519 ".length).split(":")[0];
      attemptedInOrder.push(agentId);
      if (agentId === "z-agent-registered") {
        return new Response(JSON.stringify({ ok: true, version: "9.9.9" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unknown_agent" }), { status: 401 });
    }) as unknown as typeof fetch;

    const body = await verifyAuthedGet(BASE_URL, "/HealthDetail", keysDir);
    expect(attemptedInOrder).toEqual(["a-agent-unregistered", "z-agent-registered"]);
    expect(body.version).toBe("9.9.9");
  });

  test("first key alphabetically succeeds → returned immediately, later keys never attempted", async () => {
    writeAgentKey(keysDir, "a-agent-works");
    writeAgentKey(keysDir, "z-agent-would-also-work");
    const attempted: string[] = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      if (!auth?.startsWith("TPS-Ed25519 ")) return new Response("{}", { status: 403 });
      const agentId = auth.slice("TPS-Ed25519 ".length).split(":")[0];
      attempted.push(agentId);
      return new Response(JSON.stringify({ ok: true, version: "1.0.0" }), { status: 200 });
    }) as unknown as typeof fetch;

    await verifyAuthedGet(BASE_URL, "/HealthDetail", keysDir);
    expect(attempted).toEqual(["a-agent-works"]);
  });

  test("admin credential resolves directly (FLAIR_ADMIN_PASS) → api() succeeds, keysDir never touched", async () => {
    process.env.FLAIR_ADMIN_PASS = "a-real-admin-pass";
    writeAgentKey(keysDir, "should-never-be-used");
    let keyAttempted = false;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      if (auth?.startsWith("TPS-Ed25519 ")) keyAttempted = true;
      expect(auth).toBe(`Basic ${Buffer.from("admin:a-real-admin-pass").toString("base64")}`);
      return new Response(JSON.stringify({ ok: true, version: "1.0.0" }), { status: 200 });
    }) as unknown as typeof fetch;

    const body = await verifyAuthedGet(BASE_URL, "/HealthDetail", keysDir);
    expect(body.version).toBe("1.0.0");
    expect(keyAttempted).toBe(false);
  });

  test("credentials WERE sent but rejected (wrong admin pass) → fallback NOT attempted, server's own error surfaces", async () => {
    process.env.FLAIR_ADMIN_PASS = "wrong-pass";
    writeAgentKey(keysDir, "should-never-be-used");
    let keyAttempted = false;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      if (auth?.startsWith("TPS-Ed25519 ")) keyAttempted = true;
      return new Response("Forbidden: bad admin credentials", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(verifyAuthedGet(BASE_URL, "/HealthDetail", keysDir)).rejects.toThrow(/Forbidden: bad admin credentials/);
    expect(keyAttempted).toBe(false);
  });

  test("a non-403 server error (5xx) is not the 'no credentials' case → fallback NOT attempted", async () => {
    writeAgentKey(keysDir, "should-never-be-used");
    let keyAttempted = false;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      if (auth?.startsWith("TPS-Ed25519 ")) keyAttempted = true;
      return new Response("internal error", { status: 500 });
    }) as unknown as typeof fetch;

    await expect(verifyAuthedGet(BASE_URL, "/HealthDetail", keysDir)).rejects.toThrow(/HTTP 500|internal error/);
    expect(keyAttempted).toBe(false);
  });

  test("no admin credentials, keysDir has only unregistered keys → all fail, original no-credentials hint surfaces", async () => {
    writeAgentKey(keysDir, "unregistered-agent");
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      if (auth?.startsWith("TPS-Ed25519 ")) {
        return new Response(JSON.stringify({ error: "unknown_agent" }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }) as unknown as typeof fetch;

    await expect(verifyAuthedGet(BASE_URL, "/HealthDetail", keysDir)).rejects.toThrow(/no credentials sent/);
  });

  test("keysDir doesn't exist on disk at all → treated as no keys, falls straight through to the original error", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as unknown as typeof fetch;

    await expect(
      verifyAuthedGet(BASE_URL, "/HealthDetail", join(keysDir, "does-not-exist")),
    ).rejects.toThrow(/no credentials sent/);
  });
});
