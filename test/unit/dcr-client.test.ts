/**
 * Tests for src/lib/dcr-client.ts — the DCR gate-token location contract
 * (flair#746, Kern's #719 verdict condition 1) and the RFC 7591 DCR HTTP
 * client extracted for the future `flair mcp enable` builder.
 *
 * Covers: env-var-first / 0600-file-fallback precedence, the "neither
 * location has a value" failure mode (requireDcrToken's actionable error),
 * refusing a world/group-readable token file, and registerDcrClient's
 * request shape + success/error response handling (mocked fetch — no real
 * DCR endpoint is ever contacted).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DCR_TOKEN_ENV,
  defaultDcrTokenFilePath,
  readDcrToken,
  requireDcrToken,
  DcrTokenNotFoundError,
  DcrTokenFilePermissionError,
  registerDcrClient,
  DcrRegisterError,
} from "../../src/lib/dcr-client.ts";

let dir: string;
const originalEnv = process.env[DCR_TOKEN_ENV];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-dcr-client-"));
  delete process.env[DCR_TOKEN_ENV];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env[DCR_TOKEN_ENV];
  else process.env[DCR_TOKEN_ENV] = originalEnv;
});

// ─── token-location contract ────────────────────────────────────────────────

describe("readDcrToken / requireDcrToken — location contract", () => {
  test("env var wins when set", () => {
    process.env[DCR_TOKEN_ENV] = "env-token-value";
    const filePath = join(dir, "mcp-dcr-token");
    writeFileSync(filePath, "file-token-value", { mode: 0o600 });

    const result = readDcrToken({ filePath });
    expect(result).toEqual({ token: "env-token-value", source: "env" });
  });

  test("falls back to the 0600 file when env is unset", () => {
    const filePath = join(dir, "mcp-dcr-token");
    writeFileSync(filePath, "file-token-value\n", { mode: 0o600 });

    const result = readDcrToken({ filePath });
    expect(result).toEqual({ token: "file-token-value", source: "file", path: filePath });
  });

  test("returns null when neither env nor file has a value", () => {
    const filePath = join(dir, "does-not-exist");
    expect(readDcrToken({ filePath })).toBeNull();
  });

  test("empty env var is treated as unset (falls through to file)", () => {
    process.env[DCR_TOKEN_ENV] = "   ";
    const filePath = join(dir, "mcp-dcr-token");
    writeFileSync(filePath, "file-token-value", { mode: 0o600 });

    const result = readDcrToken({ filePath });
    expect(result?.source).toBe("file");
  });

  test("refuses a world-readable token file (fails closed, does not read the value)", () => {
    const filePath = join(dir, "mcp-dcr-token");
    writeFileSync(filePath, "file-token-value", { mode: 0o644 });
    chmodSync(filePath, 0o644);

    expect(() => readDcrToken({ filePath })).toThrow(DcrTokenFilePermissionError);
  });

  test("requireDcrToken throws DcrTokenNotFoundError with an actionable message when absent", () => {
    const filePath = join(dir, "does-not-exist");
    let thrown: unknown;
    try {
      requireDcrToken({ filePath });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DcrTokenNotFoundError);
    expect((thrown as Error).message).toContain("flair mcp enable");
    expect((thrown as Error).message).toContain(DCR_TOKEN_ENV);
  });

  test("requireDcrToken returns the resolved token when present", () => {
    process.env[DCR_TOKEN_ENV] = "present-token";
    const result = requireDcrToken({ filePath: join(dir, "unused") });
    expect(result.token).toBe("present-token");
    expect(result.source).toBe("env");
  });

  test("defaultDcrTokenFilePath points under ~/.flair", () => {
    expect(defaultDcrTokenFilePath()).toContain(join(".flair", "mcp-dcr-token"));
  });
});

// ─── registerDcrClient ───────────────────────────────────────────────────────

describe("registerDcrClient — RFC 7591 DCR HTTP client", () => {
  test("POSTs the expected shape and returns the issued client_id on 201", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          client_id: "abc-123",
          client_name: "test client",
          redirect_uris: ["https://claude.com/api/mcp/auth_callback"],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await registerDcrClient({
      issuer: "https://flair.example.com",
      dcrToken: "secret-dcr-token",
      redirectUris: ["https://claude.com/api/mcp/auth_callback"],
      clientName: "test client",
      fetchImpl,
    });

    expect(result.client_id).toBe("abc-123");
    expect(capturedUrl).toBe("https://flair.example.com/oauth/mcp/register");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-dcr-token");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.redirect_uris).toEqual(["https://claude.com/api/mcp/auth_callback"]);
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_name).toBe("test client");
  });

  test("strips a trailing slash from issuer when deriving the endpoint", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ client_id: "x" }), { status: 201 });
    }) as typeof fetch;

    await registerDcrClient({
      issuer: "https://flair.example.com/",
      dcrToken: "t",
      redirectUris: ["https://claude.com/api/mcp/auth_callback"],
      fetchImpl,
    });
    expect(capturedUrl).toBe("https://flair.example.com/oauth/mcp/register");
  });

  test("throws DcrRegisterError with status + error code on a 401 (bad/missing gate token)", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_token", error_description: "Invalid initial access token" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await expect(
      registerDcrClient({
        issuer: "https://flair.example.com",
        dcrToken: "wrong-token",
        redirectUris: ["https://claude.com/api/mcp/auth_callback"],
        fetchImpl,
      }),
    ).rejects.toThrow(DcrRegisterError);
  });

  test("throws on a 400 invalid_client_metadata (e.g. client_credentials grant_type rejected)", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_client_metadata", error_description: "Unsupported grant_type: client_credentials" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    let thrown: unknown;
    try {
      await registerDcrClient({
        issuer: "https://flair.example.com",
        dcrToken: "t",
        redirectUris: ["https://claude.com/api/mcp/auth_callback"],
        grantTypes: ["client_credentials"],
        fetchImpl,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DcrRegisterError);
    expect((thrown as DcrRegisterError).status).toBe(400);
    expect((thrown as DcrRegisterError).error).toBe("invalid_client_metadata");
  });

  test("requires redirectUris to be a non-empty array", async () => {
    await expect(
      registerDcrClient({
        issuer: "https://flair.example.com",
        dcrToken: "t",
        redirectUris: [],
      }),
    ).rejects.toThrow(/redirectUris/);
  });

  test("requires either issuer or registerEndpoint", async () => {
    await expect(
      registerDcrClient({
        dcrToken: "t",
        redirectUris: ["https://claude.com/api/mcp/auth_callback"],
      } as any),
    ).rejects.toThrow(/issuer or registerEndpoint/);
  });

  test("requires dcrToken", async () => {
    await expect(
      registerDcrClient({
        issuer: "https://flair.example.com",
        dcrToken: "",
        redirectUris: ["https://claude.com/api/mcp/auth_callback"],
      }),
    ).rejects.toThrow(/dcrToken/);
  });
});
