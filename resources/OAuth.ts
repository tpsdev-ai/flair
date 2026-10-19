import { Resource, databases } from "harper";
import { createHash, randomBytes } from "node:crypto";
import { handleJwtBearerGrant } from "./XAA.js";
import { resolveAgentAuth } from "./agent-auth.js";
import {
  claimOAuthSingleUse,
  oauthSingleUseDeps,
  reportReplayStoreGapsAtBoot,
  type ReplayStoreBootStore,
} from "./replay-store.js";
import { decideRegistration } from "./dcr-gate.js";
import { buildAuthorizationServerMetadata } from "./oauth-discovery.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { withKeyLock } from "./key-lock.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { esc } from "./admin-layout.js";

/**
 * OAuth 2.1 Authorization Server for Flair.
 *
 * Endpoints (all mapped via Harper's resource routing):
 *   GET  /OAuthMetadata           → alias of /.well-known/oauth-authorization-server
 *   POST /OAuthRegister           → /oauth/register (DCR)
 *   GET  /OAuthAuthorize          → /oauth/authorize (consent screen)
 *   POST /OAuthToken              → /oauth/token (token exchange)
 *   POST /OAuthRevoke             → /oauth/revoke
 *
 * 1.0 constraints (per FLAIR-PRINCIPALS § 2):
 *   - Only https://claude.com/api/mcp/auth_callback permitted as redirect URI
 *   - PKCE required (S256 only): GET and POST /OAuthAuthorize refuse a request
 *     without an S256 code_challenge (checkConsentPkce), and the token
 *     endpoint requires the stored challenge and a matching code_verifier
 *   - Access tokens: max 1 hour
 *   - Refresh token rotation on each use
 *   - No "remember this decision" — each authorize is explicit
 */

const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";
// The callback's ORIGIN, derived from the SAME constant the redirect_uri check
// uses — never a second literal. The consent form's POST answers with a 302 to
// this origin, and `form-action` is enforced across redirects, so it must be an
// allowed form-action target.
const ALLOWED_REDIRECT_ORIGIN = new URL(ALLOWED_REDIRECT_URI).origin;
const ACCESS_TOKEN_TTL_MS = 3600_000;        // 1 hour
const REFRESH_TOKEN_TTL_MS = 7 * 86400_000;  // 7 days
const AUTH_CODE_TTL_MS = 600_000;            // 10 minutes

/**
 * Seconds before a claim to redeem a code or rotate a refresh token may be
 * removed (schemas/oauth.graphql: `expiration:` on `OAuthSingleUse`). MUST
 * equal that value — both pinned by
 * test/unit-isolated/oauth-single-use-2145.test.ts. It must outlive the longest
 * either can be presented after its row is recorded: AUTH_CODE_TTL_MS, and
 * REFRESH_TOKEN_TTL_MS.
 */
export const OAUTH_SINGLE_USE_RETENTION_S = 691_200; // 8 days

/**
 * The longest a code or refresh token can be presented after its row is
 * recorded (AUTH_CODE_TTL_MS for a code, REFRESH_TOKEN_TTL_MS for a refresh
 * token): the store must outlive this, and the boot report names a table that
 * does not.
 */
export const OAUTH_SINGLE_USE_MIN_RETENTION_MS = Math.max(AUTH_CODE_TTL_MS, REFRESH_TOKEN_TTL_MS);

// Once per worker thread at boot, with the replay guards' own report: a
// misconfigured OAuthSingleUse table is named before the first redemption.
export const OAUTH_SINGLE_USE_BOOT_STORE: ReplayStoreBootStore = {
  label: "OAuth single-use",
  deps: oauthSingleUseDeps,
  minRetentionMs: OAUTH_SINGLE_USE_MIN_RETENTION_MS,
  retentionBasis: "a redeemed authorization code or refresh token can be presented",
};
reportReplayStoreGapsAtBoot(OAUTH_SINGLE_USE_BOOT_STORE);

