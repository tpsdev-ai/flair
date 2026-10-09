import { databases } from "harper";
import { allowAdmin } from "./agent-auth.js";
import { harperPortValue } from "../src/lib/harper-port-value.js";
import { DEFAULT_HTTP_PORT } from "./a2a-url.js";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { stampOriginatorOnCreate } from "./originator-instance.js";
import { invalidAgentIdMessage, isValidAgentId } from "../src/lib/agent-id-rule.js";
import { claimIdJagJti, idJagReplayDeps, ReplayStoreUnavailable, reportReplayStoreGapsAtBoot, type ReplayStoreBootStore } from "./replay-store.js";

/**
 * XAA (Enterprise-Managed Authorization) — ID-JAG validation for Flair.
 *
 * Validates ID-JAG tokens from enterprise IdPs (Google Workspace, Azure AD,
 * Okta) and issues Flair access tokens. Implements the jwt-bearer grant type
 * (RFC 7523) at the OAuth token endpoint.
 *
 * Flow:
 *   1. Client authenticates user via corporate SSO
 *   2. IdP issues ID-JAG (signed JWT with policy decision)
 *   3. Client presents ID-JAG to Flair's /OAuthToken endpoint
 *   4. Flair validates signature, issuer, audience, domain, expiry, replay
 *   5. Flair resolves or JIT-creates a Principal
 *   6. Flair issues scoped access + refresh tokens
 *
 * Per FLAIR-XAA spec §§ 3-4.
 */

const ACCESS_TOKEN_TTL_MS = 3600_000;        // 1 hour
const REFRESH_TOKEN_TTL_MS = 7 * 86400_000;  // 7 days
export const CLOCK_SKEW_MS = 30_000;         // 30 seconds

/**
 * An assertion that carries a `jti` is refused unless its `exp` is at most this
 * far ahead of now, plus CLOCK_SKEW_MS (flair#2073).
 */
export const ID_JAG_MAX_VALIDITY_MS = 24 * 3600_000;

/**
 * The longest an accepted assertion stays acceptable after its jti is recorded.
 * jose compares exp with the current whole second, so it accepts an assertion
 * only before exp + CLOCK_SKEW_MS + 1 s, and exp is at most
 * ID_JAG_MAX_VALIDITY_MS + CLOCK_SKEW_MS ahead when it is recorded.
 */
export const ID_JAG_LONGEST_ACCEPTANCE_MS = ID_JAG_MAX_VALIDITY_MS + 2 * CLOCK_SKEW_MS + 1000;

/**
 * Seconds a newly recorded jti row is kept: 25 h, longer than ID_JAG_LONGEST_ACCEPTANCE_MS.
 * MUST equal `expiration:` on `type IdJagReplay` in schemas/oauth.graphql
 * (both pinned by test/unit-isolated/xaa-jti-replay.test.ts).
 */
export const ID_JAG_REPLAY_RETENTION_S = 90_000;

// Once per worker thread at boot, with the replay guards' own report: a
// misconfigured IdJagReplay table is named before the first jwt-bearer grant,
// not on the first claim.
export const XAA_JTI_REPLAY_BOOT_STORE: ReplayStoreBootStore = {
  label: "XAA jti",
  deps: idJagReplayDeps,
  minRetentionMs: ID_JAG_LONGEST_ACCEPTANCE_MS,
  retentionBasis: "an assertion can stay acceptable",
};
reportReplayStoreGapsAtBoot(XAA_JTI_REPLAY_BOOT_STORE);

// JWKS remote key set cache per issuer (jose handles caching internally)
const jwksSetCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

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
 * Get or create a remote JWKS key set for an IdP.
 * jose handles caching, key rotation, and refetching internally.
 */
function getJwksKeySet(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let keySet = jwksSetCache.get(jwksUri);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(jwksUri));
    jwksSetCache.set(jwksUri, keySet);
  }
  return keySet;
}

/**
 * Validate an ID-JAG token against a configured IdP.
 * Returns the validated payload or throws with a specific error.
 */
