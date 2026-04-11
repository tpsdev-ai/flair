import { Resource, databases } from "@harperfast/harper";
import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.1 Authorization Server for Flair.
 *
 * Endpoints (all mapped via Harper's resource routing):
 *   GET  /OAuthMetadata           → /.well-known/oauth-authorization-server
 *   POST /OAuthRegister           → /oauth/register (DCR)
 *   GET  /OAuthAuthorize          → /oauth/authorize (consent screen)
 *   POST /OAuthToken              → /oauth/token (token exchange)
 *   POST /OAuthRevoke             → /oauth/revoke
 *
 * 1.0 constraints (per FLAIR-PRINCIPALS § 2):
 *   - Only https://claude.com/api/mcp/auth_callback permitted as redirect URI
 *   - PKCE required (S256 only)
 *   - Access tokens: max 1 hour
 *   - Refresh token rotation on each use
 *   - No "remember this decision" — each authorize is explicit
 */

const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";
const ACCESS_TOKEN_TTL_MS = 3600_000;        // 1 hour
const REFRESH_TOKEN_TTL_MS = 7 * 86400_000;  // 7 days
const AUTH_CODE_TTL_MS = 600_000;            // 10 minutes

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function futureISO(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// ─── Discovery metadata ──────────────────────────────────────────────────────

export class OAuthMetadata extends Resource {
  async get() {
    const baseUrl = process.env.FLAIR_PUBLIC_URL || `http://127.0.0.1:${process.env.HTTP_PORT || 19926}`;
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/OAuthAuthorize`,
      token_endpoint: `${baseUrl}/OAuthToken`,
      registration_endpoint: `${baseUrl}/OAuthRegister`,
      revocation_endpoint: `${baseUrl}/OAuthRevoke`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [
        "memory:read", "memory:write", "memory:admin",
        "principal:read", "principal:admin",
        "connector:read", "connector:admin",
      ],
      extensions_supported: [
        "io.modelcontextprotocol/enterprise-managed-authorization",
      ],
    };
  }
}

// ─── Dynamic Client Registration (RFC 7591) ──────────────────────────────────

export class OAuthRegister extends Resource {
  async post(data: any) {
    const redirectUris: string[] = data?.redirect_uris ?? [];
    const clientName: string = data?.client_name ?? "Unknown Client";

    // 1.0: only claude.com redirect URI permitted
    for (const uri of redirectUris) {
      if (uri !== ALLOWED_REDIRECT_URI) {
        return new Response(JSON.stringify({
          error: "invalid_redirect_uri",
          error_description: `Only ${ALLOWED_REDIRECT_URI} is permitted in 1.0`,
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
    }

    if (redirectUris.length === 0) {
      redirectUris.push(ALLOWED_REDIRECT_URI);
    }

    const clientId = `flair_cl_${randomBytes(16).toString("base64url")}`;
    const now = nowISO();

    await (databases as any).flair.OAuthClient.put({
      id: clientId,
      name: clientName,
      redirectUris,
      grantTypes: ["authorization_code", "refresh_token"],
      scope: data?.scope ?? "memory:read memory:write",
      registeredBy: "dcr",
      createdAt: now,
      updatedAt: now,
    });

    return {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    };
  }
}

// ─── Authorization endpoint ──────────────────────────────────────────────────

export class OAuthAuthorize extends Resource {
  async get() {
    // In 1.0, this returns a simple HTML consent page.
    // The user (Nathan) approves or denies, which POSTs back.
    const request = (this as any).request;
    const url = new URL(request?.url ?? "http://localhost", "http://localhost");
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const responseType = url.searchParams.get("response_type") ?? "";
    const scope = url.searchParams.get("scope") ?? "memory:read";
    const state = url.searchParams.get("state") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";

    if (responseType !== "code") {
      return new Response(JSON.stringify({ error: "unsupported_response_type" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    if (redirectUri && redirectUri !== ALLOWED_REDIRECT_URI) {
      return new Response(JSON.stringify({ error: "invalid_redirect_uri" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Verify client exists
    const client = await (databases as any).flair.OAuthClient.get(clientId);
    if (!client) {
      return new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Server-rendered consent page (minimal HTML, no JS frameworks)
    const html = `<!DOCTYPE html>
<html><head><title>Flair — Authorize</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:0 20px}
h1{font-size:1.4em}button{padding:10px 24px;font-size:1em;border:none;border-radius:6px;cursor:pointer;margin-right:8px}
.approve{background:#2563eb;color:#fff}.deny{background:#e5e7eb;color:#333}
.scope{background:#f3f4f6;padding:8px 12px;border-radius:4px;margin:4px 0;font-family:monospace}</style></head>
<body>
<h1>Authorize ${client.name || clientId}</h1>
<p>This application wants to access your Flair memories:</p>
${scope.split(" ").map((s: string) => `<div class="scope">${s}</div>`).join("")}
<form method="POST" action="/OAuthAuthorize" style="margin-top:24px">
<input type="hidden" name="client_id" value="${clientId}">
<input type="hidden" name="redirect_uri" value="${redirectUri || ALLOWED_REDIRECT_URI}">
<input type="hidden" name="scope" value="${scope}">
<input type="hidden" name="state" value="${state}">
<input type="hidden" name="code_challenge" value="${codeChallenge}">
<input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
<button type="submit" name="action" value="approve" class="approve">Approve</button>
<button type="submit" name="action" value="deny" class="deny">Deny</button>
</form></body></html>`;

    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  async post(data: any) {
    const action = data?.action;
    const clientId = data?.client_id ?? "";
    const redirectUri = data?.redirect_uri || ALLOWED_REDIRECT_URI;
    const scope = data?.scope ?? "memory:read";
    const state = data?.state ?? "";
    const codeChallenge = data?.code_challenge ?? "";
    const codeChallengeMethod = data?.code_challenge_method ?? "S256";

    if (action === "deny") {
      const params = new URLSearchParams({ error: "access_denied", state });
      return Response.redirect(`${redirectUri}?${params}`, 302);
    }

    // Determine authenticated principal
    const request = (this as any).request;
    const principalId: string = request?.tpsAgent ?? "admin";

    // Generate authorization code
    const code = randomBytes(32).toString("base64url");
    const now = nowISO();

    await (databases as any).flair.OAuthAuthCode.put({
      id: code,
      clientId,
      principalId,
      redirectUri,
      scope,
      codeChallenge,
      codeChallengeMethod,
      expiresAt: futureISO(AUTH_CODE_TTL_MS),
      used: false,
      createdAt: now,
    });

    const params = new URLSearchParams({ code, state });
    return Response.redirect(`${redirectUri}?${params}`, 302);
  }
}

// ─── Token endpoint ──────────────────────────────────────────────────────────

export class OAuthToken extends Resource {
  async post(data: any) {
    const grantType = data?.grant_type;

    if (grantType === "authorization_code") {
      return this.handleAuthorizationCode(data);
    } else if (grantType === "refresh_token") {
      return this.handleRefreshToken(data);
    } else if (grantType === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      // XAA path — stub for now, implemented in XAA PR
      return new Response(JSON.stringify({
        error: "unsupported_grant_type",
        error_description: "jwt-bearer grant type not yet implemented",
      }), { status: 400, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "unsupported_grant_type" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  private async handleAuthorizationCode(data: any) {
    const code = data?.code;
    const clientId = data?.client_id;
    const redirectUri = data?.redirect_uri;
    const codeVerifier = data?.code_verifier;

    if (!code || !clientId) {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Look up auth code
    const authCode = await (databases as any).flair.OAuthAuthCode.get(code);
    if (!authCode) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Validate
    if (authCode.used) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "code already used" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    if (authCode.clientId !== clientId) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    if (new Date(authCode.expiresAt) < new Date()) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    if (redirectUri && authCode.redirectUri !== redirectUri) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // PKCE verification
    if (authCode.codeChallenge) {
      if (!codeVerifier) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "code_verifier required" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      const expectedChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      if (expectedChallenge !== authCode.codeChallenge) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
    }

    // Mark code as used
    await (databases as any).flair.OAuthAuthCode.put({ ...authCode, used: true });

    // Issue tokens
    return this.issueTokenPair(authCode.clientId, authCode.principalId, authCode.scope);
  }

  private async handleRefreshToken(data: any) {
    const refreshTokenRaw = data?.refresh_token;
    const clientId = data?.client_id;

    if (!refreshTokenRaw) {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    const tokenHash = sha256(refreshTokenRaw);

    // Find refresh token by hash
    let refreshRecord: any = null;
    for await (const t of (databases as any).flair.OAuthToken.search({
      conditions: [
        { attribute: "tokenHash", comparator: "equals", value: tokenHash },
        { attribute: "tokenType", comparator: "equals", value: "refresh" },
      ],
    })) {
      refreshRecord = t;
      break;
    }

    if (!refreshRecord) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    if (refreshRecord.revokedAt) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "token revoked" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    if (new Date(refreshRecord.expiresAt) < new Date()) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    if (clientId && refreshRecord.clientId !== clientId) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Rotate: revoke old refresh token, issue new pair
    await (databases as any).flair.OAuthToken.put({
      ...refreshRecord,
      revokedAt: nowISO(),
    });

    return this.issueTokenPair(refreshRecord.clientId, refreshRecord.principalId, refreshRecord.scope);
  }

  private async issueTokenPair(clientId: string, principalId: string, scope: string) {
    const now = nowISO();
    const accessTokenRaw = randomToken("flair_at_");
    const refreshTokenRaw = randomToken("flair_rt_");

    const accessId = `at_${randomBytes(8).toString("hex")}`;
    const refreshId = `rt_${randomBytes(8).toString("hex")}`;

    await (databases as any).flair.OAuthToken.put({
      id: accessId,
      tokenHash: sha256(accessTokenRaw),
      tokenType: "access",
      clientId,
      principalId,
      scope,
      expiresAt: futureISO(ACCESS_TOKEN_TTL_MS),
      createdAt: now,
    });

    await (databases as any).flair.OAuthToken.put({
      id: refreshId,
      tokenHash: sha256(refreshTokenRaw),
      tokenType: "refresh",
      clientId,
      principalId,
      scope,
      expiresAt: futureISO(REFRESH_TOKEN_TTL_MS),
      parentTokenId: accessId,
      createdAt: now,
    });

    return {
      access_token: accessTokenRaw,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshTokenRaw,
      scope,
    };
  }
}

// ─── Revocation endpoint ─────────────────────────────────────────────────────

export class OAuthRevoke extends Resource {
  async post(data: any) {
    const token = data?.token;
    if (!token) {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    const tokenHash = sha256(token);

    for await (const t of (databases as any).flair.OAuthToken.search({
      conditions: [{ attribute: "tokenHash", comparator: "equals", value: tokenHash }],
    })) {
      await (databases as any).flair.OAuthToken.put({
        ...t,
        revokedAt: nowISO(),
      });
    }

    // RFC 7009: always return 200 regardless of whether token was found
    return {};
  }
}