/** A store error: nothing is issued, and the caller may retry (fail closed). */
function storeUnavailable(): Response {
  return new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "replay_store_unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Within one Harper process, rotation and revoke share a per-refresh-token
 * lock (resources/key-lock.ts). Rotation holds it across its claim, committed
 * row re-read, write and issuance; revoke takes it before writing `revokedAt`.
 */
const OAUTH_TOKEN_LOCK_NAMESPACE = "flair-oauth-token";
/** The wait for the token's other holder: at most OAUTH_TOKEN_LOCK_ATTEMPTS × OAUTH_TOKEN_LOCK_WAIT_MS. */
const OAUTH_TOKEN_LOCK_ATTEMPTS = 200;
const OAUTH_TOKEN_LOCK_WAIT_MS = 10;

type LifecycleOutcome<T> = { ok: true; value: T } | { ok: false; response: Response };

/** 503: this process's lock for this token's rotation and revoke stayed held. */
function tokenLifecycleBusy(): Response {
  return new Response(JSON.stringify({
    error: "temporarily_unavailable",
    error_description: "token_lifecycle_in_progress",
  }), { status: 503, headers: { "content-type": "application/json" } });
}

/**
 * Run `fn` holding this process's lock on refresh token `tokenHash`. A caller
 * that cannot take the lock is refused — 503 `busy` when the lock stayed held
 * elsewhere, 503 when the store has no lock — and `fn` does not run.
 */
async function withTokenLifecycleLock<T>(
  tokenHash: string,
  fn: () => Promise<T>,
): Promise<LifecycleOutcome<T>> {
  const store = (databases as any)?.flair?.OAuthToken?.primaryStore;
  const outcome = await withKeyLock(
    store,
    [OAUTH_TOKEN_LOCK_NAMESPACE, tokenHash],
    fn,
    OAUTH_TOKEN_LOCK_ATTEMPTS,
    OAUTH_TOKEN_LOCK_WAIT_MS,
  );
  if (outcome.kind === "done") return { ok: true, value: outcome.value };
  if (outcome.kind === "busy") return { ok: false, response: tokenLifecycleBusy() };
  return { ok: false, response: storeUnavailable() };
}

/**
 * The scopes this server can issue, straight from the authorization-server
 * metadata — ONE source of truth, so the consent page can never render a scope
 * the token endpoint would later refuse.
 */
const SUPPORTED_SCOPES = new Set<string>(buildAuthorizationServerMetadata().scopes_supported);

/** The scope a consent request names when it names none, or only whitespace. */
const DEFAULT_CONSENT_SCOPE = "memory:read";

/**
 * The scope a consent request names: `memory:read` when the field is absent
 * (`undefined`), else the string trimmed, `memory:read` when that is blank.
 * Any other value — `null`, a number, an array, an object — gives `null`,
 * which checkConsentScope refuses with invalid_scope. get() passes an absent
 * query parameter as `undefined`.
 */
function consentScope(raw: unknown): string | null {
  if (raw === undefined) return DEFAULT_CONSENT_SCOPE;
  if (typeof raw !== "string") return null;
  return raw.trim() || DEFAULT_CONSENT_SCOPE;
}

type ConsentCheck<T> = { ok: true } & T | { ok: false; response: Response };

/**
 * Every requested scope must be one the server advertises (RFC 6749
 * §4.1.2.1: invalid_scope). The consent page (GET) and the consent form's POST
 * both run this, before checkConsentClient.
 */
function checkConsentScope(scope: string | null): ConsentCheck<{ scope: string; scopeTokens: string[] }> {
  if (scope !== null) {
    const scopeTokens = scope.split(/\s+/).filter(Boolean);
    if (scopeTokens.every((s) => SUPPORTED_SCOPES.has(s))) return { ok: true, scope, scopeTokens };
  }
  return {
    ok: false,
    response: new Response(JSON.stringify({
      error: "invalid_scope",
      error_description: "one or more requested scopes are not supported by this server",
    }), { status: 400, headers: { "content-type": "application/json" } }),
  };
}

/**
 * The OAuthClient record for `clientId` must exist (invalid_client). The
 * consent page (GET) and the consent form's POST both run this, after
 * checkConsentScope; the POST runs it before any authorization code is issued.
 * post() passes the body's value as received; get() passes the query
 * parameter, an absent one as the empty string. A value that is not a string
 * (`undefined`, `null`, a number, an array, an object) is refused without a
 * lookup; every string is looked up, the empty string included.
 */
async function checkConsentClient(clientId: unknown): Promise<ConsentCheck<{ client: any }>> {
  const client = typeof clientId === "string"
    ? await (databases as any).flair.OAuthClient.get(clientId)
    : null;
  if (!client) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 400, headers: { "content-type": "application/json" },
      }),
    };
  }
  return { ok: true, client };
}

