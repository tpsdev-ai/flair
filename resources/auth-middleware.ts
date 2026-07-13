import { patchRecord } from "./table-helpers.js";
import { server, databases } from "@harperfast/harper";
import { getEmbedding } from "./embeddings-provider.js";
import { isAdmin, FLAIR_AGENT_USERNAME } from "./agent-auth.js";
import { WINDOW_MS, isNonceReplay, recordNonce, importEd25519Key, b64ToArrayBuffer } from "./ed25519-auth.js";
import { resolveReadScope } from "./memory-read-scope.js";

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
// WINDOW_MS, isNonceReplay/recordNonce (the ONE shared nonce store), and
// importEd25519Key all live in ./ed25519-auth.ts — the single
// shared implementation imported by auth-middleware.ts, agent-auth.ts, and
// Presence.ts so a nonce recorded via any one of the three call sites is
// visible to the other two, and the crypto/decoder logic can't drift.

async function backfillEmbedding(memoryId: string): Promise<void> {
  try {
    const record = await (databases as any).flair.Memory.get(memoryId);
    if (!record?.content) return;
    if (record.embedding?.length > 100) return;
    // flair#504 Phase 2: 'document' — a backfilled embedding IS a stored
    // document vector, same as the three Memory.ts sites; must match.
    const embedding = await getEmbedding(record.content, "document");
    if (!embedding) return;
    await patchRecord((databases as any).flair.Memory, memoryId, { embedding });
    console.log(`[auto-embed] ${memoryId}: ${embedding.length}d`);
  } catch (err: any) {
    console.error(`[auto-embed] Failed for ${memoryId}: ${err.message}`);
  }
}

// ─── HTTP middleware ──────────────────────────────────────────────────────────

