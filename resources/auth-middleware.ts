import { WRITE_BACK_ATTEMPTS, WriteBackConflictError, writeBackCommittedRow } from "./write-back.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { server, databases } from "harper";
import { getEmbedding, getModelId } from "./embeddings-provider.js";
import { noteWriteStamp } from "./embedding-space-guard.js";
import { hashEmbeddedText } from "./memory-embed-hash.js";
import { MEMORY_EMBEDDING_INPUT_FIELDS, skillEmbedText } from "./skill-write.js";
import { isAdmin, isPrincipalDeactivated, FLAIR_AGENT_USERNAME, readCredentialedPrincipal, AGENT_LOOKUP_FAILED } from "./agent-auth.js";
import { WINDOW_MS, importEd25519Key, b64ToArrayBuffer, parseTpsEd25519Header } from "./ed25519-auth.js";
import { isKnownAgentReplay, claimAgentNonce } from "./replay-store.js";
import { isForbiddenOwnerMutation, ownerMutationRefusal, resolveGuardedRecord, resolveGuardedRecordById } from "./record-owner-guard.js";
import { routeWithHarper, type HarperRoute } from "./harper-routing.js";
import { checkHttpRateLimit } from "./rate-limit.js";
import { FLAIR_AUTH_MIDDLEWARE_HTTP_NAME } from "./multi-worker-guard.js";
import { DECLARED_MEMORY_ATTRIBUTES } from "./memory-declared-attributes.js";
import { idSegmentHasEncodedSlash, decodeMemoryIdSegment, MEMORY_CONTENT_SELECTOR_SUFFIX } from "../src/lib/memory-id-policy.js";
import { contentSuffixIdDenial } from "./memory-id-guard.js";
import {
  isCanonicalRequestTarget,
  nonCanonicalRequestTargetRefusal,
  requestPath,
  lastRawPathSegment,
  routedRecordId,
  routedResourceAndRemainder,
  routedIdAfterPropertyRule,
  routedResourcePath,
} from "./request-target.js";

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
//
// The path rewrite runs ONLY when Harper routed this target to a Memory RECORD
// (`routedToMemoryRecord`): the raw path alone is not enough, because a target
// Harper resolved with no record id — e.g. `/Memory.json/<id>.content`, whose
// suffixed first segment routes to the Memory COLLECTION with an empty remainder
// — must not be turned into a by-id read of a row the target does not address.
function stripMemorySelection(rawUrl: string, routedToMemoryRecord: boolean): string {
  const q = rawUrl.indexOf("?");
  let pathPart = q === -1 ? rawUrl : rawUrl.slice(0, q);
  let query = q === -1 ? "" : rawUrl.slice(q + 1);

  // Strip a declared-attribute suffix after the first dot in the decoded remainder.
  const { remainder } = routedResourceAndRemainder(pathPart);
  const decodedId = decodeMemoryIdSegment(remainder);
  const stripped = routedIdAfterPropertyRule(decodedId, DECLARED_MEMORY_ATTRIBUTE_SET);
  // An encoded `/` in the id makes the suffix ambiguous (the caller is refused
  // upstream in the middleware), so only rewrite when there is no encoded slash
  // and the first-dot rule actually dropped a declared-attribute suffix.
  if (routedToMemoryRecord && !idSegmentHasEncodedSlash(remainder) && stripped !== decodedId) {
    pathPart = `/Memory/${encodeURIComponent(stripped)}`;
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
 * True when a Memory by-id read path names an id that carries an encoded `/`
 * (`%2F`/`%2f`) AND would otherwise be given the property-suffix rewrite in
 * stripMemorySelection. Such an id is ambiguous — the trailing
 * `.<declared attribute>` could be part of the id or a selector on an id that
 * contains a slash (flair#2199).
 */
function isAmbiguousEncodedSlashSelector(rawUrl: string): boolean {
  const { remainder } = routedResourceAndRemainder(requestPath(rawUrl));
  if (!idSegmentHasEncodedSlash(remainder)) return false;
  const decodedId = decodeMemoryIdSegment(remainder);
  return routedIdAfterPropertyRule(decodedId, DECLARED_MEMORY_ATTRIBUTE_SET) !== decodedId;
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
    const table = (databases as any).flair.Memory;
    // flair#2484: compute the vector before the owned write transaction opens.
    // The text embedded is the one Memory's own writers embed (flair#2465,
    // `skillEmbedText`: a skill-tagged row's non-empty `trigger`, else
    // `content`). Rows without that text or with an embedding longer than 100
    // entries skip before the text comparison. For eligible rows, `matchFields`
    // compares every field that selects the text (`content`, `trigger`, `tags`)
    // before staging; the helper confirms the committed row afterward. Drift
    // observed by either check aborts the attempt; remaining outer attempts
    // re-read and may recompute. Changes after confirmation and before commit
    // are not detected by these checks.
    //
    // flair#2573: the vector is stamped with the current model id, the space it
    // was computed in, and the embedding-space guard is notified after the write
    // commits with that stamp and the row it replaced, as for any other notified
    // vector write.
    for (let attempt = 1; attempt <= WRITE_BACK_ATTEMPTS; attempt++) {
      const record = await table.get(memoryId, {});
      const text = record ? skillEmbedText(record) : undefined;
      if (typeof text !== "string" || text.length === 0) return;
      if (record.embedding?.length > 100) return;
      const embedding = await getEmbedding(text, "document");
      if (!Array.isArray(embedding) || embedding.length === 0) return;
      const model = getModelId();
      // The vector fields of the committed row the update replaces, for the
      // guard notification.
      let replaced: { embedding?: unknown; embeddingModel?: unknown } | null = null;
      try {
        const outcome = await writeBackCommittedRow(
          table,
          memoryId,
          (row: any) => {
            const rowText = row ? skillEmbedText(row) : undefined;
            if (typeof rowText !== "string" || rowText.length === 0) return { skip: true };
            if (row.embedding?.length > 100) return { skip: true };
            replaced = { embedding: row.embedding, embeddingModel: row.embeddingModel };
            // Only `embedding`, its model stamp and its text hash: an incremental
            // update, never a full-row put of the row read above (flair#2470,
            // flair#2465). The newly computed hash is of `text`, the text this
            // vector was computed from (null for an empty owner).
            return { idempotent: true, update: { embedding, embeddingModel: model, embeddedContentHash: hashEmbeddedText(row.agentId, text) ?? null } };
          },
          {
            label: "backfillEmbedding",
            expectedRow: record,
            // Compare the text-selecting fields before staging, after the plan's skip checks.
            matchFields: [...MEMORY_EMBEDDING_INPUT_FIELDS, "tags"],
            pausePre: () => txnPausePoint("backfill-embedding-pre"),
            pausePoint: () => txnPausePoint("backfill-embedding"),
            pauseBeforeCommit: () => txnPausePoint("backfill-embedding-commit"),
          },
        );
        if ("update" in outcome) {
          noteWriteStamp(outcome.update.embeddingModel as string | null | undefined, replaced);
          console.log(`[auto-embed] ${memoryId}: ${(outcome.update.embedding as number[]).length}d`);
        }
        return;
      } catch (err) {
        if (err instanceof WriteBackConflictError && attempt < WRITE_BACK_ATTEMPTS) continue;
        throw err;
      }
    }
  } catch (err: any) {
    console.error(`[auto-embed] Failed for ${memoryId}: ${err.message}`);
  }
}

// ─── HTTP middleware ──────────────────────────────────────────────────────────

/**
 * Refuse a credentialed Basic-auth request whose Agent row could not be READ:
 * log the named error and return it. A read that FAILED is never an absent
 * principal (flair#2403); the same rule resources/AgentSeed.ts applies as
 * `agent_lookup_failed`.
 */
function credentialedLookupRefusal(username: string, error: unknown): Response {
  console.error(
    "auth-middleware: the credentialed principal lookup failed, so the request was refused",
    { username, error },
  );
  return new Response(JSON.stringify({
    error: AGENT_LOOKUP_FAILED,
    message: "the principal record could not be read, so the request was refused",
  }), { status: 500, headers: { "content-type": "application/json" } });
}

/**
 * A guarded mutation whose stored-owner read FAILED is refused, not allowed
 * through. The ownership read is the authorization input; a failed read is not
 * "no owner", so it must fail closed. 503 because a retry can succeed.
 */
function ownerReadFailedRefusal(table: string): Response {
  console.error(
    "auth-middleware: the stored-owner read failed, so the mutation was refused",
    { table },
  );
  return new Response(JSON.stringify({
    error: "owner_lookup_failed",
    message: "the record's owner could not be read, so the write was refused",
  }), { status: 503, headers: { "content-type": "application/json" } });
}

/**
 * A signed non-admin agent's mutation that reaches the owner checks is refused
 * when Harper's route lookup threw: the owner decisions need Harper's route, and
 * the pure fallback does not stand in for it. 503 because a retry can succeed. The message is fixed and
 * names no part of the target.
 */
function routeLookupFailedRefusal(): Response {
  console.error("auth-middleware: the route lookup failed, so the mutation was refused");
  return new Response(JSON.stringify({
    error: "route_lookup_failed",
    message: "the request could not be routed, so the write was refused",
  }), { status: 503, headers: { "content-type": "application/json" } });
}

/**
 * A signed non-admin agent's mutation that reaches the owner checks, whose target
 * Harper matched but whose record id Harper's request-target parsing or path
 * parsing could not resolve, is refused before any owner decision: those
 * decisions need the id. 400: the target cannot be parsed into a record id. The
 * message is fixed and names no part of the target.
 */
function unresolvedTargetRefusal(): Response {
  return new Response(JSON.stringify({
    error: "unresolved_request_target",
    message: "the request target could not be resolved to a record id, so the write was refused",
  }), { status: 400, headers: { "content-type": "application/json" } });
}

/**
 * The id a Memory write COMMITTED, read from the writer's own response result
 * (its `id` field) — the trustworthy source, since a by-id write can commit a
 * successor with a different id. Returns null when the result names no id as a
 * plain string body (a 204, a streamed or compressed body); the caller then
 * falls back to the routed id for a PUT or PATCH, and otherwise skips. Reads
 * only the already-serialized string body; never consumes a stream.
 */
function committedMemoryIdFromResult(response: any): string | null {
  const body = response?.body;
  if (typeof body !== "string" || body.length === 0) return null;
  try {
    const parsed = JSON.parse(body);
    const id = parsed?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

// Flair's clients use exactly these HTTP methods. Harper routes other methods
// to resource handlers as well; refusing them here, before any other branch of
// the default REST middleware, keeps the tables it serves to the methods their
// handlers are written and tested for. (Separately mounted routes such as /mcp
// and OAuth discovery have their own dispatch chains and method handling.)
const ALLOWED_HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE",
]);

// The resources the middleware makes a by-NAME decision on: the public-path
// allowance and the OAuth rate-limit policy.
const NAME_ROUTED_RESOURCES: ReadonlySet<string> = new Set([
  "health", "Health", "a2a", "A2AAdapter", "AgentCard",
  "FederationSync", "FederationPair",
  "OAuthRegister", "OAuthAuthorize", "OAuthToken", "OAuthRevoke", "OAuthMetadata",
  "Admin",
]);
const RAW_QUERY_RESOURCES: ReadonlySet<string> = new Set(["sql", "graphql"]);

server.http(async (request: any, nextLayer: any) => {
  // ── Canonical request target, FIRST ────────────────────────────────────────
  // This check reads the RAW request target, the string Harper routes. A target
  // that is not in canonical form (a `.`/`..` segment, raw or percent-encoded;
  // repeated slashes; a raw backslash) is answered with the named 400 here,
  // before any other request processing: no method check, no rate-limit budget,
  // no credential read, no next layer. See resources/request-target.ts.
  const rawTarget: string = typeof request.url === "string" ? request.url : String(request.url ?? "");
  if (!isCanonicalRequestTarget(rawTarget)) {
    return nonCanonicalRequestTargetRefusal(String(request.method ?? ""));
  }
  const targetPath = requestPath(rawTarget);

  // ── Resolve the target through Harper's OWN routing, FIRST ──────────────────
  // Synchronous and before any await (getMatch mutates its entry in place; see
  // harper-routing.ts). The helpers in request-target.ts are the fallback when
  // no route is returned: the live registry or Harper's `RequestTarget` is absent
  // (a unit test mocking `harper`), the target matches no route, or the matcher
  // throws. When the matcher throws, a signed non-admin agent's mutation that
  // reaches the owner checks is refused instead (below), before any owner
  // decision; the checks that run earlier (e.g. the rate limit and the raw-query
  // refusal) still answer first.
  let routed: HarperRoute | null = null;
  let routeLookupFailed = false;
  try {
    routed = routeWithHarper(rawTarget, request.headers);
  } catch {
    routeLookupFailed = true;
  }

  // ── HTTP method allowlist ──────────────────────────────────────────────────
  // After the canonical check and route resolution: before the public-path passthrough
  // and before any auth branch, so no path and no caller (anonymous, agent or
  // admin) can reach a handler through any other method.
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

  // The parsed URL is read for the signed payload (the client signs the
  // pathname and search of the URL it built) and for query parameters only.
  // A path decision is never made on its parsed pathname.
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
  //
  const routedDecisionPath = routed?.decisionPath ?? routedResourcePath(targetPath, NAME_ROUTED_RESOURCES);
  const limited = checkHttpRateLimit(request, routedDecisionPath);
  if (limited) return limited;

  // ── Malformed `.content` Memory path: the named 400, for every caller ────────
  // flair#2307 item 2: Harper's OWN path decode answers a 500 for invalid
  // percent-encoding, before any resource by-id guard can run. A Memory path
  // whose last segment is invalid percent-encoding AND ends in the `.content`
  // property suffix is refused here with the guard's named 400 instead. Placed
  // before every auth branch (the public-path passthrough, the Basic-admin and
  // anonymous early returns, the signed-agent path), so the refusal does not
  // depend on the request's credential, and no row is read or written for it.
  if (isMemoryReadPath(targetPath)) {
    const seg = lastRawPathSegment(targetPath);
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
  // Scheme names are case-insensitive (RFC 9110): "basic"/"BASIC"/"Basic" all
  // select the Basic branch below, exactly as "Basic" does. Used for both the
  // /FederationPair public-bypass test and the Basic branch itself.
  const isBasic = /^Basic /i.test(header);
  const isA2APath = routedDecisionPath === "/a2a" || routedDecisionPath === "/A2AAdapter" || routedDecisionPath.startsWith("/A2AAdapter/");
  if (!isTpsEd25519 && (
    routedDecisionPath === "/health" ||
    routedDecisionPath === "/Health" ||
    (request.method === "GET" && isA2APath) ||
    routedDecisionPath === "/AgentCard" ||
    routedDecisionPath.startsWith("/AgentCard/") ||
    // FederationSync uses Ed25519 body-signature auth with anti-replay, validated
    // by the resource handler (allowCreate=true, same pattern as FederationPair).
    routedDecisionPath === "/FederationSync" ||
    // FederationPair uses one-time PairingToken in the request body, validated
    // by the resource itself (allowCreate=true on the Resource lets anonymous
    // POST through Harper's role gate). Bearer can't be used here because
    // Harper's auth layer claims any "Bearer X" Authorization header for itself.
    //
    // A Basic-credentialled pair request is NOT passed through here. The Basic
    // block below is what authenticates the token's bootstrap user
    // (pair-bootstrap-<id>, Path 3) and annotates `tpsAgent`; passing straight
    // through skipped that annotation, so the resource's bootstrap-user binding
    // (PR-4, resources/Federation.ts) could never see a caller and never
    // refused a mismatch. An anonymous pair request (no Authorization header)
    // still passes through.
    (routedDecisionPath === "/FederationPair" && !isBasic) ||
    // OAuth 2.1 public endpoints (spec requires no pre-auth)
    routedDecisionPath === "/OAuthRegister" ||
    routedDecisionPath === "/OAuthAuthorize" ||
    routedDecisionPath === "/OAuthToken" ||
    routedDecisionPath === "/OAuthRevoke" ||
    // Belt-and-braces since flair#1000: `/.well-known/oauth-authorization-server`
    // is served from its OWN urlPath mount (resources/oauth-wellknown.ts), which
    // gets its own dispatch chain — this middleware never sees a request for it.
    // The entry stays so the path is still public if that mount ever moves back
    // onto the default chain.
    routedDecisionPath === "/.well-known/oauth-authorization-server" ||
    routedDecisionPath === "/OAuthMetadata"
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
    const read = await readCredentialedPrincipal(username);
    if (!read.ok) return credentialedLookupRefusal(username, read.error);
    if (!isPrincipalDeactivated(read.agent)) {
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
  if (isBasic) {
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
        const read = await readCredentialedPrincipal("admin");
        if (!read.ok) return credentialedLookupRefusal("admin", read.error);
        if (!isPrincipalDeactivated(read.agent)) {
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
        const read = await readCredentialedPrincipal(user);
        if (!read.ok) return credentialedLookupRefusal(user, read.error);
        if (!isPrincipalDeactivated(read.agent)) {
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
      if (routedDecisionPath === "/FederationPair" && user.startsWith("pair-bootstrap-")) {
        let pairUser: any = null;
        try {
          pairUser = await (server as any).getUser(user, pass, request);
        } catch { /* fall through */ }

        if (
          pairUser?.role?.role === "flair_pair_initiator" &&
          pairUser?.active === true
        ) {
          // Deactivation guard — same predicate, called before tpsAgent is stamped.
          const read = await readCredentialedPrincipal(user);
          if (!read.ok) return credentialedLookupRefusal(user, read.error);
          if (!isPrincipalDeactivated(read.agent)) {
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
    const isAdminPage = routedDecisionPath === "/Admin" || routedDecisionPath.startsWith("/Admin");
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
    const lowerPath = (routed ? routedDecisionPath : routedResourcePath(targetPath, RAW_QUERY_RESOURCES)).toLowerCase();
    if (
      lowerPath === "/sql" || lowerPath.startsWith("/sql/") ||
      lowerPath === "/graphql" || lowerPath.startsWith("/graphql/")
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

  // A signed non-admin agent's mutation that reaches this point (the earlier
  // checks, e.g. the rate limit and the raw-query refusal, answer first) is
  // refused before the owner decisions below when Harper's route lookup threw, or
  // when Harper matched the target but its request-target parsing or path parsing
  // could not resolve the record id.
  if (isMutation && !request.tpsAgentIsAdmin && routeLookupFailed) {
    return routeLookupFailedRefusal();
  }
  if (isMutation && !request.tpsAgentIsAdmin && routed?.recordIdUnresolved) {
    return unresolvedTargetRefusal();
  }

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
  // A Memory mutation whose raw id ends in the reserved `.content` suffix is a
  // request the resource layer refuses by SHAPE (flair#2199, 400
  // memory_id_content_suffix) and commits no row — Harper mutates nothing, so
  // the ownership guard below must not pre-empt that with a 403 on the base row
  // the `.content` property parse happens to name. Skip the guard for it and let
  // the resource's named 400 answer, as it did before the routed-id resolution.
  const isReservedContentMutation = isMutation &&
    (routedDecisionPath === "/Memory" || routedDecisionPath.startsWith("/Memory/")) &&
    decodeMemoryIdSegment(lastRawPathSegment(targetPath)).endsWith(MEMORY_CONTENT_SELECTOR_SUFFIX);

  if (isMutation && !request.tpsAgentIsAdmin && !isReservedContentMutation) {
    const guarded = routed
      ? resolveGuardedRecordById(routed.resource, routed.recordId)
      : resolveGuardedRecord(targetPath);
    if (guarded) {
      let record: any;
      try {
        record = await (databases as any).flair[guarded.table]?.get(guarded.id);
      } catch {
        // The ownership read is the authorization input. A read that FAILED is
        // not "no owner" and must not fall through to the resource's allow* as
        // though the check passed — fail closed with a named, retryable refusal.
        return ownerReadFailedRefusal(guarded.table);
      }
      if (isForbiddenOwnerMutation(record, guarded.ownerField, agentId)) {
        return ownerMutationRefusal(guarded.table);
      }
    }
  }

  if (isMutation) {
    // OrgEvent: authorId must match authenticated agent
    if ((routedDecisionPath === "/OrgEvent" || routedDecisionPath.startsWith("/OrgEvent/")) &&
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
    if (routedDecisionPath.startsWith("/OrgEvent/") && method === "DELETE") {
      if (!request.tpsAgentIsAdmin) {
        const eventId = routed ? routed.recordId : (routedRecordId(targetPath)?.id ?? null);
        if (eventId) {
          let record: any;
          try {
            record = await (databases as any).flair.OrgEvent.get(eventId);
          } catch {
            // A failed read is not "no author": refuse, as the shared owner rule does.
            return ownerReadFailedRefusal("OrgEvent");
          }
          if (record && record.authorId && record.authorId !== agentId) {
            return new Response(JSON.stringify({
              error: "forbidden: cannot delete events authored by another agent"
            }), { status: 403 });
          }
        }
      }
    }

    // WorkspaceState: agent-scoped mutations (non-admin can only write own records)
    if ((routedDecisionPath === "/WorkspaceState" || routedDecisionPath.startsWith("/WorkspaceState/")) &&
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
    if ((routedDecisionPath.startsWith("/WorkspaceState/")) && method === "DELETE") {
      if (!request.tpsAgentIsAdmin) {
        const wsId = routed ? routed.recordId : (routedRecordId(targetPath)?.id ?? null);
        if (wsId) {
          let record: any;
          try {
            record = await (databases as any).flair.WorkspaceState.get(wsId);
          } catch {
            // A failed read is not "no owner": refuse, as the shared owner rule does.
            return ownerReadFailedRefusal("WorkspaceState");
          }
          if (record && record.agentId && record.agentId !== agentId) {
            return new Response(JSON.stringify({
              error: "forbidden: cannot delete workspace state for another agent"
            }), { status: 403 });
          }
        }
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
    if (routedDecisionPath.startsWith("/Soul") &&
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
    if (routedDecisionPath === "/WorkspaceState" || routedDecisionPath === "/WorkspaceState/") {
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
  if (!request.tpsAgentIsAdmin && (method === "GET" || method === "HEAD") && isMemoryReadPath(routedDecisionPath)) {
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
    // The path rewrite inside stripMemorySelection runs only when Harper's own
    // routing returned a Memory route with a record id. With no route (e.g. no
    // live registry, no match, or a matcher error) or no record id, the path is
    // left as sent; the query-selection removal does not depend on this.
    const routedToMemoryRecord = routed !== null && routed.resource === "Memory" && routed.recordId !== null;
    const stripped = stripMemorySelection(request.url, routedToMemoryRecord);
    if (stripped !== request.url) request.url = stripped;
  }

  // ── Embedding backfill ─────────────────────────────────────────────────────
  const isMemoryWrite = isMutation && method !== "DELETE" &&
    (routedDecisionPath === "/Memory" || routedDecisionPath.startsWith("/Memory/"));
  const routedMemoryWrite = routed
    ? (routed.resource === "Memory" ? routed.recordId : null)
    : (() => { const r = routedRecordId(targetPath); return r?.resource === "Memory" ? r.id : null; })();
  const routedCommittedId = (method === "PUT" || method === "PATCH") ? routedMemoryWrite : null;

  const response = await nextLayer(request);

  if (isMemoryWrite && response.status >= 200 && response.status < 300) {
    const committedId = committedMemoryIdFromResult(response) ?? routedCommittedId;
    if (committedId) backfillEmbedding(committedId).catch(() => {});
  }

  return response;
}, { runFirst: true, name: FLAIR_AUTH_MIDDLEWARE_HTTP_NAME });
