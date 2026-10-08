import { patchRecord } from "./table-helpers.js";
import { server, databases } from "harper";
import { getEmbedding } from "./embeddings-provider.js";
import { isAdmin, isPrincipalDeactivated, FLAIR_AGENT_USERNAME } from "./agent-auth.js";
import { WINDOW_MS, importEd25519Key, b64ToArrayBuffer, parseTpsEd25519Header } from "./ed25519-auth.js";
import { isKnownAgentReplay, claimAgentNonce } from "./replay-store.js";
import { isForbiddenOwnerMutation, ownerMutationRefusal, resolveGuardedRecord } from "./record-owner-guard.js";
import { checkHttpRateLimit } from "./rate-limit.js";
import { FLAIR_AUTH_MIDDLEWARE_HTTP_NAME } from "./multi-worker-guard.js";
import { stripUndeclaredMemoryAttributes, DECLARED_MEMORY_ATTRIBUTES } from "./memory-declared-attributes.js";
import { idSegmentHasEncodedSlash, decodeMemoryIdSegment, MEMORY_CONTENT_SELECTOR_SUFFIX } from "../src/lib/memory-id-policy.js";
import { contentSuffixIdDenial } from "./memory-id-guard.js";

// --- Non-admin Memory read: ignore the caller's selection --------------------
//
// flair#1940 round 17. A non-admin HTTP Memory read returns the authorized,
// pointer-projected row; a caller `select(...)` or `property` is dropped from the
// request URL before Harper parses it, while conditions, operator, sort, limit
// and offset are left exactly as sent. These helpers are the whole of that
// normalization.

const DECLARED_MEMORY_ATTRIBUTE_SET = new Set<string>(
  DECLARED_MEMORY_ATTRIBUTES as readonly string[],
);

function isMemoryReadPath(pathname: string): boolean {
  return pathname === "/Memory" || pathname === "/Memory/" || pathname.startsWith("/Memory/");
}

/** True when a path segment is valid percent-encoding. */
function isValidPercentEncoding(segment: string): boolean {
  try {
    decodeURIComponent(segment);
    return true;
  } catch {
    return false;
  }
}

// Drop a caller's `select(...)` and `property` from a Memory read URL, keeping
// conditions, operator, sort, limit and offset. Returns the input unchanged when
// the URL carries no selection.
function stripMemorySelection(rawUrl: string): string {
  const q = rawUrl.indexOf("?");
  let pathPart = q === -1 ? rawUrl : rawUrl.slice(0, q);
  let query = q === -1 ? "" : rawUrl.slice(q + 1);

  // Path form: Harper reads a trailing `.<declared>` on the id as `property`.
  // Harper decides on the DECODED path — RequestTarget decodes the path
  // (`this.id = decodeURIComponent(path)`) and Resource.parsePath then splits at
  // the first dot — so the middleware must decide on the decoded segment too, or
  // it misses a percent-encoded dot: `%2E` (and `%2e`) IS a dot to Harper. Drop
  // that suffix so the id addresses the full row; a suffix that is not a
  // declared Memory attribute stays part of the id, exactly as Harper's own rule
  // leaves it (a content-type extension such as `json` is not a declared
  // attribute, so it is left for Harper to read as a content type).
  const slash = pathPart.lastIndexOf("/");
  const seg = pathPart.slice(slash + 1);
  const decodedSeg = decodeMemoryIdSegment(seg);
  const dot = decodedSeg.indexOf(".");
  // An encoded `/` in the id segment makes the segment ambiguous: the trailing
  // `.<declared attribute>` could be part of the id, or a selector on a
  // slash-containing id.
  if (!idSegmentHasEncodedSlash(seg) &&
      dot > -1 && DECLARED_MEMORY_ATTRIBUTE_SET.has(decodedSeg.slice(dot + 1))) {
    // Rebuild the id from its decoded form. Harper decodes the path it is handed,
    // so this re-encoded segment addresses the SAME id, without the property.
    pathPart = `${pathPart.slice(0, slash + 1)}${encodeURIComponent(decodedSeg.slice(0, dot))}`;
  }

  // Query form: drop every `select(...)` token and every `property` parameter.
  for (const [start, end] of selectSpans(query).reverse()) {
    query = query.slice(0, start) + query.slice(end);
  }
  query = query
    .split("&")
    .filter((p) => p !== "" && p !== "property" && !p.startsWith("property="))
    .join("&");
  // A run of separators left by removing `select(...)` tokens carries nothing.
  if (/^[,;]*$/.test(query)) query = "";

  if (q === -1) return pathPart;
  return query === "" ? pathPart : `${pathPart}?${query}`;
}