/**
 * An S256 `code_challenge` (RFC 7636 §4.2): 43 to 128 characters of the
 * base64url alphabet. BASE64URL(SHA256(verifier)) is always 43 of them.
 */
const S256_CODE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * PKCE is required, S256 only — what the metadata advertises
 * (`code_challenge_methods_supported: ["S256"]`). `code_challenge` must be a
 * string matching S256_CODE_CHALLENGE and `code_challenge_method` exactly
 * "S256"; anything else (absent, empty, not a string, "plain") is refused with
 * 400 invalid_request. The consent page (GET) and the consent form's POST both
 * run this, after checkConsentClient: GET before rendering the form, POST
 * before authentication and before any authorization code is issued or stored.
 */
function checkConsentPkce(codeChallenge: unknown, codeChallengeMethod: unknown): ConsentCheck<{ codeChallenge: string }> {
  const refuse = (description: string): ConsentCheck<{ codeChallenge: string }> => ({
    ok: false,
    response: new Response(JSON.stringify({ error: "invalid_request", error_description: description }), {
      status: 400, headers: { "content-type": "application/json" },
    }),
  });
  if (typeof codeChallenge !== "string" || !S256_CODE_CHALLENGE.test(codeChallenge)) {
    return refuse("PKCE is required: code_challenge must be an S256 challenge of 43-128 base64url characters");
  }
  if (codeChallengeMethod !== "S256") {
    return refuse("PKCE is required: code_challenge_method must be S256");
  }
  return { ok: true, codeChallenge };
}

