import { databases } from "harper";
import { allowAdmin } from "./agent-auth.js";
import { harperPortValue } from "../src/lib/harper-port-value.js";
import { DEFAULT_HTTP_PORT } from "./a2a-url.js";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { stampOriginatorOnCreate } from "./originator-instance.js";
import { invalidAgentIdMessage, isValidAgentId } from "../src/lib/agent-id-rule.js";
import { credentialMapsPrincipal, credentialPrincipalId, isUsableCredential } from "../src/lib/credential-status-rule.js";
import { withKeyLock } from "./key-lock.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { CommittedRowChanged, confirmCommittedRow, sameStoredRow, verifyCommittedFields } from "./write-back.js";
import { txnPausePoint } from "./txn-pause-point.js";
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

  // A present jti must be a nonempty string with exp no further ahead than
  // ID_JAG_MAX_VALIDITY_MS plus CLOCK_SKEW_MS. resolveOrCreatePrincipal claims
  // it under the subject lock before provisioning and token issuance.
  if (payload.jti !== undefined) {
    if (typeof payload.jti !== "string" || payload.jti === "") throw new Error("jti claim must be a nonempty string");
    if (typeof payload.exp !== "number" || payload.exp * 1000 > Date.now() + ID_JAG_MAX_VALIDITY_MS + CLOCK_SKEW_MS) {
      throw new Error(`an assertion with a jti must carry an exp at most ${ID_JAG_MAX_VALIDITY_MS / 3600_000} hours ahead`);
    }
  }

  return { payload: payload as JWTPayload & Record<string, any>, idpConfig };
}

/**
 * Resolve or JIT-create a Principal from validated ID-JAG claims.
 *
 * Within one Harper process, the subject's per-key lock serializes the
 * credential lookup and any JIT create. A lock miss refuses the grant (503).
 */
async function resolveOrCreatePrincipal(
  payload: any,
  idpConfig: any,
  ctx?: any,
): Promise<string> {
  const store = (databases as any)?.flair?.Credential?.primaryStore;
  const outcome = await withKeyLock(
    store,
    [XAA_PRINCIPAL_LOCK_NAMESPACE, idpConfig.id, String(payload.sub)],
    () => resolveOrCreatePrincipalLocked(payload, idpConfig, ctx),
    XAA_PRINCIPAL_LOCK_ATTEMPTS,
    XAA_PRINCIPAL_LOCK_WAIT_MS,
  );
  if (outcome.kind === "done") return outcome.value;
  throw new PrincipalProvisionBusy();
}

/** The subject's principal-provision lock namespace and wait (resources/key-lock.ts). */
export const XAA_PRINCIPAL_LOCK_NAMESPACE = "flair-xaa-principal";
const XAA_PRINCIPAL_LOCK_ATTEMPTS = 200;
const XAA_PRINCIPAL_LOCK_WAIT_MS = 10;

/** The named refusal of a grant that lost the principal-provision lock: refused, not retried into a second principal. */
export class PrincipalProvisionBusy extends Error {
  constructor() {
    super("principal provisioning for this subject is in progress; retry");
    this.name = "PrincipalProvisionBusy";
  }
}

/**
 * `resolveOrCreatePrincipal`'s check-and-write, run while holding the subject's
 * lock: the credential lookup, and the JIT principal + credential create it
 * falls back to. Never called outside the lock.
 */
