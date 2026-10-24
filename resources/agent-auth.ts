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
 * 30s timestamp window + an instance-wide record of each (agent, nonce)
 * (resources/replay-store.ts).
 */
import { databases } from "harper";
import { WINDOW_MS, importEd25519Key, b64ToArrayBuffer, parseTpsEd25519Header } from "./ed25519-auth.js";
import { isKnownAgentReplay, claimAgentNonce } from "./replay-store.js";
import { agentRecordIsAdmin, configuredAdminAgentIds } from "./agent-admin.js";
import { isPrincipalDeactivated } from "../src/lib/principal-status.js";
import { isProtocolLayerContext } from "./protocol-context.js";
import { isDeliberateInternalVerdict } from "./internal-authority.js";

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
 * Single shared predicate: re-exported from src/lib/principal-status.ts, which
 * holds the rule. Called from BOTH verify paths (Ed25519 and Basic/agent-auth)
 * and the human-readable `principal show`/`list` output (flair#2378).
 */
export { isPrincipalDeactivated };

/** Named refusal when a credentialed Basic-auth path cannot READ the Agent row. */
export const AGENT_LOOKUP_FAILED = "agent_lookup_failed";

/**
 * Read the Agent row for a credentialed Basic-auth caller, distinguishing a read
 * that SUCCEEDED and found no such row (`{ ok: true, agent: null }`) from a read
 * that FAILED (`{ ok: false }`). A failed read is never an absent principal: the
 * caller refuses with a named error rather than admitting a caller it could not
 * check. The same rule resources/AgentSeed.ts and resources/originator-instance.ts
 * apply to their own reads.
 */
export async function readCredentialedPrincipal(
  agentId: string,
): Promise<{ ok: true; agent: any | null } | { ok: false; error: unknown }> {
  try {
    return { ok: true, agent: (await (databases as any).flair.Agent.get(agentId)) ?? null };
  } catch (error) {
    return { ok: false, error };
  }
}

// ─── Crypto + replay-guard helpers ────────────────────────────────────────────
// WINDOW_MS and importEd25519Key live in ./ed25519-auth.ts, and the replay
// guard (isKnownAgentReplay / claimAgentNonce) in ./replay-store.ts — shared by
// auth-middleware.ts, agent-auth.ts and Presence.ts, so a nonce recorded via
// any one of the three call sites, on any worker thread, is refused by all of
// them, and the crypto/decoder logic can't drift.

// ─── Admin resolution ─────────────────────────────────────────────────────────
// An agent is a flair administrator when its id is named in FLAIR_ADMIN_AGENTS
// (comma-separated) or its stored Agent row's `role` is the admin sentinel.
// Distinct from Harper's super_user — admin here gates flair-policy decisions
// (promotions, raw ops).
//
// The decision is taken from an Agent ROW, never from a remembered set of ids.
// The Ed25519 verifiers (doVerify below and resources/auth-middleware.ts) pass
// the row they have just checked the request's signature against, so the key
// check and the admin decision describe the same stored record, on every
// request and on every worker thread. Nothing about admin status is kept
// between requests, so a change to the Agent table (a role change, a removed
// row, a new row under the same id) applies to the next request.
//
// The record half resolves through resources/agent-admin.ts's shared predicate
// so it cannot drift from the reporters or from the MCP surface (flair#941).

/**
 * THE admin decision for an agent: its id is in the configured
 * FLAIR_ADMIN_AGENTS set, or `row` (that agent's stored Agent row) carries the
 * admin role. Pure: it reads no table. A verifier passes the row it checked the
 * request's key against; a null or absent row leaves only the configured ids.
 */
export function agentIsAdmin(agentId: string, row: unknown): boolean {
  return configuredAdminAgentIds().has(agentId) || agentRecordIsAdmin(row);
}

/**
 * The admin decision for an agent id when no row is in hand: reads the agent's
 * Agent row now and applies {@link agentIsAdmin}. Nothing is kept between
 * calls. A read that fails counts as no row, so only the configured ids can
 * then admit.
 */
export async function isAdmin(agentId: string): Promise<boolean> {
  let row: unknown = null;
  try {
    row = await (databases as any).flair.Agent.get(agentId);
  } catch {
    row = null;
  }
  return agentIsAdmin(agentId, row);
}

/**
 * The admin decision for a handler that identifies its caller by the request's
 * `tpsAgent` annotation.
 *
 *   - A request the Ed25519 gate verified carries `tpsAgentAdminFromVerifiedRow`
 *     (resources/auth-middleware.ts). Its `tpsAgentIsAdmin` is the decision the
 *     gate took from the Agent row it verified the signature against, and that
 *     decision is returned unchanged: no second read.
 *   - Any other annotated caller (a Basic credential the gate annotated, an
 *     in-process agentContext()/adminContext(), an MCP tool context built from
 *     them) is decided by {@link isAdmin}: its Agent row read now, plus the
 *     configured ids. Its `tpsAgentIsAdmin` is not consulted here.
 *   - A request with no `tpsAgent` is not an admin here.
 *
 * All three are properties of the request object, never headers. On an HTTP
 * request the gate sets `tpsAgent` and `tpsAgentIsAdmin`, and only its Ed25519
 * branch sets `tpsAgentAdminFromVerifiedRow`. An in-process caller builds its
 * own context with `tpsAgent` and `tpsAgentIsAdmin` (resources/in-process.ts),
 * without the marker.
 */
export async function annotatedCallerIsAdmin(request: any): Promise<boolean> {
  const agentId = request?.tpsAgent;
  if (!agentId) return false;
  if (request.tpsAgentAdminFromVerifiedRow === true) return request.tpsAgentIsAdmin === true;
  return isAdmin(String(agentId));
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

  // A nonce this thread already saw recorded is refused before any lookup. A
  // miss here proves nothing: claimAgentNonce below is the authoritative check.
  if (isKnownAgentReplay(agentId, nonce, now)) return null;

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

  // Record the nonce instance-wide now that the signature has verified, and
  // before the request has any effect. A replay or an unusable store refuses.
  if (!(await claimAgentNonce(agentId, nonce)).ok) return null;
  // The admin decision uses the row the signature was just verified against.
  return { agentId, isAdmin: agentIsAdmin(agentId, agent) };
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
  | { kind: "anonymous"; error?: string };                // request present, no valid agent → DENY
                                                          // (`error` names a refused unreadable lookup)

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
 * allow* for ADMIN-ONLY resources: permit admin agents + super_user + a
 * DELIBERATE internal call (flair#2837); deny non-admin agents and anonymous.
 *
 * An `internal` verdict reached by OMITTING the context does not pass this
 * gate — the Soul/AgentSeed gate's rule, from
 * resources/internal-authority.ts. The verdict itself is unchanged; only this
 * gate's decision is.
 */
export async function allowAdmin(context: any): Promise<boolean> {
  const a = await resolveAgentAuth(context);
  if (a.kind === "internal") return isDeliberateInternalVerdict(context, a);
  return a.kind === "agent" && a.isAdmin;
}

/**
 * flair#936 — the `internal` verdict is TRUSTED and UNFILTERED, and it is also
 * what a caller gets for supplying no context at all. Nothing distinguishes
 * "I am flair's own maintenance code" from "I am an application developer who
 * did not know a context was required": both spell it `new Memory()`, both
 * succeed, and both return plausible data. It surfaces months later as memories
 * that were never scoped.
 *
 * This does not change the verdict; it ends the SILENCE. A deliberate elevated
 * call says so with `internalContext()` (resources/in-process.ts), whose
 * `__flairInternal` marker is read here; anything else that lands on `internal`
 * gets one warning per process, with the stack, so the condition is observable
 * where it was previously invisible.
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
 * This function feeds the warning, and the verdict is identical either way.
 * The marker it reads also decides the admin-only gate: `allowAdmin` admits
 * the `internal` verdict only for a call that carries it and no request
 * headers (isDeliberateInternalVerdict in resources/internal-authority.ts,
 * shared with the Soul and skill write-source rules).
 */
export function isDeliberateInternalCall(context: any): boolean {
  return context?.__flairInternal === true;
}

/** The advisory text, exported so its content is pinned without tripping the latch. */
export const INTERNAL_BY_OMISSION_WARNING =
  "[flair-auth] a resource was invoked with NO caller context and resolved to the trusted " +
  "`internal` verdict: reads are UNFILTERED across every agent, writes are unattributed, and " +
  "the admin-only gate (allowAdmin) refuses it. If this is your application's code, pass agentContext(<id>) from " +
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

/**
 * Refuse a credentialed Basic-auth caller whose Agent row could not be read:
 * log the named error and return the deny verdict. A read that FAILED is never
 * an absent principal and never admits (flair#2403).
 */
function refuseUnreadablePrincipal(agentId: string, error: unknown): AgentAuthVerdict {
  console.error(
    "agent-auth: the credentialed principal lookup failed, so the request was refused",
    { agentId, error },
  );
  return { kind: "anonymous", error: AGENT_LOOKUP_FAILED };
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
    const read = await readCredentialedPrincipal(agentId);
    if (!read.ok) return refuseUnreadablePrincipal(agentId, read.error);
    if (isPrincipalDeactivated(read.agent)) return { kind: "anonymous" };
    return { kind: "agent", agentId, isAdmin: true };
  }
  if (credentialed && user?.username && user.username !== FLAIR_AGENT_USERNAME) {
    const agentId = String(user.username);
    const read = await readCredentialedPrincipal(agentId);
    if (!read.ok) return refuseUnreadablePrincipal(agentId, read.error);
    if (isPrincipalDeactivated(read.agent)) return { kind: "anonymous" };
    return { kind: "agent", agentId, isAdmin: false };
  }

  // A raw request with headers is present → verify it; an HTTP request that
  // yields no agent is anonymous (NOT internal).
  if (c.headers?.get || c.headers?.asObject) {
    const auth = await verifyAgentRequest(c);
    if (auth) return { kind: "agent", agentId: auth.agentId, isAdmin: auth.isAdmin };
    return { kind: "anonymous" };
  }

  // A context a protocol layer built (an MQTT session's action — on Harper's
  // TCP or TLS listener it carries no HTTP request — one still carrying
  // Harper's `authorize: true`, or a requestless one carrying Harper's
  // `checkPermission` marker, as Harper's native MCP application tools build)
  // is a remote caller with no credential flair can verify: anonymous, never
  // internal (resources/protocol-context.ts). flair has no verified bridge from
  // the Harper user of a native MCP call to a flair caller, so that caller is
  // anonymous too, in the resource's authorization hooks and in its handlers.
  if (isProtocolLayerContext(context)) return { kind: "anonymous" };

  noteInternalVerdict(context);
  return { kind: "internal" };
}