export async function validateIdJag(
  assertion: string,
  expectedAudience: string,
): Promise<{ payload: JWTPayload & Record<string, any>; idpConfig: any }> {
  // Pre-decode to find the issuer (needed to look up the IdP config + JWKS URI)
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new Error("invalid JWT format");
  let prePayload: any;
  try {
    prePayload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    throw new Error("invalid JWT payload encoding");
  }

  const issuer = prePayload.iss;
  if (!issuer) throw new Error("missing iss claim");

  // 2. Issuer lookup
  let idpConfig: any = null;
  for await (const cfg of (databases as any).flair.IdpConfig.search({
    conditions: [
      { attribute: "issuer", comparator: "equals", value: issuer },
      { attribute: "enabled", comparator: "equals", value: true },
    ],
  })) {
    idpConfig = cfg;
    break;
  }
  if (!idpConfig) throw new Error(`unknown issuer: ${issuer}`);

  // 1. Cryptographic signature verification via jose + IdP JWKS.
  // This is the core security check — without it, all claims are forgeable.
  // Sherlock's 2026-04-11 review finding: deferring signature verification
  // defeats the entire purpose of JWTs.
  const jwks = getJwksKeySet(idpConfig.jwksUri);
  const { payload } = await jwtVerify(assertion, jwks, {
    issuer,
    audience: expectedAudience,
    clockTolerance: CLOCK_SKEW_MS / 1000,
  });

  // 8. Domain restriction (post-verification — claims are now trusted)
  if (idpConfig.requiredDomain) {
    const hd = (payload as any).hd;
    const tid = (payload as any).tid;
    if (hd && hd !== idpConfig.requiredDomain) {
      throw new Error(`domain mismatch: expected ${idpConfig.requiredDomain}, got ${hd}`);
    }
    if (tid && tid !== idpConfig.requiredDomain) {
      throw new Error(`tenant mismatch: expected ${idpConfig.requiredDomain}, got ${tid}`);
    }
    if (!hd && !tid) {
      throw new Error(`domain required but no hd/tid claim present — consumer account rejected`);
    }
  }

  // Replay prevention (jti): a jti claim, when present, must be a nonempty
  // string, and is then recorded once per instance, under a per-key lock,
  // before the grant has any effect. The record is kept
  // ID_JAG_REPLAY_RETENTION_S, so the assertion's validity is bounded first.
  if (payload.jti !== undefined) {
    if (typeof payload.jti !== "string" || payload.jti === "") throw new Error("jti claim must be a nonempty string");
    if (typeof payload.exp !== "number" || payload.exp * 1000 > Date.now() + ID_JAG_MAX_VALIDITY_MS + CLOCK_SKEW_MS) {
      throw new Error(`an assertion with a jti must carry an exp at most ${ID_JAG_MAX_VALIDITY_MS / 3600_000} hours ahead`);
    }
    const claim = await claimIdJagJti(payload.jti, ID_JAG_LONGEST_ACCEPTANCE_MS);
    if (claim === "replay") throw new Error("token replay detected");
    if (claim !== "recorded") throw new ReplayStoreUnavailable(`flair.IdJagReplay claim: ${claim}`);
  }

  return { payload: payload as JWTPayload & Record<string, any>, idpConfig };
}

/**
 * Resolve or JIT-create a Principal from validated ID-JAG claims.
 */
async function resolveOrCreatePrincipal(
  payload: any,
  idpConfig: any,
): Promise<string> {
  const idpSubject = payload.sub;
  const email = payload.email ?? payload.preferred_username;
  const displayName = payload.name ?? email ?? idpSubject;

  // Look for existing credential with this IdP subject
  for await (const cred of (databases as any).flair.Credential.search({
    conditions: [
      { attribute: "kind", comparator: "equals", value: "idp" },
      { attribute: "idpSubject", comparator: "equals", value: idpSubject },
      { attribute: "idpProvider", comparator: "equals", value: idpConfig.id },
    ],
  })) {
    // Update last used
    await (databases as any).flair.Credential.put({
      ...cred,
      lastUsedAt: nowISO(),
    });
    return cred.principalId;
  }

  // No existing credential — JIT provision if enabled
  if (!idpConfig.jitProvision) {
    throw new Error(`no principal for IdP subject ${idpSubject} and JIT provisioning is disabled`);
  }

  const principalId = `usr_${idpSubject.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 20)}_${randomBytes(4).toString("hex")}`;
  // flair#2359 — the shared agent-ID rule. The id above is built to conform,
  // but the rule is enforced on the value that is actually written, so a future
  // change to this construction cannot store an id AgentSeed would refuse.
  if (!isValidAgentId(principalId)) throw new Error(invalidAgentIdMessage(principalId));
  const now = nowISO();

  // Create principal (via Agent table). flair#1965 r2: a raw Agent create —
  // stamp the local instance id (the Agent resource's post() does not run here).
  const principalRow: any = {
    id: principalId,
    name: displayName,
    displayName,
    kind: "human",
    type: "human",
    status: "active",
    publicKey: `idp:${idpConfig.id}:${idpSubject}`, // placeholder — humans don't have real Ed25519 keys
    defaultTrustTier: idpConfig.defaultTrustTier ?? "unverified",
    admin: false,
    createdAt: now,
    updatedAt: now,
  };
  await stampOriginatorOnCreate(principalRow);
  await (databases as any).flair.Agent.put(principalRow);

  // Create IdP credential
  await (databases as any).flair.Credential.put({
    id: `cred_idp_${randomBytes(8).toString("hex")}`,
    principalId,
    kind: "idp",
    label: idpConfig.name,
    status: "active",
    idpProvider: idpConfig.id,
    idpSubject,
    idpEmail: email,
    createdAt: now,
    lastUsedAt: now,
  });

  return principalId;
}