/**
 * True when a Memory by-id read path names an id segment that carries an encoded
 * `/` (`%2F`/`%2f`) AND would otherwise be given the property-suffix rewrite in
 * stripMemorySelection. Such a segment is ambiguous — the trailing
 * `.<declared attribute>` could be part of the id or a selector on an id that
 * contains a slash (flair#2199).
 */
function isAmbiguousEncodedSlashSelector(rawUrl: string): boolean {
  const q = rawUrl.indexOf("?");
  const pathPart = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const slash = pathPart.lastIndexOf("/");
  const seg = pathPart.slice(slash + 1);
  if (!idSegmentHasEncodedSlash(seg)) return false;
  const decodedSeg = decodeMemoryIdSegment(seg);
  const dot = decodedSeg.indexOf(".");
  return dot > -1 && DECLARED_MEMORY_ATTRIBUTE_SET.has(decodedSeg.slice(dot + 1));
}

// [start, end) ranges of every `select(...)` call in a query string, accounting
// for Harper's nested-list form `select((a,b))`.
function selectSpans(query: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const marker = "select(";
  let from = 0;
  for (;;) {
    const idx = query.indexOf(marker, from);
    if (idx < 0) break;
    const before = idx > 0 ? query[idx - 1] : "";
    if (before && /[A-Za-z0-9_$-]/.test(before)) {
      from = idx + marker.length;
      continue;
    }
    let depth = 1;
    let i = idx + marker.length;
    for (; i < query.length; i++) {
      const ch = query[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i >= query.length) break;
    spans.push([idx, i + 1]);
    from = i + 1;
  }
  return spans;
}

// --- Admin credentials ---
// Admin auth is sourced exclusively from Harper's own environment variables
// (HDB_ADMIN_PASSWORD / FLAIR_ADMIN_PASSWORD). No filesystem token file.
//
// FLAIR_ADMIN_TOKEN env var is still accepted for backwards compat but
// emits a deprecation warning on first use.
//
// No permanent cache — env vars are read on every call. This is a no-op
// performance-wise (env reads are fast) but means a process restart with a
// different password works immediately without stale state.
let _deprecationWarned = false;

function getAdminPass(): string | null {
  // Primary source: Harper's own admin password (set at startup via env)
  const primary = process.env.HDB_ADMIN_PASSWORD ?? process.env.FLAIR_ADMIN_PASSWORD;
  if (primary) return primary;

  // Backwards compat: FLAIR_ADMIN_TOKEN (deprecated — never write to disk)
  if (process.env.FLAIR_ADMIN_TOKEN) {
    if (!_deprecationWarned) {
      console.warn("[auth] DEPRECATION: FLAIR_ADMIN_TOKEN is deprecated. Use HDB_ADMIN_PASSWORD instead.");
      _deprecationWarned = true;
    }
    return process.env.FLAIR_ADMIN_TOKEN;
  }

  // No admin password configured — return null and let callers fall through
  return null;
}

// ─── Admin resolution ─────────────────────────────────────────────────────────
// `isAdmin` (FLAIR_ADMIN_AGENTS env + Agent role==="admin", 60s-cached) now lives
// in agent-auth.ts as the single source of truth, imported above. During the
// auth reshape this gate and the per-resource allow* helpers must agree on who's
// an admin — one implementation guarantees they can't diverge.

// ─── Crypto + replay-guard helpers ────────────────────────────────────────────
// WINDOW_MS and importEd25519Key live in ./ed25519-auth.ts, and the replay
// guard (isKnownAgentReplay / claimAgentNonce) in ./replay-store.ts — shared by
// auth-middleware.ts, agent-auth.ts and Presence.ts, so a nonce recorded via
// any one of the three call sites, on any worker thread, is refused by all of
// them, and the crypto/decoder logic can't drift.

async function backfillEmbedding(memoryId: string): Promise<void> {
  try {
    const record = await (databases as any).flair.Memory.get(memoryId);
    if (!record?.content) return;
    if (record.embedding?.length > 100) return;
    // flair#504 Phase 2: 'document' — a backfilled embedding IS a stored
    // document vector, same as the three Memory.ts sites; must match.
    const embedding = await getEmbedding(record.content, "document");
    if (!embedding) return;
    const embedPatch = { embedding };
    stripUndeclaredMemoryAttributes(embedPatch);
    await patchRecord((databases as any).flair.Memory, memoryId, embedPatch);
    console.log(`[auto-embed] ${memoryId}: ${embedding.length}d`);
  } catch (err: any) {
    console.error(`[auto-embed] Failed for ${memoryId}: ${err.message}`);
  }
}

// ─── HTTP middleware ──────────────────────────────────────────────────────────

// Flair's clients use exactly these HTTP methods. Harper routes other methods
// to resource handlers as well; refusing them here, before any other branch of
// the default REST middleware, keeps the tables it serves to the methods their
// handlers are written and tested for. (Separately mounted routes such as /mcp
// and OAuth discovery have their own dispatch chains and method handling.)
const ALLOWED_HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE",
]);

