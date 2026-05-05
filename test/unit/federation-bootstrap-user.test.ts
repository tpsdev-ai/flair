import { describe, it, expect, mock, beforeEach } from "bun:test";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Minimal mock of the `flair federation token` action logic.
 * Returns what the CLI action would emit / throw, without actually running CLI.
 */
async function runTokenGeneration(opts: {
  opsEndpoint: string;
  adminPass: string;
  fetchImpl: typeof fetch;
}): Promise<{ token: string; user: string; password: string; expiresAt: string }> {
  const { opsEndpoint, adminPass, fetchImpl } = opts;
  const { randomBytes } = await import("node:crypto");

  const token = randomBytes(24).toString("base64url");
  const ttlMinutes = 60;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  const auth = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;

  // Step 1: Persist PairingToken
  const opsRes = await fetchImpl(`${opsEndpoint}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      operation: "upsert",
      database: "flair",
      table: "PairingToken",
      records: [{ id: token, createdAt: new Date().toISOString(), expiresAt }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!opsRes.ok) {
    const detail = await opsRes.text().catch(() => "");
    throw new Error(`Failed to persist pairing token (${opsRes.status}): ${detail || "no body"}`);
  }

  // Step 2: Create bootstrap user
  const bootstrapPassword = randomBytes(32).toString("base64url");
  const bootstrapUsername = `pair-bootstrap-${token.slice(0, 8)}`;

  let addUserRes: Response;
  try {
    addUserRes = await fetchImpl(`${opsEndpoint}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "add_user",
        username: bootstrapUsername,
        password: bootstrapPassword,
        role: "flair_pair_initiator",
        active: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    // Roll back PairingToken
    await fetchImpl(`${opsEndpoint}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "delete",
        database: "flair",
        table: "PairingToken",
        hash_value: token,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    throw new Error(`Failed to create bootstrap user (network): ${err.message}`);
  }

  if (!addUserRes.ok) {
    // Roll back PairingToken
    await fetchImpl(`${opsEndpoint}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "delete",
        database: "flair",
        table: "PairingToken",
        hash_value: token,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    const detail = await addUserRes.text().catch(() => "");
    throw new Error(`Failed to create bootstrap user (${addUserRes.status}): ${detail || "no body"}`);
  }

  return { token, user: bootstrapUsername, password: bootstrapPassword, expiresAt };
}

/**
 * Minimal mock of the FederationPair.post drop_user logic on successful pair.
 */
async function runPairSuccessDropUser(opts: {
  pairingToken: string;
  opsUrl: string;
  adminPass: string;
  fetchImpl: typeof fetch;
}): Promise<{ dropped: boolean; warned: boolean }> {
  const { pairingToken, opsUrl, adminPass, fetchImpl } = opts;
  let dropped = false;
  let warned = false;

  try {
    const bootstrapUsername = `pair-bootstrap-${pairingToken.slice(0, 8)}`;
    const auth = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;
    const dropRes = await fetchImpl(`${opsUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "drop_user", username: bootstrapUsername }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!dropRes.ok) {
      warned = true;
    } else {
      dropped = true;
    }
  } catch {
    warned = true;
  }

  return { dropped, warned };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("federation bootstrap user lifecycle", () => {
  const OPS_URL = "http://localhost:19925";
  const ADMIN_PASS = "secret";

  let capturedBodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    capturedBodies = [];
  });

  function makeFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
    let idx = 0;
    return mock(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedBodies.push(body);
      const resp = responses[idx++];
      if (!resp) throw new Error(`Unexpected fetch call #${idx}`);
      return {
        ok: resp.ok,
        status: resp.status ?? (resp.ok ? 200 : 500),
        json: async () => resp.body,
        text: async () => JSON.stringify(resp.body),
      } as unknown as Response;
    });
  }

  // ── Token generation ─────────────────────────────────────────────────────

  it("token-gen: creates bootstrap user with role flair_pair_initiator and active=true", async () => {
    const mockFetch = makeFetch([
      { ok: true, body: { ok: true } },  // upsert PairingToken
      { ok: true, body: { ok: true } },  // add_user
    ]);

    const result = await runTokenGeneration({
      opsEndpoint: OPS_URL,
      adminPass: ADMIN_PASS,
      fetchImpl: mockFetch as any,
    });

    expect(capturedBodies).toHaveLength(2);

    // First call: PairingToken upsert
    expect(capturedBodies[0].operation).toBe("upsert");
    expect(capturedBodies[0].table).toBe("PairingToken");

    // Second call: add_user
    const addUserCall = capturedBodies[1];
    expect(addUserCall.operation).toBe("add_user");
    expect(typeof addUserCall.username).toBe("string");
    expect((addUserCall.username as string).startsWith("pair-bootstrap-")).toBe(true);
    expect(addUserCall.role).toBe("flair_pair_initiator");
    expect(addUserCall.active).toBe(true);
    expect(typeof addUserCall.password).toBe("string");
    // Password should never be the token itself
    expect(addUserCall.password).not.toBe(result.token);

    // Returned triple
    expect(result.user).toBe(addUserCall.username);
    expect(typeof result.password).toBe("string");
    expect(result.password.length).toBeGreaterThan(0);
    expect(typeof result.expiresAt).toBe("string");
  });

  it("token-gen: rolls back PairingToken if add_user fails (HTTP error)", async () => {
    const mockFetch = makeFetch([
      { ok: true, body: { ok: true } },         // upsert PairingToken — succeeds
      { ok: false, status: 500, body: { error: "add_user failed" } },  // add_user — fails
      { ok: true, body: { ok: true } },         // delete PairingToken (rollback)
    ]);

    await expect(
      runTokenGeneration({
        opsEndpoint: OPS_URL,
        adminPass: ADMIN_PASS,
        fetchImpl: mockFetch as any,
      }),
    ).rejects.toThrow("Failed to create bootstrap user");

    // Rollback call should have been made
    expect(capturedBodies).toHaveLength(3);
    const rollbackCall = capturedBodies[2];
    expect(rollbackCall.operation).toBe("delete");
    expect(rollbackCall.table).toBe("PairingToken");
  });

  it("token-gen: rolls back PairingToken if add_user fails (network error)", async () => {
    let idx = 0;
    let capturedLocal: Array<Record<string, unknown>> = [];

    const mockFetch = mock(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedLocal.push(body);
      capturedBodies.push(body);
      idx++;

      if (idx === 1) {
        // upsert PairingToken — succeeds
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      } else if (idx === 2) {
        // add_user — network error
        throw new Error("ECONNREFUSED");
      } else {
        // rollback delete — succeeds
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      }
    });

    await expect(
      runTokenGeneration({
        opsEndpoint: OPS_URL,
        adminPass: ADMIN_PASS,
        fetchImpl: mockFetch as any,
      }),
    ).rejects.toThrow("Failed to create bootstrap user (network)");

    expect(capturedLocal).toHaveLength(3);
    expect(capturedLocal[2].operation).toBe("delete");
    expect(capturedLocal[2].table).toBe("PairingToken");
  });

  it("token-gen: username format is pair-bootstrap-<first8charsOfToken>", async () => {
    const mockFetch = makeFetch([
      { ok: true, body: { ok: true } },
      { ok: true, body: { ok: true } },
    ]);

    const result = await runTokenGeneration({
      opsEndpoint: OPS_URL,
      adminPass: ADMIN_PASS,
      fetchImpl: mockFetch as any,
    });

    expect(result.user).toBe(`pair-bootstrap-${result.token.slice(0, 8)}`);
  });

  // ── Pair success → drop bootstrap user ───────────────────────────────────

  it("pair-success: drops bootstrap user after successful Peer.put", async () => {
    const mockFetch = makeFetch([
      { ok: true, body: { ok: true } },  // drop_user succeeds
    ]);

    const pairingToken = "xY3kP9abQw8mNrTv"; // 16+ chars
    const result = await runPairSuccessDropUser({
      pairingToken,
      opsUrl: OPS_URL,
      adminPass: ADMIN_PASS,
      fetchImpl: mockFetch as any,
    });

    expect(result.dropped).toBe(true);
    expect(result.warned).toBe(false);

    // Check drop_user call
    expect(capturedBodies).toHaveLength(1);
    const dropCall = capturedBodies[0];
    expect(dropCall.operation).toBe("drop_user");
    expect(dropCall.username).toBe(`pair-bootstrap-${pairingToken.slice(0, 8)}`);
  });

  it("pair-success: does NOT fail response if drop_user fails (HTTP error)", async () => {
    const mockFetch = makeFetch([
      { ok: false, status: 500, body: { error: "drop failed" } },  // drop_user fails
    ]);

    const pairingToken = "tokenABCDxyz12345";
    const result = await runPairSuccessDropUser({
      pairingToken,
      opsUrl: OPS_URL,
      adminPass: ADMIN_PASS,
      fetchImpl: mockFetch as any,
    });

    // Pair response should succeed even if drop_user fails
    expect(result.dropped).toBe(false);
    expect(result.warned).toBe(true);  // logged a warning
  });

  it("pair-success: does NOT fail response if drop_user throws (network error)", async () => {
    const mockFetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });

    const pairingToken = "tokenNETWORK12345";
    const result = await runPairSuccessDropUser({
      pairingToken,
      opsUrl: OPS_URL,
      adminPass: ADMIN_PASS,
      fetchImpl: mockFetch as any,
    });

    expect(result.dropped).toBe(false);
    expect(result.warned).toBe(true);
  });

  it("pair-success: uses correct username format (pair-bootstrap-<first8>)", async () => {
    const mockFetch = makeFetch([
      { ok: true, body: { ok: true } },
    ]);

    const pairingToken = "longTokenWith8CharsPrefix_extra";
    await runPairSuccessDropUser({
      pairingToken,
      opsUrl: OPS_URL,
      adminPass: ADMIN_PASS,
      fetchImpl: mockFetch as any,
    });

    expect(capturedBodies[0].username).toBe(`pair-bootstrap-${pairingToken.slice(0, 8)}`);
  });
});