/**
 * Base URL an ID-JAG is validated against: `FLAIR_PUBLIC_URL` when set,
 * otherwise the loopback bind address. `HTTP_PORT` is parsed through
 * `harperPortValue` so a host-qualified value (`127.0.0.1:19926`) yields a
 * valid URL rather than a doubled host; the default is `DEFAULT_HTTP_PORT`
 * (19926).
 *
 * Exported for direct unit testing — the grant handler itself needs a live
 * Harper database (IdpConfig, Credential, Agent tables).
 */
export function jwtBearerBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLAIR_PUBLIC_URL || `http://127.0.0.1:${harperPortValue(env.HTTP_PORT) ?? DEFAULT_HTTP_PORT}`;
}

/**
 * Handle the jwt-bearer grant type at the token endpoint.
 * Called from OAuthToken when grant_type is urn:ietf:params:oauth:grant-type:jwt-bearer.
 */
export async function handleJwtBearerGrant(data: any): Promise<Response | object> {
  const assertion = data?.assertion;
  if (!assertion) {
    return new Response(JSON.stringify({
      error: "invalid_request",
      error_description: "assertion parameter required for jwt-bearer grant",
    }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const baseUrl = jwtBearerBaseUrl();

  try {
    const { payload, idpConfig } = await validateIdJag(assertion, baseUrl);

    // Resolve or create principal
    const principalId = await resolveOrCreatePrincipal(payload, idpConfig);

    // Determine scopes — intersection of ID-JAG scopes and IdP allowed scopes
    const requestedScopes = (payload.scope ?? "memory:read").split(" ");
    const allowedScopes = idpConfig.allowedScopes?.length
      ? new Set(idpConfig.allowedScopes)
      : null;
    const grantedScopes = allowedScopes
      ? requestedScopes.filter((s: string) => allowedScopes.has(s))
      : requestedScopes;
    const scope = grantedScopes.join(" ");

    // Issue tokens
    const now = nowISO();
    const clientId = data?.client_id ?? idpConfig.clientId;
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
      idpIssuer: payload.iss,
      idpSubject: payload.sub,
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
      idpIssuer: payload.iss,
      idpSubject: payload.sub,
      createdAt: now,
    });

    return {
      access_token: accessTokenRaw,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshTokenRaw,
      scope,
    };
  } catch (err: any) {
    if (err instanceof ReplayStoreUnavailable) {
      return new Response(JSON.stringify({
        error: "temporarily_unavailable",
        error_description: "replay_store_unavailable",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: err.message,
    }), { status: 400, headers: { "content-type": "application/json" } });
  }
}

/**
 * IdP management resource — CRUD for IdP configurations.
 * Admin-only access.
 */
export class IdpConfig extends (databases as any).flair.IdpConfig {
  // Admin-only on every path (the "Admin-only" comment was previously unenforced —
  // a pure put() override with no auth check, so the non-rejecting gate let
  // anonymous through to Harper's handler). allowAdmin permits admin + internal.
  allowRead()   { return allowAdmin((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowAdmin((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }

  async put(content: any) {
    const now = nowISO();
    content.enabled ??= true;
    content.jitProvision ??= true;
    content.defaultTrustTier ??= "unverified";
    content.createdAt ??= now;
    content.updatedAt = now;
    return super.put(content);
  }
}
