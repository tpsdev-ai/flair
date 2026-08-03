/**
 * flair-agent-auth — Ed25519 agent authentication.
 *
 * The verification logic that used to live in the instance-wide `server.http`
 * auth-middleware, extracted into a per-resource helper. Resources call
 * `verifyAgentRequest()` from their `allow*()` methods to identify + authorize
 * the calling agent. This keeps flair's auth PER-RESOURCE (Harper-native) so it
 * composes on a multi-component hub instead of a global gate that 401s siblings.
 *
 * Plugin-shaped on purpose (config via env today, extractable to a standalone
 * @tps/agent-auth Harper plugin later — the "agent auth as its own plugin" path).
 *
 * Auth model: an agent presents `Authorization: TPS-Ed25519 <id>:<ts>:<nonce>:<sig>`.
 * The signature covers `<id>:<ts>:<nonce>:<METHOD>:<pathname><search>` and is
 * verified against the agent's stored Ed25519 public key. Replay is bounded by a
 * 30s timestamp window + a per-(agent,nonce) seen-set pruned to that window.
 */
import { databases } from "harper";
import { WINDOW_MS, isNonceReplay, recordNonce, importEd25519Key, b64ToArrayBuffer, parseTpsEd25519Header } from "./ed25519-auth.js";
import { ADMIN_ROLE, agentRecordIsAdmin } from "./agent-admin.js";

/**
 * Shared Harper user that verified Ed25519 agents resolve to (least-privilege
 * `flair_agent` role), replacing the old admin super_user elevation. Single
 * source of truth — the auth gate resolves agents to this user and the CLI
 * provisions it (ensureFlairAgentUser); they MUST agree on the name.
 */
export const FLAIR_AGENT_USERNAME = "flair-agent";

// ─── Principal deactivation guard (authz hardening slice 1) ─────────────────
//
// ONE predicate, called from BOTH verify paths (Ed25519 in doVerify + the
// gate's own verify, and Basic/agent-auth in resolveAgentAuth) so the
// deactivation check cannot drift between them.  Two independent checks would
// inevitably diverge — one path tightened, the other forgotten — and this is
// exactly the kind of control that must not.
//
// KNOWN LIMIT (slice 1b, NOT this slice): Harper's Bearer validation never
// calls Agent.get(principalId), so already-issued Bearer tokens SURVIVE
// deactivation.  This slice buys "deactivation stops new authentications" and
// nothing more.  Existing tokens live until expiry or explicit revocation.
// Do not read this as "deactivation now works" — it works for NEW auth only.

/**
 * Single shared predicate: is this principal deactivated?
 *
 * Called from BOTH verify paths (Ed25519 and Basic/agent-auth) so the
 * deactivation check cannot drift.  A nonexistent agent is not "deactivated" —
 * it will fail on other checks (missing publicKey, unknown user, etc.).
 */
export function isPrincipalDeactivated(agent: { status?: string } | null | undefined): boolean {
  return agent?.status === "deactivated";
}

// ─── Crypto + replay-guard helpers ────────────────────────────────────────────
// WINDOW_MS, isNonceReplay/recordNonce (the ONE shared nonce store), and
// importEd25519Key all live in ./ed25519-auth.ts — the single
// shared implementation imported by auth-middleware.ts, agent-auth.ts, and
// Presence.ts so a nonce recorded via any one of the three call sites is
// visible to the other two, and the crypto/decoder logic can't drift.

// ─── Admin resolution ─────────────────────────────────────────────────────────
// Admin agents come from FLAIR_ADMIN_AGENTS (comma-separated) OR Agent records
// whose `role` is the admin sentinel. OR-combined, cached 60s. Distinct from
// Harper's super_user — admin here gates flair-policy decisions (promotions,
// raw ops).
//
// The record half of that union is the ONE place the Agent table is consulted
// for an authorization decision, and it resolves through
// resources/agent-admin.ts's shared predicate so it cannot drift from the
// reporters or from the MCP surface (flair#941 — they had drifted).

let adminCacheExpiry = 0;
let adminCache: Set<string> = new Set();