/** `state` is an opaque passthrough: printable ASCII, bounded (RFC 6749 §4.1.2). */
const STATE_MAX_LENGTH = 512;
function isOpaqueState(value: string): boolean {
  if (value.length > STATE_MAX_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

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

/**
 * 302 redirect — deliberately NOT `Response.redirect()`.
 *
 * FOUND while writing the real-Harper integration test for #604 (this exact
 * gap is why the coverage doc above calls OAuthAuthorize.post() untestable
 * without a running Harper instance — no test had ever hit this path over
 * real HTTP before). Pre-existing on main, unrelated to the #604 auth fix:
 * per the Fetch spec, `Response.redirect(url, status)` constructs a Response
 * whose Headers guard is set to "immutable". Harper's own HTTP response
 * pipeline mutates the handler's returned Response's headers afterward (e.g.
 * CORS/instrumentation headers) — against an immutable-guarded Headers this
 * throws `TypeError: immutable`, turning EVERY real POST /OAuthAuthorize
 * (both "deny" and "approve") into a 500, verified via curl against a built
 * origin/main with no other changes. A manually-constructed Response with
 * the same status/Location header has the default (mutable) "response"
 * guard, so Harper's later mutation succeeds — identical bytes on the wire,
 * no behavior change, just a mutable Headers object underneath.
 */
function redirectTo(url: string, status: 302 | 303 = 302): Response {
  return new Response(null, { status, headers: { Location: url } });
}

// ─── Discovery metadata ──────────────────────────────────────────────────────

/**
 * `/OAuthMetadata` — an ALIAS of `/.well-known/oauth-authorization-server`
 * (flair#1000), not a second implementation.
 *
 * The document body moved verbatim to `buildAuthorizationServerMetadata()` in
 * resources/oauth-discovery.ts and BOTH paths now call it. The well-known path
 * is the one RFC 8414 defines and the one every client probes; this path is
 * kept because it is what shipped, is referenced by docs/auth.md and by
 * deployed callers, and costs one delegating line. Keeping it as an alias
 * rather than as an independent handler is the whole point: two endpoints that
 * can drift apart is the failure mode, and after this change there is no code
 * path that can produce one document without producing the other.
 */
export class OAuthMetadata extends Resource {
  // OAuth discovery metadata is intentionally public — RFC 8414 § 3 requires
  // it be accessible without authentication so clients can bootstrap their
  // flow. `allowRead() { return true }` opens Harper's role gate so remote
  // operators (e.g. Fabric-hosted Flair) get the metadata document instead
  // of a 401 from Harper's intrinsic auth layer. Same pattern as Health (#386).
  allowRead() { return true; }

  async get() {
    return buildAuthorizationServerMetadata();
  }
}

// ─── Dynamic Client Registration (RFC 7591) ──────────────────────────────────

export class OAuthRegister extends Resource {
  // Dynamic Client Registration (RFC 7591) — clients must be able to register
  // anonymously to bootstrap. Validation (redirect_uri allow-list, etc.)
  // happens in post(). Pattern matches FederationPair.allowCreate (#299).
  //
  // This stays `true` — it is Harper's ROLE gate, and returning false here would
  // answer with Harper's own 403 body instead of an RFC 7591-shaped error. WHO
  // may register is decided in post() via resources/dcr-gate.ts, in one place.
  // Deliberately not enforced in both: one condition in two places is how the
  // two drift apart.
  allowCreate() { return true; }

  async post(data: any) {
    // Registration gate FIRST — before the redirect-URI policy is applied,
    // before anything is read off the body, and before any write. A caller who
    // may not register learns only that; running the redirect-URI check first
    // would turn a closed endpoint into a probe for what this server accepts.
    const decision = decideRegistration((this as any).getContext?.()?.request ?? (this as any).getContext?.());
    if (!decision.allowed) {
      if (decision.reason === "disabled") {
        return new Response(JSON.stringify({
          error: "access_denied",
          error_description:
            "dynamic client registration is not enabled on this server " +
            "(set FLAIR_OAUTH_DCR_TOKEN to enable it)",
        }), { status: 403, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        error: "invalid_token",
        error_description: "a valid initial access token is required to register a client",
      }), { status: 401, headers: { "content-type": "application/json" } });
    }

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
  // OAuth authorize endpoint must accept anonymous GET/POST — the whole
  // point of authorize is to start an unauthenticated user's flow. PKCE
  // and state-parameter validation in the handler enforce real auth.
  allowRead() { return true; }
  allowCreate() { return true; }

  async get() {
    // In 1.0, this returns a simple HTML consent page.
    // The user (Nathan) approves or denies, which POSTs back.
    // Harper v5 does not populate this.request on Resource subclasses —
    // getContext() is the only reliable path (the previous
    // `(this as any).request` read was always undefined, so query params were
    // always empty).
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const url = new URL(request?.url ?? "http://localhost", "http://localhost");
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const responseType = url.searchParams.get("response_type") ?? "";
    const requestedScope = consentScope(url.searchParams.get("scope") ?? undefined);
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

    // `state` is an opaque passthrough: printable ASCII, bounded. Anything else
    // is refused (400) BEFORE rendering, so it can never reach the page.
    if (!isOpaqueState(state)) {
      return new Response(JSON.stringify({
        error: "invalid_request",
        error_description: `state must be printable ASCII of at most ${STATE_MAX_LENGTH} characters`,
      }), { status: 400, headers: { "content-type": "application/json" } });
    }

    // Scope, then client, then PKCE — the same three checks, in the same order,
    // that the consent form's POST runs before it issues a code. The form is
    // rendered only for a request that passes all three.
    const scopeCheck = checkConsentScope(requestedScope);
    if (!scopeCheck.ok) return scopeCheck.response;
    const { scope, scopeTokens } = scopeCheck;

    const clientCheck = await checkConsentClient(clientId);
    if (!clientCheck.ok) return clientCheck.response;
    const { client } = clientCheck;

    const pkceCheck = checkConsentPkce(codeChallenge, codeChallengeMethod);
    if (!pkceCheck.ok) return pkceCheck.response;

    // Server-rendered consent page (minimal HTML, no JS frameworks). EVERY
    // interpolated value passes through `esc` — correct for element text and
    // for the double-quoted attribute values below.
    const html = `<!DOCTYPE html>
<html><head><title>Flair — Authorize</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:0 20px}
h1{font-size:1.4em}button{padding:10px 24px;font-size:1em;border:none;border-radius:6px;cursor:pointer;margin-right:8px}
.approve{background:#2563eb;color:#fff}.deny{background:#e5e7eb;color:#333}
.scope{background:#f3f4f6;padding:8px 12px;border-radius:4px;margin:4px 0;font-family:monospace}</style></head>
<body>
<h1>Authorize ${esc(client.name || clientId)}</h1>
<p>This application wants to access your Flair memories:</p>
${scopeTokens.map((s: string) => `<div class="scope">${esc(s)}</div>`).join("")}
<form method="POST" action="/OAuthAuthorize" style="margin-top:24px">
<input type="hidden" name="client_id" value="${esc(clientId)}">
<input type="hidden" name="redirect_uri" value="${esc(redirectUri || ALLOWED_REDIRECT_URI)}">
<input type="hidden" name="scope" value="${esc(scope)}">
<input type="hidden" name="state" value="${esc(state)}">
<input type="hidden" name="code_challenge" value="${esc(pkceCheck.codeChallenge)}">
<input type="hidden" name="code_challenge_method" value="S256">
<button type="submit" name="action" value="approve" class="approve">Approve</button>
<button type="submit" name="action" value="deny" class="deny">Deny</button>
</form></body></html>`;

    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // No script is needed by this page; an inline <style> is the only
        // non-default allowance. The form posts back here and the POST answers
        // with a 302 to the pinned callback, so that origin must be allowed too.
        // Nothing may frame the consent page.
        "content-security-policy": `default-src 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; form-action 'self' ${ALLOWED_REDIRECT_ORIGIN}`,
        "x-content-type-options": "nosniff",
      },
    });
  }

  async post(data: any) {
    const action = data?.action;
    // As received: checkConsentClient refuses a non-string without a lookup.
    const clientId = data?.client_id;
    const redirectUri = data?.redirect_uri || ALLOWED_REDIRECT_URI;
    const requestedScope = consentScope(data?.scope);
    const state = data?.state ?? "";
    // As received: checkConsentPkce refuses an absent, empty, non-string or
    // non-S256 value.
    const codeChallenge = data?.code_challenge;
    const codeChallengeMethod = data?.code_challenge_method;

    // Sherlock 2026-04-11: validate redirect_uri in POST handler too.
    // Without this, an attacker can CSRF the approval form with an arbitrary
    // redirect_uri, stealing the authorization code via open redirect.
    if (redirectUri !== ALLOWED_REDIRECT_URI) {
      return new Response(JSON.stringify({ error: "invalid_redirect_uri" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // flair#610 — mint an authorization code ONLY on an explicit approve. The
    // consent form rendered by get() submits action=approve|deny and nothing
    // else, so treating every non-"approve" value (deny, missing, empty, or
    // garbage) as a denial is safe — and it closes the previous loose
    // `action !== "deny"` check, which minted a code for a malformed or absent
    // action. redirect_uri was already validated above, so this access_denied
    // redirect can only target the allowed URI.
    if (action !== "approve") {
      const params = new URLSearchParams({ error: "access_denied", state });
      return redirectTo(`${redirectUri}?${params}`);
    }

    // An approve must name what the consent page accepts: the scope check, then
    // the OAuthClient record check, then the S256 PKCE check — the same checks,
    // in the same order and with the same 400 bodies, that get() runs before
    // rendering the form. All three run before authentication (get() runs them
    // with none) and before any code is issued or stored. A deny is answered
    // above, before these: it issues nothing, stores nothing, and redirects
    // only to the pinned redirect_uri, so it needs no PKCE fields.
    const scopeCheck = checkConsentScope(requestedScope);
    if (!scopeCheck.ok) return scopeCheck.response;
    const { scope } = scopeCheck;

    const clientCheck = await checkConsentClient(clientId);
    if (!clientCheck.ok) return clientCheck.response;

    const pkceCheck = checkConsentPkce(codeChallenge, codeChallengeMethod);
    if (!pkceCheck.ok) return pkceCheck.response;

    // Determine authenticated principal. Harper v5 does not populate
    // this.request on Resource subclasses, so `(this as any).request?.tpsAgent`
    // was always undefined and this ALWAYS fell back to the hardcoded "admin" —
    // every approved consent grant was minted for the admin principal
    // regardless of who actually approved it (identity spoof).
    // resolveAgentAuth(getContext()) resolves Basic super_user/admin auth to
    // { kind: "agent", agentId: username, isAdmin: true } (see agent-auth.ts).
    // We do NOT silently fall back to "admin" on an unresolved principal — if
    // no principal can be resolved, that's an error state, not an admin grant.
    //
    // SECURITY REVIEW (Sherlock): is resolving the approving principal via
    // resolveAgentAuth the correct policy for "who may approve OAuth consent"
    // in 1.0 — i.e. must the approver be Basic-authenticated as super_user/
    // admin, or should any verified (non-admin) agent be able to approve its
    // own consent grant? The previous code always resolved to "admin" for
    // every caller, so this is a genuine policy decision, not just a bug fix.
    //
    // SECURITY FIX (#604 — authorizeLocal escalation): resolveAgentAuth's
    // `context.user` fallback (agent-auth.ts, the super_user / username
    // branches) ALSO matches Harper's `authorizeLocal` (config true) ambient
    // super_user injection for ANY credential-less LOOPBACK request.
    // /OAuthAuthorize sits on auth-middleware.ts's public early-return
    // passthrough (any method), so a bare local POST never gets OUR
    // middleware's tpsAgent/tpsAnonymous annotation either — resolveAgentAuth
    // falls straight through to Harper's raw `context.user`, which
    // authorizeLocal can forge with NO signature and NO password. A
    // credential-less loopback POST therefore resolved to
    // { kind: "agent", agentId: "admin", isAdmin: true } and minted a REAL
    // admin authorization code, exchangeable at OAuthToken for a Bearer
    // token — full local privilege escalation with zero credentials.
    // authorizeLocal injects request.user=super_user ONLY when there is NO
    // Authorization header present (see Presence.ts's get() doc for the
    // fuller writeup of this exact mechanism) — a genuinely
    // password-verified Basic admin/super_user, or a genuinely
    // Ed25519-signed agent request, both carry a real header. Requiring one
    // be present before trusting resolveAgentAuth's verdict closes the
    // forged-approver path without touching resolveAgentAuth itself (the
    // root-cause fix is a separate, larger follow-up — see #604): a
    // credential-less local caller now gets 401 and no code is minted; a
    // genuinely-authenticated approver (real Basic password, or a real
    // TPS-Ed25519 signature verified by resolveAgentAuth's own fallback) is
    // unaffected.
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authHeader: string =
      request?.headers?.get?.("authorization") ??
      request?.headers?.asObject?.authorization ??
      "";
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind !== "agent") {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const principalId: string = auth.agentId;

    // Generate authorization code
    const code = randomBytes(32).toString("base64url");
    const now = nowISO();

    await (databases as any).flair.OAuthAuthCode.put({
      id: code,
      clientId,
      principalId,
      redirectUri,
      scope,
      codeChallenge: pkceCheck.codeChallenge,
      codeChallengeMethod: "S256",
      expiresAt: futureISO(AUTH_CODE_TTL_MS),
      used: false,
      createdAt: now,
    });

    const params = new URLSearchParams({ code, state });
    return redirectTo(`${redirectUri}?${params}`);
  }
}

// ─── Token endpoint ──────────────────────────────────────────────────────────

export class OAuthToken extends Resource {
  // OAuth token exchange — client must hit this without prior Harper auth
  // since they're trading code/refresh for a token. Authentication is in
  // the post() handler via PKCE verifier + client_secret_basic.
  allowCreate() { return true; }

  async post(data: any) {
    const grantType = data?.grant_type;

    if (grantType === "authorization_code") {
      return this.handleAuthorizationCode(data);
    } else if (grantType === "refresh_token") {
      return this.handleRefreshToken(data);
    } else if (grantType === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      return handleJwtBearerGrant(data, (this as any).getContext?.());
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

    // PKCE (S256) on every exchange: the stored code must carry an S256
    // challenge, the request must carry a code_verifier, and the verifier's
    // S256 hash must equal the stored challenge. Each refusal comes before the
    // single-use claim and the `used` write below, so a refused exchange
    // leaves the code unredeemed and the answer names the PKCE refusal.
    if (typeof authCode.codeChallenge !== "string" || !authCode.codeChallenge || authCode.codeChallengeMethod !== "S256") {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "authorization code has no S256 code_challenge" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    if (typeof codeVerifier !== "string" || !codeVerifier) {
      return new Response(JSON.stringify({ error: "invalid_request", error_description: "code_verifier required" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    const expectedChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    if (expectedChallenge !== authCode.codeChallenge) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Claim to redeem once per instance under a per-key lock before any token
    // is issued (resources/replay-store.ts).
    const claim = await claimOAuthSingleUse("code", sha256(code), AUTH_CODE_TTL_MS);
    if (claim === "unavailable") return storeUnavailable();
    if (claim === "replay") {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "code already used" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
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

    // Test-only: valid names are inert unless fault injection is enabled and
    // armed (resources/txn-pause-point.ts). Holds this rotation between the
    // read above and the claim below — the interleaving where a revoke of the
    // same token commits first. Such a revoke records the token's single-use
    // claim (`r:<hash>`), so the rotation's own claim below is a replay and
    // refuses it there, before the committed-row re-read is reached.
    const pause = txnPausePoint("oauth-refresh-pre-claim");
    if (pause) await pause;

    // Within one Harper process, claim, re-read, write and issuance hold the
    // same token lock OAuthRevoke takes. A revoke's recorded claim refuses a
    // later rotation; the re-read also covers a committed row change that did
    // not record that claim. A rotation that cannot take the lock is refused.
    const outcome = await withTokenLifecycleLock(tokenHash, async () => {
      // Claim to rotate once per instance under a per-key lock before the new
      // pair is issued (resources/replay-store.ts). A revoke of this refresh
      // token records the same claim (OAuthRevoke below), so a revoke that
      // committed before this claim makes it a replay.
      const claim = await claimOAuthSingleUse("refresh", tokenHash, REFRESH_TOKEN_TTL_MS);
      if (claim === "unavailable") return storeUnavailable();
      if (claim === "replay") {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "token revoked" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }

      // Test-only: holds this rotation between its single-use claim above and
      // its committed-row re-read below, while it holds the token lock. A
      // competing write of `revokedAt` that does NOT take this lock and does
      // NOT record the claim (so the claim above could not refuse it) can
      // commit here; the re-read below is then the only check that refuses the
      // rotation.
      const midClaimPause = txnPausePoint("oauth-refresh-mid-claim");
      if (midClaimPause) await midClaimPause;

      // The committed-row re-read, the old row's write and the new pair's
      // issuance run in a FRESH OWNED transaction (withOwnedTransaction,
      // resources/request-transaction.ts) that COMMITS before this token's lock
      // releases. Harper wraps this POST in a REQUEST transaction that commits
      // only after the handler returns, so writes that joined it would still be
      // invisible when the lock frees — a request that looked at the row right
      // after release would read it unrevoked. The re-read reads the row IN that
      // owned transaction: committed state, never this request's earlier
      // snapshot. (The single-use claim above is its own awaited transaction.)
      const ctx = (this as any).getContext?.() ?? {};
      return await withOwnedTransaction(ctx, async (owned) => {
        // Re-read the COMMITTED row and refuse unless it is still this token,
        // unrevoked, including row changes that did not record the claim.
        const committed = await (databases as any).flair.OAuthToken.get(refreshRecord.id, owned);
        if (!committed || committed.tokenHash !== tokenHash || committed.revokedAt) {
          return new Response(JSON.stringify({ error: "invalid_grant", error_description: "token revoked" }), {
            status: 400, headers: { "content-type": "application/json" },
          });
        }

        // Test-only: holds this rotation between the re-read above and the write
        // and issuance below, while it holds the token lock — the interleaving
        // where a revoke of this token would commit between them.
        const postClaimPause = txnPausePoint("oauth-refresh-post-claim");
        if (postClaimPause) await postClaimPause;

        // Rotate: revoke old refresh token, issue new pair — both in `owned`, so
        // they commit before the lock releases.
        await (databases as any).flair.OAuthToken.put({
          ...committed,
          revokedAt: nowISO(),
        }, owned);

        return this.issueTokenPair(committed.clientId, committed.principalId, committed.scope, owned);
      });
    });

    // Test-only: inert unless the fault-injection env opt-in is set and armed.
    // Pauses AFTER the token lock released (and, with the owned transaction
    // above, after the rotation's writes committed) but BEFORE this request's own
    // transaction commits (Harper commits it when the handler returns). A request
    // that looks at the token right here must see the committed revocation.
    const claimDone = txnPausePoint("oauth-refresh-claim-done");
    if (claimDone) await claimDone;
    return outcome.ok ? outcome.value : outcome.response;
  }

  private async issueTokenPair(clientId: string, principalId: string, scope: string, ctx?: any) {
    const put = (row: any) =>
      ctx ? (databases as any).flair.OAuthToken.put(row, ctx) : (databases as any).flair.OAuthToken.put(row);
    const now = nowISO();
    const accessTokenRaw = randomToken("flair_at_");
    const refreshTokenRaw = randomToken("flair_rt_");

    const accessId = `at_${randomBytes(8).toString("hex")}`;
    const refreshId = `rt_${randomBytes(8).toString("hex")}`;

    await put({
      id: accessId,
      tokenHash: sha256(accessTokenRaw),
      tokenType: "access",
      clientId,
      principalId,
      scope,
      expiresAt: futureISO(ACCESS_TOKEN_TTL_MS),
      createdAt: now,
    });

    await put({
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
  // RFC 7009 — token revocation accepts the token itself as proof; clients
  // may not have a separate auth credential. Handler validates the token.
  allowCreate() { return true; }

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
      // Within one Harper process, a refresh rotation takes this token's lock
      // across its claim, committed-row re-read, write and issuance, recording the
      // single-use claim `r:<hash>` (OAuthToken above). The revoke takes the
      // same lock before it records `revokedAt`, so it is serialized with an
      // in-flight rotation and cannot commit between that rotation's re-read
      // and its issuance. A claim that is already recorded — the token was
      // already rotated, or this is a repeat revoke — is not an error: the
      // revoke still records `revokedAt` below. An access token has no rotation
      // to serialize with.
      if (t.tokenType === "refresh") {
        const outcome = await withTokenLifecycleLock<Response | undefined>(tokenHash, async () => {
          // If this refresh-token revoke cannot record its claim, return 503
          // without writing `revokedAt`.
          const claim = await claimOAuthSingleUse("refresh", tokenHash, REFRESH_TOKEN_TTL_MS);
          if (claim === "unavailable") return storeUnavailable();
          await (databases as any).flair.OAuthToken.put({
            ...t,
            revokedAt: nowISO(),
          });
          return undefined;
        });
        if (!outcome.ok) return outcome.response;
        if (outcome.value) return outcome.value;
        continue;
      }
      await (databases as any).flair.OAuthToken.put({
        ...t,
        revokedAt: nowISO(),
      });
    }

    // RFC 7009: always return 200 regardless of whether token was found
    return {};
  }
}
