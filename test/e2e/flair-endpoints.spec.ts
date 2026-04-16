import { test, expect } from "@playwright/test";

// ─── Auth helpers ────────────────────────────────────────────────────────────

function adminAuth(): Record<string, string> {
  const pass = process.env.FLAIR_ADMIN_PASS ?? "admin123";
  return {
    Authorization: "Basic " + Buffer.from(`admin:${pass}`).toString("base64"),
  };
}

// ─── Health & Status ─────────────────────────────────────────────────────────

test.describe("Health & Status", () => {
  test("GET /Health returns 200 with { ok: true }", async ({ request }) => {
    const res = await request.get("/Health", { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("GET /HealthDetail returns 200 with stats", async ({ request }) => {
    const res = await request.get("/HealthDetail", { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Should contain memory or agent stats
    expect(typeof body).toBe("object");
  });
});

// ─── Memory CRUD ─────────────────────────────────────────────────────────────

test.describe("Memory CRUD", () => {
  const memoryId = `playwright-e2e-${Date.now()}`;

  test("PUT /Memory/<id> creates a memory", async ({ request }) => {
    const res = await request.put(`/Memory/${memoryId}`, {
      headers: { ...adminAuth(), "Content-Type": "application/json" },
      data: {
        id: memoryId,
        agentId: "playwright-test",
        content: "Playwright E2E test memory — safe to delete",
        subject: "test",
        durability: "ephemeral",
      },
    });
    expect([200, 204]).toContain(res.status());
  });

  test("GET /Memory/<id> retrieves the created memory", async ({ request }) => {
    // Ensure memory exists first
    await request.put(`/Memory/${memoryId}`, {
      headers: { ...adminAuth(), "Content-Type": "application/json" },
      data: {
        id: memoryId,
        agentId: "playwright-test",
        content: "Playwright E2E test memory — safe to delete",
        subject: "test",
        durability: "ephemeral",
      },
    });

    const res = await request.get(`/Memory/${memoryId}`, { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(memoryId);
    expect(body.content).toContain("Playwright E2E");
  });

  test("DELETE /Memory/<id> removes the memory", async ({ request }) => {
    // Ensure memory exists first
    await request.put(`/Memory/${memoryId}`, {
      headers: { ...adminAuth(), "Content-Type": "application/json" },
      data: {
        id: memoryId,
        agentId: "playwright-test",
        content: "Playwright E2E test memory — safe to delete",
        subject: "test",
        durability: "ephemeral",
      },
    });

    const res = await request.delete(`/Memory/${memoryId}`, { headers: adminAuth() });
    expect([200, 204]).toContain(res.status());
  });

  test("GET /Memory/<id> after delete returns 404", async ({ request }) => {
    // Ensure memory is deleted
    await request.delete(`/Memory/${memoryId}`, { headers: adminAuth() });

    const res = await request.get(`/Memory/${memoryId}`, { headers: adminAuth() });
    expect(res.status()).toBe(404);
  });
});

// ─── Admin Pages (HTML) ──────────────────────────────────────────────────────

test.describe("Admin Pages", () => {
  test("GET /AdminDashboard returns 200 with correct HTML title", async ({ request }) => {
    const res = await request.get("/AdminDashboard", { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain("<title>Dashboard — Flair Admin</title>");
  });

  test("GET /AdminMemory returns 200 with HTML", async ({ request }) => {
    const res = await request.get("/AdminMemory", { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!DOCTYPE html>");
  });

  test("GET /AdminPrincipals returns 200 with HTML", async ({ request }) => {
    const res = await request.get("/AdminPrincipals", { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!DOCTYPE html>");
  });
});

// ─── OAuth Discovery ─────────────────────────────────────────────────────────

test.describe("OAuth Discovery", () => {
  test("GET /OAuthMetadata returns 200 with required fields", async ({ request }) => {
    const res = await request.get("/OAuthMetadata", { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("issuer");
    expect(body).toHaveProperty("authorization_endpoint");
    expect(body).toHaveProperty("token_endpoint");
  });

  test("POST /OAuthRegister with valid client data returns client_id", async ({ request }) => {
    const res = await request.post("/OAuthRegister", {
      headers: { ...adminAuth(), "Content-Type": "application/json" },
      data: {
        client_name: "Playwright E2E Test Client",
        redirect_uris: ["https://claude.com/api/mcp/auth_callback"],
        grant_types: ["authorization_code"],
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("client_id");
    expect(typeof body.client_id).toBe("string");
    expect(body.client_id.length).toBeGreaterThan(0);
  });
});

// ─── Federation ──────────────────────────────────────────────────────────────

test.describe("Federation", () => {
  test("GET /FederationInstance returns 200 with id, publicKey, role", async ({ request }) => {
    const res = await request.get("/FederationInstance", { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("publicKey");
    expect(body).toHaveProperty("role");
  });

  test("GET /FederationPeers returns 200 with peers array", async ({ request }) => {
    const res = await request.get("/FederationPeers", { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("peers");
    expect(Array.isArray(body.peers)).toBe(true);
  });
});

// ─── Semantic Search ─────────────────────────────────────────────────────────

test.describe("Semantic Search", () => {
  test("POST /SemanticSearch returns 200 with results array", async ({ request }) => {
    const res = await request.post("/SemanticSearch", {
      headers: { ...adminAuth(), "Content-Type": "application/json" },
      data: {
        agentId: "playwright-test",
        query: "test memory",
        limit: 5,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("results");
    expect(Array.isArray(body.results)).toBe(true);
  });
});