async function getAdminAgents(): Promise<Set<string>> {
  const now = Date.now();
  if (now < adminCacheExpiry) return adminCache;
  const fromEnv = (process.env.FLAIR_ADMIN_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const fromDb: string[] = [];
  try {
    const results = await (databases as any).flair.Agent.search([{ attribute: "role", value: ADMIN_ROLE, condition: "equals" }]);
    for await (const row of results) if (row?.id && agentRecordIsAdmin(row)) fromDb.push(row.id);
  } catch { /* Agent table may be empty */ }
  adminCache = new Set([...fromEnv, ...fromDb]);
  adminCacheExpiry = now + 60_000;
  return adminCache;
}

/**
 * Drop the memoised admin set so the NEXT isAdmin() re-reads the Agent table.
 *
 * The 60s TTL is a load optimisation, but on its own it makes a privilege
 * change take up to a minute to appear — which reads as "the change didn't
 * work", and is exactly the confusion flair#941 is about: an operator grants
 * admin, tests it, sees a denial, and starts changing other things. The write
 * path knows precisely when a principal's admin status changed, so it says so
 * and the grant is effective on the caller's very next request.
 *
 * Deliberately NOT a distributed invalidation: Harper runs N worker threads,
 * each with its own module instance and its own cache, so a promotion applied
 * on thread A still takes up to the TTL to be seen by thread B. Making that
 * exact would mean a shared invalidation channel, which is a much larger change
 * than the confusion warrants — the bound stays 60s, unchanged, and the common
 * single-threaded/dev case becomes immediate. Called by resources/Agent.ts's
 * write paths.
 */
export function invalidateAdminCache(): void {
  adminCacheExpiry = 0;
  adminCache = new Set();
}

export async function isAdmin(agentId: string): Promise<boolean> {
  return (await getAdminAgents()).has(agentId);
}

// ─── Agent request verification ───────────────────────────────────────────────

export interface AgentAuth {
  agentId: string;
  isAdmin: boolean;
}

async function doVerify(request: any): Promise<AgentAuth | null> {
  const header: string =
    request?.headers?.get?.("authorization") ??
    request?.headers?.asObject?.authorization ??
    "";
  const parsed = parseTpsEd25519Header(header);
  if (!parsed) return null;

  const { agentId, tsRaw, nonce, signatureB64 } = parsed;
  const ts = Number(tsRaw);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS) return null;

  // Reject replays within the window (isNonceReplay prunes expired entries first).
  if (isNonceReplay(agentId, nonce, now)) return null;

  const agent = await (databases as any).flair.Agent.get(agentId).catch(() => null);
  if (!agent?.publicKey) return null;

  // Deactivation guard — ONE predicate, same check as the Basic/agent-auth path
  // in resolveAgentAuth below.  A deactivated principal cannot authenticate.
  if (isPrincipalDeactivated(agent)) return null;

  // Canonical signed payload: id:ts:nonce:METHOD:pathname+search (must match the
  // TPS CLI signer exactly — changing this breaks every agent's auth).
  const url = new URL(request.url, "http://localhost");
  const payload = `${agentId}:${tsRaw}:${nonce}:${request.method}:${url.pathname}${url.search}`;
  try {
    const key = await importEd25519Key(String(agent.publicKey));
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" } as any,
      key,
      b64ToArrayBuffer(signatureB64),
      new TextEncoder().encode(payload),
    );
    if (!ok) return null;
  } catch {
    return null;
  }

  recordNonce(agentId, nonce, ts);
  return { agentId, isAdmin: await isAdmin(agentId) };
}

/**
 * Verify a TPS-Ed25519 signed request → the authenticated agent, or null.
 *
 * MEMOIZED per request object: `allow*` may run several times for one request,
 * and re-running doVerify would (a) waste a crypto verify and (b) double-consume
 * the nonce (the 2nd call would see a replay and fail). We verify once and cache
 * the result (including null) on the request.
 */
export async function verifyAgentRequest(request: any): Promise<AgentAuth | null> {
  if (!request) return null;
  if (request._flairAgentAuth !== undefined) return request._flairAgentAuth;
  const result = await doVerify(request);
  try { request._flairAgentAuth = result; } catch { /* frozen request — fine, just no cache */ }
  return result;
}

// ─── Resource auth verdict ──────────────────────────────────────────────────

export type AgentAuthVerdict =
  | { kind: "internal" }                                  // no HTTP request → trusted in-process call
  | { kind: "agent"; agentId: string; isAdmin: boolean }  // valid TPS-Ed25519 signature
  | { kind: "anonymous" };                                // request present, no valid agent → DENY

/**
 * Three-way auth verdict for a resource — the safe replacement for the old
 * `if (!authAgent) → unfiltered/trusted` pattern that leaked to anonymous callers
 * once the gate stopped rejecting them. Distinguishes:
 *   - **internal**: no HTTP request at all → a programmatic/in-process call
 *     (maintenance, consolidation). Trusted; callers may run unfiltered.
 *   - **agent**: a verified agent (Ed25519). Carries agentId + isAdmin.
 *   - **anonymous**: an HTTP request with NO valid agent → MUST be denied.
 *
 * Pass the RESOURCE CONTEXT (`getContext()`), not `getContext().request`:
 * `getContext().request` is inconsistently populated across resource methods
 * (present for search/GET, undefined for PUT/POST in Table resources), so we read
 * the gate's annotations off `context.request ?? context` — exactly how the
 * pre-reshape resources read `request.tpsAgent`. Resolution order:
 *   1. explicit anonymous marker (`tpsAnonymous`, set by the non-rejecting gate)
 *   2. gate's verified-agent annotation (`tpsAgent` / `tpsAgentIsAdmin`)
 *   3. per-agent identity on `context.user` (the de-elevated user; username=agentId)
 *   4. header verify (custom-resource allow*, where the raw request is present)
 *      — and if a request object IS present but yields no agent → anonymous
 *   5. nothing at all → trusted internal call
 */