server.http(async (request: any, nextLayer: any) => {
  const url = new URL(request.url, "http://" + (request.headers.get("host") || "localhost"));

  // A2A discovery endpoints: GET returns public agent-card metadata (per
  // A2A spec, cards are intentionally public). POST invokes JSON-RPC
  // actions (message/send writes OrgEvents on behalf of agents,
  // tasks/list reads Beads issues, message/stream subscribes to
  // OrgEvents) — those must be authenticated. Narrowing to GET-only
  // closes the P0 where any caller could forge OrgEvents as any agent
  // and read all internal Beads issues unauthenticated.
  const isA2APath = url.pathname === "/a2a" || url.pathname === "/A2AAdapter" || url.pathname.startsWith("/A2AAdapter/");
  if (
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
    url.pathname === "/.well-known/oauth-authorization-server" ||
    url.pathname === "/OAuthMetadata" ||
    // Presence roster is public-safe (field-allowlisted); GET serves the
    // Office Space renderer without auth. Scoped to GET only (#604): the
    // exact-path match used to match ANY method, so a bare `PUT /Presence`
    // (collection-level, no id — Harper routes it to the same .put() as
    // by-id PUT) early-returned here too, skipping this middleware entirely.
    // A credential-less loopback PUT then reached Presence.put()'s
    // resolveAgentAuth() call with NO tpsAnonymous/tpsAgent annotation, which
    // fell through to raw `context.user` — populated by Harper's
    // `authorizeLocal` (config true) ambient super_user injection for ANY
    // credential-less loopback request — so the ownership check saw an
    // "admin" caller (isAdmin=true) and let the write through unauthenticated
    // (`super.put()`, no signature, no password). Mirrors the A2A GET-only
    // pattern above: POST/PUT/DELETE now always transit the general
    // middleware path below, which marks a genuinely headerless request
    // tpsAnonymous BEFORE Harper's ambient elevation lands (resolveAgentAuth
    // checks tpsAnonymous first — see agent-auth.ts's resolution order), so
    // the ownership check in Presence.put()/delete() correctly denies it.
    // POST (the heartbeat) is unaffected in practice: it already prefers
    // request.tpsAgent when the middleware set it, and falls back to its own
    // Ed25519 header parse otherwise — transiting the general path now just
    // means a genuinely headerless POST gets marked anonymous (still 401)
    // instead of skipping straight to that fallback parse.
    (request.method === "GET" && url.pathname === "/Presence")
  ) return nextLayer(request);

  // Read the Authorization header ONCE, up front — the super_user branch below
  // needs it too (hoisted from its former position just after the branch as part
  // of the flair#610 belt-and-suspenders check).
  const header = request.headers.get("authorization") || request.headers?.asObject?.authorization || "";

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
  if (header && request.user?.role?.permission?.super_user === true) {
    request.tpsAgent = request.user.username ?? "admin";
    request.tpsAgentIsAdmin = true;
    try {
      request.headers.set("x-tps-agent", request.tpsAgent);
      if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = request.tpsAgent;
    } catch { /* frozen headers — annotation on request object still applies */ }
    return nextLayer(request);
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

      // Path 2: Harper super_user check — any user with super_user:true
      let harperUser: any = null;
      try {
        harperUser = await (server as any).getUser(user, pass, request);
      } catch { /* fall through — invalid creds, non-existent user, etc. */ }

      if (harperUser?.role?.permission?.super_user === true) {
        (request as any)._tpsAuthVerified = true;
        request.user = harperUser;
        request.headers.set("x-tps-agent", user);
        if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = user;
        request.tpsAgent = user;
        request.tpsAgentIsAdmin = true;
        return nextLayer(request);
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
          (request as any)._tpsAuthVerified = true;
          request.user = pairUser;
          request.headers.set("x-tps-agent", user);
          if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = user;
          request.tpsAgent = user;
          request.tpsAgentIsAdmin = false;
          return nextLayer(request);
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
  const m = header.match(/^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/);

  if (!m) {
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

  const [, agentId, tsRaw, nonce, signatureB64] = m;
  const ts = Number(tsRaw);
  const now = Date.now();

  if (!Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS)
    return new Response(JSON.stringify({ error: "timestamp_out_of_window" }), { status: 401 });

  if (isNonceReplay(agentId, nonce, now))
    return new Response(JSON.stringify({ error: "nonce_replay_detected" }), { status: 401 });

  const agent = await (databases as any).flair.Agent.get(agentId);
  if (!agent) return new Response(JSON.stringify({ error: "unknown_agent" }), { status: 401 });

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

  recordNonce(agentId, nonce, ts);
  request.tpsAgent = agentId;
  (request as any)._tpsAuthVerified = true;
  request.tpsAgentIsAdmin = await isAdmin(agentId);

  // Grant Harper-level permissions for the cryptographically-verified agent by
  // setting request.user directly. Setting request.user is the supported
  // extension path (and the only one that works post-5.0.9: Harper resolves
  // request.user from the Authorization header BEFORE this middleware runs, and
  // a TPS-Ed25519 header matches no Basic/Bearer strategy, so request.user
  // arrives null — see #456). getUser(name, null) looks up the record WITHOUT
  // password validation, safe here because the Ed25519 signature already proved
  // identity cryptographically.
  //
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

  if (isMutation) {
    // OrgEvent: authorId must match authenticated agent
    if ((url.pathname === "/OrgEvent" || url.pathname.startsWith("/OrgEvent/")) &&
        (method === "POST" || method === "PUT" || method === "PATCH")) {
      if (!request.tpsAgentIsAdmin) {
        try {
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

    // Soul PUT: only owner or admin
    if (url.pathname.startsWith("/Soul") && (method === "PUT" || method === "POST")) {
      if (!request.tpsAgentIsAdmin) {
        let bodyAgentId: string | null = null;
        try {
          const clone = request.clone();
          const body = await clone.json();
          bodyAgentId = body?.agentId ?? null;
        } catch {}
        if (bodyAgentId && bodyAgentId !== agentId) {
          return new Response(JSON.stringify({ error: "forbidden: non-admin cannot modify another agent's soul" }), { status: 403 });
        }
      }
    }

    // Memory promotion guard: only admin can approve or set durability=permanent
    if (((url.pathname === "/Memory" || url.pathname.startsWith("/Memory/") || url.pathname === "/memory" || url.pathname.startsWith("/memory/"))) &&
        (method === "PUT" || method === "POST" || method === "PATCH")) {
      if (!request.tpsAgentIsAdmin) {
        try {
          const clone = request.clone();
          const body = await clone.json();
          const setsApproved = body?.promotionStatus === "approved";
          const setsPermanent = body?.durability === "permanent";
          const setsArchived = body?.archived === true;
          if (setsApproved || setsPermanent || setsArchived) {
            return new Response(JSON.stringify({
              error: "forbidden: only admins can approve promotions, set permanent durability, or archive memories"
            }), { status: 403 });
          }
        } catch {}
      }
    }

    // Memory PUT/DELETE: ownership check (non-admin can only modify their own memories)
    if (((url.pathname === "/Memory" || url.pathname.startsWith("/Memory/") || url.pathname === "/memory" || url.pathname.startsWith("/memory/"))) &&
        (method === "PUT" || method === "DELETE" || method === "PATCH")) {
      if (!request.tpsAgentIsAdmin) {
        try {
          const pathParts = url.pathname.split("/").filter(Boolean);
          const memId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
          if (memId) {
            const record = await (databases as any).flair.Memory.get(memId);
            if (record && record.agentId && record.agentId !== agentId) {
              return new Response(JSON.stringify({
                error: `forbidden: cannot modify memory owned by ${record.agentId}`
              }), { status: 403 });
            }
            if (method === "DELETE" && record?.durability === "permanent") {
              return new Response(JSON.stringify({
                error: "forbidden: only admins can purge permanent memories"
              }), { status: 403 });
            }
          }
        } catch {}
      }
    }
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

  // ── Memory GET: non-admin can only read own memories (by ID) ────────────────
  if (!request.tpsAgentIsAdmin && method === "GET") {
    if (url.pathname.startsWith("/Memory/")) {
      try {
        const pathParts = url.pathname.split("/").filter(Boolean);
        const memId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
        if (memId) {
          const record = await (databases as any).flair.Memory.get(memId);
          if (record && record.agentId && record.agentId !== agentId) {
            // Centralized read-scope (Layer 1): a grant only covers
            // the owner's SHARED memories, never their private ones. This
            // used to be a `visibility === "office"` bypass (any authenticated
            // agent, no grant needed) — that's gone; the private-exclusion is
            // now enforced the same way every other read path enforces it.
            const scope = await resolveReadScope(agentId);
            if (!scope.isAllowed(record)) {
              return new Response(JSON.stringify({
                error: `forbidden: cannot read memory owned by ${record.agentId}`,
              }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
          }
        }
      } catch { /* record not found or table error — let resource handle */ }
    }
  }

  // ── Embedding backfill ─────────────────────────────────────────────────────

  const isMemoryWrite = isMutation && (url.pathname === "/Memory" || url.pathname.startsWith("/Memory/"));
  let memoryId: string | null = null;
  if (isMemoryWrite) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    memoryId = pathParts.length >= 2 ? decodeURIComponent(pathParts[1]) : (request.headers.get("x-memory-id") ?? null);
  }

  const response = await nextLayer(request);

  if (isMemoryWrite && memoryId && response.status >= 200 && response.status < 300) {
    backfillEmbedding(memoryId).catch(() => {});
  }

  return response;
}, { runFirst: true });