server.http(async (request: any, nextLayer: any) => {
  // ── HTTP method allowlist, FIRST ───────────────────────────────────────────
  // Before the public-path passthrough and before any auth branch, so no path
  // and no caller (anonymous, agent or admin) can reach a handler through any
  // other method.
  // Exact match: HTTP methods are case-sensitive, and these are the spellings
  // Flair's clients send.
  const httpMethod = String(request.method ?? "");
  if (!ALLOWED_HTTP_METHODS.has(httpMethod)) {
    return new Response(JSON.stringify({
      error: "method_not_allowed",
      detail: `Flair accepts ${[...ALLOWED_HTTP_METHODS].join(", ")}.`,
    }), {
      status: 405,
      headers: { "content-type": "application/json", allow: [...ALLOWED_HTTP_METHODS].join(", ") },
    });
  }

  const url = new URL(request.url, "http://" + (request.headers.get("host") || "localhost"));

  // ── Rate limiting, right after the method check ────────────────────────────
  // Before the public-path passthrough below (the OAuth endpoints all sit on it,
  // so a hook placed after it would never run for them), and before anything
  // reads a credential. A request refused by the method check above never
  // reaches the limiter, and consumes no budget.
  //
  // Ordering is a security property, not tidiness. The counter is consumed for
  // every request to a throttled endpoint that passes the method check, whether
  // or not the credential that
  // came with it was any good — if only failures were counted, "did this consume
  // budget" would answer "was that credential valid", which is a cleaner
  // enumeration oracle than the 400 the endpoint already returns. Because the
  // decision is made here, a limited request carries no information about what
  // it was carrying: a valid authorization code and a garbage one get the same
  // 429 and the same body.
  //
  // Only the OAuth endpoints named in rate-limit.ts's PATH_POLICY are affected.
  // Every other path — /Memory, /Presence, /FederationSync, everything agents
  // actually use — returns null here and is untouched.
  const limited = checkHttpRateLimit(request, url.pathname);
  if (limited) return limited;

  // ── Malformed `.content` Memory path: the named 400, for every caller ────────
  // flair#2307 item 2: Harper's OWN path decode answers a 500 for invalid
  // percent-encoding, before any resource by-id guard can run. A Memory path
  // whose last segment is invalid percent-encoding AND ends in the `.content`
  // property suffix is refused here with the guard's named 400 instead. Placed
  // before every auth branch (the public-path passthrough, the Basic-admin and
  // anonymous early returns, the signed-agent path), so the refusal does not
  // depend on the request's credential, and no row is read or written for it.
  if (isMemoryReadPath(url.pathname)) {
    const seg = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    if (seg.endsWith(MEMORY_CONTENT_SELECTOR_SUFFIX) && !isValidPercentEncoding(seg)) {
      return contentSuffixIdDenial(seg);
    }
  }

  // A2A discovery endpoints: GET returns public agent-card metadata (per
  // A2A spec, cards are intentionally public). POST invokes JSON-RPC
  // actions (message/send writes OrgEvents on behalf of agents,
  // tasks/list reads Beads issues, message/stream subscribes to
  // OrgEvents) — those must be authenticated. Narrowing to GET-only
  // closes the P0 where any caller could forge OrgEvents as any agent
  // and read all internal Beads issues unauthenticated.
  const header = request.headers.get("authorization") || request.headers?.asObject?.authorization || "";
  const isTpsEd25519 = /^TPS-Ed25519(?:\s|$)/i.test(header);
  const isA2APath = url.pathname === "/a2a" || url.pathname === "/A2AAdapter" || url.pathname.startsWith("/A2AAdapter/");
  if (!isTpsEd25519 && (
    url.pathname === "/health" ||
    url.pathname === "/Health" ||
    (request.method === "GET" && isA2APath) ||
    url.pathname === "/AgentCard" ||
    url.pathname.startsWith("/AgentCard/") ||
    // FederationSync uses Ed25519 body-signature auth with anti-replay, validated
    // by the resource handler (allowCreate=true, same pattern as FederationPair).
    url.pathname === "/FederationSync" ||
    // FederationPair uses one-time PairingToken in the request body, validated
    // by the resource itself (allowCreate=true on the Resource lets anonymous
    // POST through Harper's role gate). Bearer can't be used here because
    // Harper's auth layer claims any "Bearer X" Authorization header for itself.
    url.pathname === "/FederationPair" ||
    // OAuth 2.1 public endpoints (spec requires no pre-auth)
    url.pathname === "/OAuthRegister" ||
    url.pathname === "/OAuthAuthorize" ||
    url.pathname === "/OAuthToken" ||
    url.pathname === "/OAuthRevoke" ||
    // Belt-and-braces since flair#1000: `/.well-known/oauth-authorization-server`
    // is served from its OWN urlPath mount (resources/oauth-wellknown.ts), which
    // gets its own dispatch chain — this middleware never sees a request for it.
    // The entry stays so the path is still public if that mount ever moves back
    // onto the default chain.
    url.pathname === "/.well-known/oauth-authorization-server" ||
    url.pathname === "/OAuthMetadata"
  )) return nextLayer(request);

  // If Harper has already authorized this request (e.g. Basic admin, or
  // authorizeLocal=true on localhost), trust Harper's auth decision and pass
  // through. Annotate the admin identity so resources' resolveAgentAuth recognizes
  // this as an ADMIN caller (not anonymous) — otherwise a Basic-admin request,
  // which carries no TPS-Ed25519 header, gets classified anonymous and denied.
  //
  // flair#610 BELT-AND-SUSPENDERS: require an Authorization header to be present
  // before trusting a super_user `request.user`. Harper's `authorizeLocal: true`
  // forges request.user=super_user for a credential-LESS loopback request; a
  // genuine Basic/super_user caller always carries a header. This is defense-in-
  // depth — the general middleware path below already marks a headerless request
  // tpsAnonymous BEFORE Harper's ambient elevation lands, so this branch isn't a
  // live vector today — but it keeps the trust decision from ever hinging on
  // ambient elevation alone. (The root-cause gate lives in resolveAgentAuth; see
  // agent-auth.ts hasCredentialEvidence.)
  if (!isTpsEd25519 && header && request.user?.role?.permission?.super_user === true) {
    const username = request.user.username ?? "admin";
    // Deactivation guard — same predicate as the Ed25519 path.
    // A deactivated principal must not receive a tpsAgent annotation, even
    // when Harper's ambient auth already verified the credential.
    const agentRecord = await (databases as any).flair.Agent.get(username).catch(() => null);
    if (!isPrincipalDeactivated(agentRecord)) {
      request.tpsAgent = username;
      request.tpsAgentIsAdmin = true;
      try {
        request.headers.set("x-tps-agent", request.tpsAgent);
        if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = request.tpsAgent;
      } catch { /* frozen headers — annotation on request object still applies */ }
      return nextLayer(request);
    }
    // Deactivated — fall through. The request continues through the
    // middleware chain (Basic block → Ed25519 → anonymous) without tpsAgent.
  }

  // Skip re-entry: if we already swapped auth to Basic, pass through
  if ((request as any)._tpsAuthVerified) return nextLayer(request);

  // ── Basic admin / super_user auth ──────────────────────────────────────────
  // Allow Basic auth for CLI operations (backup, etc.). Two paths:
  // 1. HDB_ADMIN_PASSWORD env-var fast-path (user must be "admin" with exact pass)
  // 2. Harper super_user check — any user with super_user:true permission accepted
  // Checked BEFORE Ed25519 so admin tools can use simple auth.
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
      const colonIdx = decoded.indexOf(":");
      const user = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
      const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "";

      // Path 1: Env-var fast-path (back-compat). Only matches user==="admin"
      // with exact HDB_ADMIN_PASSWORD. Non-match falls through to Path 2.
      const adminPass = getAdminPass();
      if (adminPass !== null && user === "admin" && pass === adminPass) {
        // Deactivation guard — same predicate, called before tpsAgent is stamped.
        const agentRecord = await (databases as any).flair.Agent.get("admin").catch(() => null);
        if (!isPrincipalDeactivated(agentRecord)) {
          // Mark as verified and set Harper user directly
          (request as any)._tpsAuthVerified = true;
          try {
            request.user = await (server as any).getUser("admin", null, request);
          } catch { /* fallback: let original Basic header pass through */ }
          request.headers.set("x-tps-agent", "admin");
          if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = "admin";
          request.tpsAgent = "admin";
          request.tpsAgentIsAdmin = true;
          return nextLayer(request);
        }
        // Deactivated — fall through to anonymous (end of Basic block).
      }

      // Path 2: Harper super_user check — any user with super_user:true
      let harperUser: any = null;
      try {
        harperUser = await (server as any).getUser(user, pass, request);
      } catch { /* fall through — invalid creds, non-existent user, etc. */ }

      if (harperUser?.role?.permission?.super_user === true) {
        // Deactivation guard — same predicate, called before tpsAgent is stamped.
        const agentRecord = await (databases as any).flair.Agent.get(user).catch(() => null);
        if (!isPrincipalDeactivated(agentRecord)) {
          (request as any)._tpsAuthVerified = true;
          request.user = harperUser;
          request.headers.set("x-tps-agent", user);
          if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = user;
          request.tpsAgent = user;
          request.tpsAgentIsAdmin = true;
          return nextLayer(request);
        }
        // Deactivated — fall through to anonymous (end of Basic block).
      }

      // Path 3: flair_pair_initiator — restricted to /FederationPair only.
      // Bootstrap credentials (pair-bootstrap-<id>) may only be used on this
      // one endpoint. Any other path must fall through to 401.
      if (url.pathname === "/FederationPair" && user.startsWith("pair-bootstrap-")) {
        let pairUser: any = null;
        try {
          pairUser = await (server as any).getUser(user, pass, request);
        } catch { /* fall through */ }

        if (
          pairUser?.role?.role === "flair_pair_initiator" &&
          pairUser?.active === true
        ) {
          // Deactivation guard — same predicate, called before tpsAgent is stamped.
          const agentRecord = await (databases as any).flair.Agent.get(user).catch(() => null);
          if (!isPrincipalDeactivated(agentRecord)) {
            (request as any)._tpsAuthVerified = true;
            request.user = pairUser;
            request.headers.set("x-tps-agent", user);
            if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = user;
            request.tpsAgent = user;
            request.tpsAgentIsAdmin = false;
            return nextLayer(request);
          }
          // Deactivated — fall through to anonymous (end of Basic block).
        }
      }
    } catch { /* fall through to anonymous */ }
    // NON-REJECTING (auth-rbac flip): a Basic header that matched no admin/super_user/
    // pair path → annotate anonymous + pass through (don't 401 — a sibling component's
    // Basic auth on a shared Harper must not be rejected by flair's gate). Resource
    // allow* denies if the path is flair-protected.
    request.tpsAnonymous = true;
    try {
      request.headers.set("x-tps-anonymous", "1");
      if (request.headers.asObject) (request.headers.asObject as any)["x-tps-anonymous"] = "1";
    } catch { /* frozen headers */ }
    return nextLayer(request);
  }

  // ── Ed25519 agent auth ────────────────────────────────────────────────────
  const parsed = parseTpsEd25519Header(header);

  if (!parsed) {
    if (isTpsEd25519) return new Response(JSON.stringify({ error: "invalid_authorization_header" }), { status: 401 });
    // For browser-accessible admin pages, emit `WWW-Authenticate: Basic` so
    // the browser shows a native auth dialog instead of a bare 401 page.
    // JSON API endpoints don't get this — they should keep the structured
    // 401 body so the client can parse the error.
    const isAdminPage = url.pathname === "/Admin" || url.pathname.startsWith("/Admin");
    if (isAdminPage) {
      return new Response("Authentication required.", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Flair Admin"',
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }
    // NON-REJECTING GATE (auth-rbac flip): no valid agent → annotate anonymous and
    // pass through. Per-resource allow* (resolveAgentAuth → anonymous → deny) is the
    // enforcement; the gate no longer 401s instance-wide, which was breaking sibling
    // components on a shared Harper / composite hub. Anonymous reaches only public
    // allow-listed paths + resources whose allow* permit it.
    request.tpsAnonymous = true;
    try {
      request.headers.set("x-tps-anonymous", "1");
      if (request.headers.asObject) (request.headers.asObject as any)["x-tps-anonymous"] = "1";
    } catch { /* frozen headers — annotation on the request object still applies */ }
    return nextLayer(request);
  }

  const { agentId, tsRaw, nonce, signatureB64 } = parsed;
  const ts = Number(tsRaw);
  const now = Date.now();

  if (!Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS)
    return new Response(JSON.stringify({ error: "timestamp_out_of_window" }), { status: 401 });

  // A nonce this thread already saw recorded is refused before any lookup. A
  // miss here proves nothing: claimAgentNonce below is the authoritative check.
  if (isKnownAgentReplay(agentId, nonce, now))
    return new Response(JSON.stringify({ error: "nonce_replay_detected" }), { status: 401 });

  const agent = await (databases as any).flair.Agent.get(agentId);
  if (!agent) return new Response(JSON.stringify({ error: "unknown_agent" }), { status: 401 });

  // Deactivation guard — same predicate as the per-resource verify path in
  // agent-auth.ts.  A deactivated principal cannot authenticate.
  if (isPrincipalDeactivated(agent)) {
    return new Response(JSON.stringify({ error: "principal_deactivated" }), { status: 401 });
  }

  try {
    const payload = `${agentId}:${tsRaw}:${nonce}:${request.method}:${url.pathname}${url.search}`;
    const key = await importEd25519Key(agent.publicKey);
    const sigBuf = b64ToArrayBuffer(signatureB64);
    const payloadBuf = new TextEncoder().encode(payload);
      const ok = await crypto.subtle.verify(
      { name: "Ed25519" } as any, key,
      sigBuf,
      payloadBuf
    );
      if (!ok) return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
  } catch (e: any) {
      return new Response(JSON.stringify({ error: "signature_verification_failed", detail: e?.message }), { status: 401 });
  }

  // Record the nonce instance-wide now that the signature has verified, and
  // before the request reaches anything else. A replay (401) or an unusable
  // replay store (503, named in the server log) refuses.
  const claim = await claimAgentNonce(agentId, nonce);
  if (!claim.ok) return new Response(JSON.stringify({ error: claim.error }), { status: claim.status });

  request.tpsAgent = agentId;
  (request as any)._tpsAuthVerified = true;
  request.tpsAgentIsAdmin = await isAdmin(agentId);

  // RESHAPE (auth-rbac) — THE FLIP: per-agent DE-ELEVATION. A cryptographically-
  // verified NON-admin agent resolves to the least-privilege `flair-agent` user,
  // NOT admin super_user. The flair_agent role grants exactly the table CRUD agents
  // need; with no operations grant, /sql + /graphql are natively 403 (the hand-
  // rolled raw-query block below becomes belt-and-suspenders). Admins still resolve
  // to admin. getUser(name, null) looks up WITHOUT password validation — safe
  // because the Ed25519 signature already proved identity. Row-level ownership stays
  // enforced via x-tps-agent / resolveAgentAuth, independent of request.user.
  //
  // GRACEFUL FALLBACK: if the flair-agent user isn't provisioned on this instance
  // yet (pre-migration — ensureFlairAgentUser hasn't run), fall back to admin so
  // agents keep working. De-elevation activates per-instance once the user exists.
  try {
    if (request.tpsAgentIsAdmin) {
      request.user = await (server as any).getUser("admin", null, request);
    } else {
      let deElevated: any = null;
      try { deElevated = await (server as any).getUser(FLAIR_AGENT_USERNAME, null, request); } catch { /* not provisioned */ }
      // getUser(name, null) returns a ROLE-LESS phantom `{ username }` (not null,
      // not a throw) for a nonexistent user — harper security/user.js
      // findAndValidateUser: `if (!userTmp) { if (!validatePassword) return { username } }`.
      // A phantom is truthy, so `deElevated ?? admin` would keep it and the request
      // would carry NO role → 403 AccessViolation. Require a real role to use the
      // de-elevated user; otherwise fall back to admin (pre-migration instances).
      request.user = (deElevated && deElevated.role)
        ? deElevated
        : await (server as any).getUser("admin", null, request);
    }
  } catch {
    // No usable user record — request proceeds as the verified tpsAgent without
    // elevated perms; resource-level scoping (x-tps-agent) still applies.
  }

  // Propagate authenticated agent to downstream resources via header.
  // Resources can read this to enforce agent-level scoping.
  request.headers.set("x-tps-agent", agentId);
  if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = agentId;

  // ── Raw query endpoint block (non-admins) ─────────────────────────────────
  // SQL and GraphQL endpoints bypass all resource-level scoping — block them
  // for non-admin agents. Admins (bootstrap, consolidation scripts) still pass.
  if (!request.tpsAgentIsAdmin) {
    const rawPath = url.pathname.toLowerCase();
    if (
      rawPath === "/sql" || rawPath.startsWith("/sql/") ||
      rawPath === "/graphql" || rawPath.startsWith("/graphql/")
    ) {
      return new Response(
        JSON.stringify({ error: "forbidden: raw query endpoints require admin access" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // ── Server-side permission guards ──────────────────────────────────────────

  const method = request.method.toUpperCase();
  const isMutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";

  // ── THE record-ownership rule, for every table, on every mutating verb ─────
  //
  // One enforcement point rather than one per resource. See
  // resources/record-owner-guard.ts for why this is not written into each
  // resource's put(): Harper maps verbs to methods one-to-one, so a rule living
  // in put() is enforced on PUT alone, and nearly every resource wrote its rules
  // there. Doing this per-resource would be N chances to get one wrong and would
  // still leave the next resource broken by default.
  //
  // Ownership is read from the STORED record named by the path — never from the
  // request body, which is the caller's claim about who owns the row and was how
  // a body that simply omitted the field passed unchecked.
  //
  // Deliberately scoped to records that ALREADY EXIST: creation is left to each
  // resource's own no-forge attribution. That keeps this incapable of breaking a
  // create, a self-write, or a legitimate cross-agent field like MemoryGrant's
  // granteeId — it can only narrow mutation of another agent's stored row.
  if (isMutation && !request.tpsAgentIsAdmin) {
    const guarded = resolveGuardedRecord(url.pathname);
    if (guarded) {
      try {
        const record = await (databases as any).flair[guarded.table]?.get(guarded.id);
        if (isForbiddenOwnerMutation(record, guarded.ownerField, agentId)) {
          return ownerMutationRefusal(guarded.table);
        }
      } catch { /* unreadable row → fall through to the resource's own rules */ }
    }
  }

  if (isMutation) {
    // OrgEvent: authorId must match authenticated agent
    if ((url.pathname === "/OrgEvent" || url.pathname.startsWith("/OrgEvent/")) &&
        (method === "POST" || method === "PUT" || method === "PATCH")) {
      if (!request.tpsAgentIsAdmin) {
        try {
          // NOTE: dead code — Harper's middleware Request has no parsed body
          // (no .clone()/.json()), so this body-check never fires. Owner/
          // attribution enforcement lives in the resource layer (record-owner-
          // guard + owner-field-guard). Kept for a separate cleanup PR — not
          // live coverage.
          const clone = request.clone();
          const body = await clone.json();
          if (body?.authorId && body.authorId !== agentId) {
            return new Response(JSON.stringify({
              error: "forbidden: authorId must match authenticated agent"
            }), { status: 403 });
          }
        } catch {}
      }
    }

    // OrgEvent DELETE: ownership check
    if (url.pathname.startsWith("/OrgEvent/") && method === "DELETE") {
      if (!request.tpsAgentIsAdmin) {
        try {
          const pathParts = url.pathname.split("/").filter(Boolean);
          const eventId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
          if (eventId) {
            const record = await (databases as any).flair.OrgEvent.get(eventId);
            if (record && record.authorId && record.authorId !== agentId) {
              return new Response(JSON.stringify({
                error: "forbidden: cannot delete events authored by another agent"
              }), { status: 403 });
            }
          }
        } catch {}
      }
    }

    // WorkspaceState: agent-scoped mutations (non-admin can only write own records)
    if ((url.pathname === "/WorkspaceState" || url.pathname.startsWith("/WorkspaceState/")) &&
        (method === "POST" || method === "PUT" || method === "PATCH")) {
      if (!request.tpsAgentIsAdmin) {
        try {
          // NOTE: dead code — Harper's middleware Request has no parsed body
          // (no .clone()/.json()), so this body-check never fires. Owner/
          // attribution enforcement lives in the resource layer (record-owner-
          // guard + owner-field-guard). Kept for a separate cleanup PR — not
          // live coverage.
          const clone = request.clone();
          const body = await clone.json();
          if (body?.agentId && body.agentId !== agentId) {
            return new Response(JSON.stringify({
              error: "forbidden: cannot write workspace state for another agent"
            }), { status: 403 });
          }
        } catch {}
      }
    }

    // WorkspaceState DELETE: ownership check
    if ((url.pathname.startsWith("/WorkspaceState/")) && method === "DELETE") {
      if (!request.tpsAgentIsAdmin) {
        try {
          const pathParts = url.pathname.split("/").filter(Boolean);
          const wsId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
          if (wsId) {
            const record = await (databases as any).flair.WorkspaceState.get(wsId);
            if (record && record.agentId && record.agentId !== agentId) {
              return new Response(JSON.stringify({
                error: "forbidden: cannot delete workspace state for another agent"
              }), { status: 403 });
            }
          }
        } catch {}
      }
    }

    // Soul mutations: only the owner or an admin may write a soul entry.
    //
    // This guard had two independent holes, either of which alone let one agent
    // rewrite another's identity data:
    //
    //   1. THE VERB LIST enumerated PUT and POST only. Its three siblings above
    //      (OrgEvent, WorkspaceState, Memory) all include PATCH, and Memory
    //      includes DELETE; this one did neither. Harper routes PATCH to a
    //      resource method that carries no ownership check of its own
    //      (Soul.ts's enforceWriteAuth covers post()/put()), and DELETE reached
    //      the table with no per-record check at all. Both were live.
    //
    //   2. IT COMPARED THE BODY, not the target. `body.agentId` is the owner
    //      the CALLER claims, and the check only fired when that field was
    //      present and mismatched — so a body omitting it, which a partial
    //      write naturally does, was compared against nothing and passed
    //      whatever record the URL pointed at. The resource-level check behind
    //      it is "validate-truthy" attribution, which by design also passes an
    //      ABSENT owner field, so nothing downstream caught it either. (A PUT
    //      happened to fail anyway, but on `agentId: String!` schema
    //      validation — a 400 for the wrong reason, not an authorization
    //      decision, and not a defence to rely on.)
    //
    // Closing one hole leaves the other reachable through the remaining verbs,
    // so both are closed here: every mutating verb is covered, and ownership is
    // resolved from the STORED RECORD named by the path. That is the same shape
    // as the Memory ownership guard below, which is the resource in this file
    // that already had it right — worth copying rather than reinventing.
    //
    // The path test stays `startsWith("/Soul")` so sibling routes keep the
    // body check they already had; the record lookup is scoped to the real
    // `/Soul/<id>` collection so it never resolves an unrelated id.
    if (url.pathname.startsWith("/Soul") &&
        (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE")) {
      if (!request.tpsAgentIsAdmin) {
        // (a) A PRESENT, mismatched body agentId is a forged attribution.
        if (method !== "DELETE") {
          let bodyAgentId: string | null = null;
          try {
            // NOTE: dead code — Harper's middleware Request has no parsed body
            // (no .clone()/.json()), so this body-check never fires. Owner/
            // attribution enforcement lives in the resource layer (record-owner-
            // guard + owner-field-guard). Kept for a separate cleanup PR — not
            // live coverage.
            const clone = request.clone();
            const body = await clone.json();
            bodyAgentId = body?.agentId ?? null;
          } catch {}
          if (bodyAgentId && bodyAgentId !== agentId) {
            return new Response(JSON.stringify({ error: "forbidden: non-admin cannot modify another agent's soul" }), { status: 403 });
          }
        }

        // (b) The owner of the record actually being written — the half that
        // catches a body simply leaving agentId out — is now the shared
        // record-ownership rule at the top of this block, which applies it to
        // every table on every mutating verb. Deliberately NOT repeated here:
        // one condition enforced in two places is how the two drift apart.
      }
    }

    // Memory workflow-field provenance is enforced on parsed resource writes.

    // Memory deletion uses the shared stored-owner rule for every tier.
  }

  // ── WorkspaceState read guard: agent-scoped reads ───────────────────────────
  if (method === "GET" && !request.tpsAgentIsAdmin) {
    if (url.pathname === "/WorkspaceState" || url.pathname === "/WorkspaceState/") {
      const queryAgent = url.searchParams.get("agentId");
      if (queryAgent && queryAgent !== agentId) {
        return new Response(JSON.stringify({
          error: "forbidden: cannot read workspace state for another agent"
        }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    }
  }

  // ── Mutation scoping: agentId in body must match authenticated agent ────────
  // The resource handlers also enforce this (defense-in-depth), but rejecting
  // early avoids unnecessary work. We don't use request.clone().json() because
  // Harper's Request is not a Web API Request — it wraps a Node.js stream.
  // Instead, the resource-level check (e.g. BootstrapMemories line 58) handles
  // body-level enforcement since it receives the parsed data from Harper's REST
  // layer. The middleware's job is identity verification (done above).

  // ── Memory read: a non-admin read ignores the caller's selection ─────────────
  // flair#1940 round 17 (design ruling): a non-admin HTTP Memory read does NOT
  // honour a caller `select(...)` or `property`. As soon as authentication has
  // established that the caller is not an admin — and BEFORE anything reads a
  // Memory row or hands the request to the next layer — the request URL is
  // normalized to drop the caller's selection, keeping conditions, operator,
  // sort, limit and offset exactly as sent. Harper builds its REST target from
  // this URL AFTER this middleware, so the original selection cannot be
  // reapplied. An admin read and a trusted internal read are unchanged, while a
  // direct contextual non-admin read now ignores the selection too (the same
  // contract, applied in `Memory.get`/`Memory.search`). The by-id
  // read-scope denial is enforced by the resource layer (memoryByIdReadGate),
  // which returns the same 404 this middleware used to return.
  // (A malformed `.content` segment was refused before any auth branch, above.)
  if (!request.tpsAgentIsAdmin && (method === "GET" || method === "HEAD") && isMemoryReadPath(url.pathname)) {
    // flair#2199: an id segment carrying an encoded `/` before a declared
    // property suffix is ambiguous — the suffix could be part of the id or a
    // selector on a slash-containing id. This branch runs for a signed
    // non-admin agent: Basic-admin and anonymous requests returned to the next
    // layer before it.
    if (isAmbiguousEncodedSlashSelector(request.url)) {
      return new Response(method === "HEAD" ? null : JSON.stringify({
        error: "ambiguous_memory_id",
        message: `a Memory request whose id segment contains an encoded '/' before a "${MEMORY_CONTENT_SELECTOR_SUFFIX}" (or other property) suffix is refused: the suffix cannot be told from part of the id`,
      }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const stripped = stripMemorySelection(request.url);
    if (stripped !== request.url) request.url = stripped;
  }

  // ── Embedding backfill ─────────────────────────────────────────────────────

  const isMemoryWrite = isMutation && (url.pathname === "/Memory" || url.pathname.startsWith("/Memory/"));
  let memoryId: string | null = null;
  if (isMemoryWrite) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    memoryId = pathParts.length >= 2 ? decodeMemoryIdSegment(pathParts[1]) : (request.headers.get("x-memory-id") ?? null);
  }

  const response = await nextLayer(request);

  if (isMemoryWrite && memoryId && response.status >= 200 && response.status < 300) {
    backfillEmbedding(memoryId).catch(() => {});
  }

  return response;
}, { runFirst: true, name: FLAIR_AUTH_MIDDLEWARE_HTTP_NAME });