/**
 * Header names that can carry a CLIENT-PRESENTED credential. Today only the
 * standard `authorization` header — it carries Basic, Bearer, AND our custom
 * `TPS-Ed25519 …` scheme (all three ride the Authorization header; see
 * doVerify() above and auth-middleware.ts, both of which read exactly this
 * header to authenticate a caller). Kept as a LIST, read via every header-object
 * shape below, so a future signed-header auth scheme is a one-line addition here
 * — not a scatter of ad-hoc `req.headers.authorization` truthiness checks that
 * would each have to be rediscovered and updated (Kern's review point).
 *
 * DELIBERATELY EXCLUDES the server-set trust markers `x-tps-agent` /
 * `x-tps-anonymous`: auth-middleware.ts STAMPS those AFTER it has verified a
 * caller — they are never presented by the client. Counting them as "credential
 * evidence" would let an unauthenticated caller forge one and defeat this gate.
 */
const CREDENTIAL_HEADERS = ["authorization"] as const;

/**
 * Read a header off either header-object shape Harper hands us: the Web
 * Headers-like `.get(name)` (populated for GET/search requests) or the plain
 * `.asObject` bag (PUT/POST). Mirrors doVerify()'s own read exactly, so the
 * evidence check can't miss a shape the verifier would have seen.
 */
function readRequestHeader(reqLike: any, name: string): string {
  return (
    reqLike?.headers?.get?.(name) ??
    reqLike?.headers?.asObject?.[name] ??
    ""
  );
}

/**
 * True iff the request carries ANY client-presented credential (CREDENTIAL_HEADERS).
 *
 * WHY THIS EXISTS (flair#610): Harper's `authorizeLocal: true` forges
 * `request.user = super_user` (and can populate `.username`) for a credential-
 * LESS loopback request — one with NO Authorization header at all. A genuine
 * Basic/Bearer/TPS-Ed25519 header SUPPRESSES that forgery. So "is a credential
 * present?" is precisely what separates a genuinely-authenticated caller from
 * Harper's ambient forgery — the gate resolveAgentAuth applies before trusting a
 * `context.user` identity. Handles BOTH context shapes (`getContext().request`
 * for GET/search, context-only for PUT/POST) by resolving `request ?? self`
 * first, then reads both header-object shapes.
 */
export function hasCredentialEvidence(context: any): boolean {
  const reqLike = context?.request ?? context;
  if (!reqLike) return false;
  return CREDENTIAL_HEADERS.some((h) => readRequestHeader(reqLike, h) !== "");
}

/**
 * allow* for AGENT-FACING resources: permit verified agents, admins/super_user,
 * and trusted internal calls; deny anonymous HTTP. Pass getContext(). Per-record
 * scoping/ownership is still enforced in the handler. Replaces the
 * `!!verifyAgentRequest(request)` pattern, which wrongly denied Basic-admin/
 * super_user (no TPS header) — breaking the CLI/consolidation path.
 */
export async function allowVerified(context: any): Promise<boolean> {
  return (await resolveAgentAuth(context)).kind !== "anonymous";
}

/**
 * allow* for ADMIN-ONLY resources: permit admin agents + super_user + trusted
 * internal calls; deny non-admin agents and anonymous.
 */
export async function allowAdmin(context: any): Promise<boolean> {
  const a = await resolveAgentAuth(context);
  return a.kind === "internal" || (a.kind === "agent" && a.isAdmin);
}

/**
 * flair#936 — the `internal` verdict is TRUSTED and UNFILTERED, and it is also
 * what a caller gets for supplying no context at all. Nothing distinguishes
 * "I am flair's own maintenance code" from "I am an application developer who
 * did not know a context was required": both spell it `new Memory()`, both
 * succeed, and both return plausible data. It surfaces months later as memories
 * that were never scoped.
 *
 * This does not change the verdict — every authorization outcome is byte-
 * identical — it ends the SILENCE. A deliberate elevated call says so with
 * `internalContext()` (resources/in-process.ts), whose `__flairInternal` marker
 * is read here and nowhere else; anything else that lands on `internal` gets one
 * warning per process, with the stack, so the condition is observable where it
 * was previously invisible.
 *
 * MEASURED, and the reason this is worth having: flair itself has NO in-process
 * caller that relies on the omission — every maintenance, migration, federation
 * and boot path goes through the raw `databases.flair.*` table accessor, which
 * bypasses this resolver entirely rather than defaulting through it. So a
 * warning from this line is, in practice, always either an embedding
 * application that forgot a context or a flair call site that should be naming
 * its intent. Neither is noise.
 *
 * The marker is read off `context`, NOT off `c`: `c` is rebound to
 * `context.request` on the line below, and internalContext() carries the marker
 * on the outer object.
 */