async function resolveOrCreatePrincipalLocked(
  payload: any,
  idpConfig: any,
  ctx?: any,
): Promise<string> {
  // Claim jti after taking the subject lock, before provisioning and token
  // issuance (flair#2333). A lock miss leaves it unclaimed; a retry can succeed
  // if the assertion remains valid and the later grant steps succeed.
  if (payload.jti !== undefined) {
    const claim = await claimIdJagJti(payload.jti, ID_JAG_LONGEST_ACCEPTANCE_MS);
    if (claim === "replay") throw new Error("token replay detected");
    if (claim !== "recorded") throw new ReplayStoreUnavailable(`flair.IdJagReplay claim: ${claim}`);
  }

  const idpSubject = payload.sub;
  const email = payload.email ?? payload.preferred_username;
  const displayName = payload.name ?? email ?? idpSubject;

  // Within one Harper process, the credential lookup and any JIT create run
  // in an owned transaction that commits before the subject lock releases.
  let touchedCredential: { id: string; identity: any; fields: Record<string, unknown> } | undefined;
  const principalId = await withOwnedTransaction(ctx, async (owned) => {
    // Look for existing credential with this IdP subject
    for await (const cred of (databases as any).flair.Credential.search({
      conditions: [
        { attribute: "kind", comparator: "equals", value: "idp" },
        { attribute: "idpSubject", comparator: "equals", value: idpSubject },
        { attribute: "idpProvider", comparator: "equals", value: idpConfig.id },
      ],
    }, owned)) {
      // A matched credential completes a grant only when its status is
      // "active" AND it names a principal (a non-empty string principalId): the
      // rule the MCP resolver and the principal linker apply
      // (src/lib/credential-status-rule.ts, `credentialMapsPrincipal`).
      // `status` is a nullable String on schemas/agent.graphql whose documented
      // values are "active" and "revoked" (a comment, not an enforced enum); the
      // revoke path writes "revoked". Refuse it by name, naming the stored
      // status, or that the credential names no principal: no credential touch
      // and no OAuth token is written, so its lastUsedAt is left untouched. A
      // present `jti` is claimed — and consumed — before this check, in its own
      // transaction (the claim above, before the owned transaction).
      if (!credentialMapsPrincipal(cred)) {
        const state = isUsableCredential(cred) ? "names no principal" : `has status "${cred.status}"`;
        throw new Error(`IdP credential for this subject ${state}; the jwt-bearer grant is refused`);
      }
      // Test-only: valid names are inert unless fault injection is enabled and
      // armed (resources/txn-pause-point.ts). Holds this touch between the read
      // above and the write below — the interleaving a revoke or delete of this
      // credential would commit in.
      const pause = txnPausePoint("xaa-credential-touch");
      if (pause) await pause;
      // Update last used. This touch is IDEMPOTENT: re-applying the same
      // lastUsedAt to the same matched credential yields the same committed
      // row, so a post-commit mismatch may retry (this path refuses the grant).
      const touchedRow = {
        ...cred,
        lastUsedAt: nowISO(),
      };
      await (databases as any).flair.Credential.put(touchedRow, owned);
      // A revoke or a delete committed while this touch was in flight (the
      // read above through the write above) refuses the grant rather than
      // being overwritten by the touch: re-read the COMMITTED row and abort
      // the touch unless it is still this matched, active credential
      // (resources/write-back.ts, confirmCommittedRow — the same confirmation
      // the write-back helper runs once its write is staged). Post-commit
      // verification refuses surviving differences in compared fields or identity.
      try {
        await confirmCommittedRow(
          (databases as any).flair.Credential,
          cred.id,
          (committed) => committed != null && credentialMapsPrincipal(committed) &&
            sameStoredRow(committed, cred) &&
            committed.principalId === cred.principalId &&
            committed.kind === cred.kind &&
            committed.idpSubject === cred.idpSubject &&
            committed.idpProvider === cred.idpProvider,
        );
      } catch (err) {
        // Aborting this transaction discards the staged touch. Refuse the grant
        // by name: the credential is gone, revoked, or no longer the one read.
        if (err instanceof CommittedRowChanged) {
          throw new Error("the matched IdP credential changed while the grant was in progress; the jwt-bearer grant is refused");
        }
        throw err;
      }
      // Test-only: inert unless fault injection is enabled and armed. Holds the
      // touch after its final pre-commit confirmation and before its owned
      // transaction commits (flair#2656).
      const commitPause = txnPausePoint("xaa-credential-touch-commit");
      if (commitPause) await commitPause;
      // Harper assigns these timestamps; they are not staged application fields.
      const touchedFields = { ...touchedRow };
      delete touchedFields.__createdtime__;
      delete touchedFields.__updatedtime__;
      touchedCredential = { id: String(cred.id), identity: touchedRow, fields: touchedFields };
      return credentialPrincipalId(cred)!;
    }

    // No existing credential — JIT provision if enabled
    if (!idpConfig.jitProvision) {
      throw new Error(`no principal for IdP subject ${idpSubject} and JIT provisioning is disabled`);
    }

    // Test-only: pause after the lookup finds no credential, before JIT create.
    const pause = txnPausePoint("xaa-principal-provision");
    if (pause) await pause;

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
    await (databases as any).flair.Agent.put(principalRow, owned);

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
    }, owned);

    return principalId;
  });
  // flair#2656: the commit is not proof the touch landed. Answer the grant only
  // when a fresh committed read shows the staged values on the same row
  // identity; otherwise the grant is refused.
  if (touchedCredential) {
    const verdict = await verifyCommittedFields(
      (databases as any).flair.Credential,
      touchedCredential.id,
      touchedCredential.identity,
      touchedCredential.fields,
    );
    if (verdict === "unreadable") {
      throw new Error("the matched IdP credential could not be read back after the touch (outcome: unconfirmed); the jwt-bearer grant is refused");
    }
    if (verdict !== "shown") {
      throw new Error("the matched IdP credential's committed state does not show this grant's staged values (outcome: unconfirmed); the jwt-bearer grant is refused");
    }
  }
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
export async function handleJwtBearerGrant(data: any, ctx?: any): Promise<Response | object> {
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
    const principalId = await resolveOrCreatePrincipal(payload, idpConfig, ctx);

    // Test-only: pause after the subject lock releases and the owned transaction
    // commits, before this request's transaction commits (flair#2333).
    const released = txnPausePoint("xaa-principal-lock-released");
    if (released) await released;

    // Token writes follow the subject lock's release and can fail independently.
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
    if (err instanceof PrincipalProvisionBusy) {
      return new Response(JSON.stringify({
        error: "temporarily_unavailable",
        error_description: "principal_provision_in_progress",
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
