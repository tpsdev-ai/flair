import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

// flair#1951 — FlairClient must never SEND admin Basic credentials over plain
// http:// to a non-loopback host. The refusal happens BEFORE any request.
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
  mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { FlairClient } = await import("../src/client.js");

const ADMIN_USER = "admin";
const ADMIN_PASS = "s3cret-pass";
const NO_KEY = "/nonexistent/does-not-exist.key";

function basicClient(url: string) {
  return new FlairClient({
    agentId: "basic-transport-agent",
    url,
    adminUser: ADMIN_USER,
    adminPassword: ADMIN_PASS,
    keyPath: NO_KEY,
  });
}

function lastHeaders(): Record<string, string> {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return (call?.[1] as any)?.headers ?? {};
}

describe("flair#1951 — admin Basic credentials are refused over plain http to a remote host", () => {
  test("(b1) Basic to http://flair.example.test:19926 refuses and makes NO request", async () => {
    const client = basicClient("http://flair.example.test:19926");

    await expect(client.request("GET", "/Health")).rejects.toThrow(
      "refusing to send admin Basic credentials over plain http to flair.example.test",
    ); // assertion: the refusal fires
    expect(mockFetch).not.toHaveBeenCalled(); // assertion: no request was made
  });

  test("(b2) Basic to https://flair.example.test is allowed (request made with the Basic header)", async () => {
    const client = basicClient("https://flair.example.test:19926");

    await client.request("GET", "/Health");

    expect(mockFetch).toHaveBeenCalledTimes(1); // assertion: the request is made
    expect(lastHeaders()["Authorization"]).toBe(
      `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64")}`,
    ); // assertion: the Basic header is sent
  });

  test("(b3) Basic to loopback http (127.0.0.1, localhost, [::1]) is allowed", async () => {
    for (const url of ["http://127.0.0.1:19926", "http://localhost:19926", "http://[::1]:19926"]) {
      mockFetch.mockClear();
      const client = basicClient(url);
      await client.request("GET", "/Health");
      expect(mockFetch).toHaveBeenCalledTimes(1); // assertion: allowed + requested
      expect(lastHeaders()["Authorization"]?.startsWith("Basic ")).toBe(true); // assertion
    }
  });

  test("(b4) a SIGNED request to a remote http:// URL is unchanged (no refusal)", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const client = new FlairClient({
      agentId: "signed-agent",
      url: "http://flair.example.test:19926",
      privateKey,
    });

    await client.request("GET", "/Health");

    expect(mockFetch).toHaveBeenCalledTimes(1); // assertion: the signed request is made
    expect(lastHeaders()["Authorization"]?.startsWith("TPS-Ed25519 ")).toBe(true); // assertion
  });

  test("(b5) the error names the host and remedy, and contains neither the password nor the Authorization header", async () => {
    const client = basicClient("http://flair.example.test:19926");

    let message = "";
    try {
      await client.request("GET", "/Health");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("admin Basic credentials"); // assertion: the actor
    expect(message).toContain("flair.example.test"); // assertion: the host
    expect(message).toContain("use an https:// FLAIR_URL, or an Ed25519 key for this agent"); // assertion: the remedy
    expect(message).not.toContain(ADMIN_PASS); // assertion: no password
    const authHeader = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64")}`;
    expect(message).not.toContain(authHeader); // assertion: no Authorization header value
  });

  test("(b6) a path that does not start with / is refused and makes NO request, even on loopback", async () => {
    const client = basicClient("http://localhost:19926");

    await expect(client.request("GET", "@other.test/Health")).rejects.toThrow('must start with "/"');
    expect(mockFetch).not.toHaveBeenCalled(); // assertion: no request was made
  });

  test("(b7) the request goes to the URL that was checked (FLAIR_URL's host)", async () => {
    const client = basicClient("http://127.0.0.1:19926");

    await client.request("GET", "/Health");

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(new URL(url).host).toBe("127.0.0.1:19926"); // assertion: same host as FLAIR_URL
  });

  test("(b8) the remote-http refusal names the host and the remedy, never the credentials", async () => {
    const remote = basicClient("http://flair.example.test:19926");
    let message = "";
    try {
      await remote.request("GET", "/Health");
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toContain("flair.example.test");
    expect(message).toContain("use an https:// FLAIR_URL, or an Ed25519 key");
    expect(message).not.toContain(ADMIN_PASS);
  });
});