let warnedInternalByOmission = false;

/**
 * Was this elevated call DELIBERATE — i.e. did the caller name the authority
 * with `internalContext()` rather than land on it by leaving a context off?
 *
 * Exported because it is the whole decision, and a decision worth testing is
 * worth testing directly: the warning itself is latched once per process, which
 * makes any test of the side effect order-dependent (bun shares one module
 * registry across the whole run, so whichever file resolves a context-less call
 * first consumes the latch and every later assertion silently passes). Pinning
 * the predicate instead is deterministic.
 *
 * Grants nothing and is never consulted for an authorization decision — the
 * verdict is identical either way.
 */
export function isDeliberateInternalCall(context: any): boolean {
  return context?.__flairInternal === true;
}

/** The advisory text, exported so its content is pinned without tripping the latch. */
export const INTERNAL_BY_OMISSION_WARNING =
  "[flair-auth] a resource was invoked with NO caller context and resolved to the trusted " +
  "`internal` verdict: reads are UNFILTERED across every agent, writes are unattributed, and " +
  "the admin-only gate passes. If this is your application's code, pass agentContext(<id>) from " +
  "@tpsdev-ai/flair's in-process seam so the call is scoped and attributed. If the elevated " +
  "authority is genuinely intended, say so with internalContext() and this warning will stop. " +
  "Fires once per process.";

function noteInternalVerdict(context: any): void {
  if (warnedInternalByOmission) return;
  if (isDeliberateInternalCall(context)) return; // deliberate, and said so
  warnedInternalByOmission = true;
  const stack = (new Error().stack ?? "").split("\n").slice(2, 7).join("\n");
  console.error(INTERNAL_BY_OMISSION_WARNING + "\n" + stack);
}

export async function resolveAgentAuth(context: any): Promise<AgentAuthVerdict> {
  const c = context?.request ?? context;
  if (!c) {
    noteInternalVerdict(context);
    return { kind: "internal" };
  }

  if (c.tpsAnonymous === true) return { kind: "anonymous" };

  if (c.tpsAgent) {
    return { kind: "agent", agentId: String(c.tpsAgent), isAdmin: c.tpsAgentIsAdmin === true };
  }

  // flair#610 — CREDENTIAL-EVIDENCE GATE. Harper's `authorizeLocal: true` forges
  // `context.user = super_user` (and can populate `.username`) for a credential-
  // LESS loopback request. Trusting that ambient identity was the forgery
  // vector: a bare local caller resolved to admin with no signature and no
  // password. Only trust a `context.user` identity when the request actually
  // carries a credential (real Basic/Bearer/TPS-Ed25519 header) — the one thing
  // authorizeLocal's forgery cannot manufacture. Without evidence, FALL THROUGH
  // to the verifyAgentRequest fallback below: a genuine signed request still
  // authenticates; a credential-less HTTP request lands on `anonymous` (it has a
  // headers object but no valid agent), and a true in-process call with no
  // request object at all lands on `internal`.
  const credentialed = hasCredentialEvidence(c);
  const user = context?.user ?? c.user;
  if (credentialed && user?.role?.permission?.super_user === true) {
    const agentId = String(user.username ?? "admin");
    const agent = await (databases as any).flair.Agent.get(agentId).catch(() => null);
    if (isPrincipalDeactivated(agent)) return { kind: "anonymous" };
    return { kind: "agent", agentId, isAdmin: true };
  }
  if (credentialed && user?.username && user.username !== FLAIR_AGENT_USERNAME) {
    const agentId = String(user.username);
    const agent = await (databases as any).flair.Agent.get(agentId).catch(() => null);
    if (isPrincipalDeactivated(agent)) return { kind: "anonymous" };
    return { kind: "agent", agentId, isAdmin: false };
  }

  // A raw request with headers is present → verify it; an HTTP request that
  // yields no agent is anonymous (NOT internal).
  if (c.headers?.get || c.headers?.asObject) {
    const auth = await verifyAgentRequest(c);
    if (auth) return { kind: "agent", agentId: auth.agentId, isAdmin: auth.isAdmin };
    return { kind: "anonymous" };
  }

  noteInternalVerdict(context);
  return { kind: "internal" };
}
