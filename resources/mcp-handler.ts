/**
 * mcp-handler.ts — the Model-2 custom MCP protocol handler.
 *
 * A minimal in-process MCP (JSON-RPC 2.0) handler serving the curated flair
 * tools (resources/mcp-tools.ts's TOOLS) over Streamable HTTP. It is wrapped by `@harperfast/oauth`'s
 * `withMCPAuth` (see mcp-oauth.ts), which fails closed on any missing/invalid
 * Bearer token BEFORE this handler runs and, on success, sets
 * `request.mcp = { sub, client_id, aud, scope }` (verified RS256 JWT claims).
 *
 * ── This handler's job ──────────────────────────────────────────────────────
 *   1. Parse the JSON-RPC request (initialize / tools/list / tools/call / ping).
 *   2. For tools/call: resolve `request.mcp.sub` → a flair `Agent` id via the
 *      `Credential(kind:"idp", idpSubject=sub)` lookup, JIT-provisioning a
 *      Principal+Credential the first time IF the trust anchor allows it.
 *   3. Establish the flair scoping context and invoke the tool, which delegates
 *      to the existing resource handler (per-agent scoping enforced there).
 *
 * /mcp is its OWN dispatch chain (urlPath subroute) — flair's default
 * auth-middleware does NOT run here, so this handler is solely responsible for
 * turning the verified token into a scoped flair identity.
 *
 * ── Return shape ────────────────────────────────────────────────────────────
 * Harper HTTP listeners return `{ status, body, headers? }`. MCP messages are
 * JSON-RPC 2.0, so we serialize the JSON-RPC response object as the body.
 */

import { databases } from "harper";
import { randomBytes } from "node:crypto";
import { TOOLS, listToolDefs, type ResolvedAgent } from "./mcp-tools.js";
import { checkToolArguments, withoutNullArguments } from "./mcp-tool-arguments.js";
import { agentRecordIsAdmin } from "./agent-admin.js";
import { isPrincipalDeactivated } from "./agent-auth.js";
import { stampOriginatorOnCreate } from "./originator-instance.js";
import { invalidAgentIdMessage, isValidAgentId } from "../src/lib/agent-id-rule.js";
import { resolveVersion } from "./version.js";

// The MCP protocol revision we implement (initialize handshake).
const PROTOCOL_VERSION = "2025-06-18";

// ─── Body size cap ───────────────────────────────────────────────────────────
//
// flair#1033 — the /mcp handler reads the entire request body into memory with
// no size limit. Harper's HTTP layer imposes no cap on this path (the handler
// is registered via srv.http() which goes through Harper's own HTTP chain, not
// Fastify's 1 GB bodyLimit or the contentTypes handler's configurable 10 MB
// default). /mcp is the first surface reachable by an open population of OAuth
// clients rather than by Ed25519 agents we provisioned, so the reachability
// story is materially different from the identical pattern on any other route.
//
// 256 KB is ~100x headroom over any legitimate MCP JSON-RPC request (a
// memory_store with a large content field is a few KB; even a batch of 100
// would be well under this). It is small enough that an attacker cannot
// meaningfully consume memory through this path.
const MAX_MCP_BODY_SIZE = 256 * 1024; // 256 KB

const JSON_HEADERS = { "content-type": "application/json" };

// ─── Body size cap helpers ───────────────────────────────────────────────────

/**
 * Read the request body into a string, enforcing a hard byte cap.
 *
 * Two-phase enforcement:
 *   1. Content-Length check (reject before reading a single byte when the
 *      client declares an oversized body).
 *   2. Streaming read with a cap (catches chunked transfer encoding where
 *      Content-Length is absent, and a client that lies about its declared
 *      length).
 *
 * Handles three request shapes:
 *   - Production: Harper Request with async-iterable `request.body` (RequestBody
 *     wrapping Node IncomingMessage).
 *   - Test doubles: `request.text()` as a function (returns pre-built string),
 *     or `request.body` as a plain string.
 *
 * Throws an error with `code: "BODY_TOO_LARGE"` when the cap is exceeded, so
 * the caller can distinguish a size rejection from a parse failure.
 */
async function readBodyCapped(request: any, maxBytes: number): Promise<string> {
  // Phase 1: trust-but-verify the declared Content-Length.
  const contentLength = request?.headers?.get?.("content-length");
  if (contentLength != null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0) {
      throw Object.assign(
        new Error(`invalid Content-Length: ${contentLength}`),
        { code: "BODY_TOO_LARGE" },
      );
    }
    if (declared > maxBytes) {
      throw Object.assign(
        new Error(`request body too large: ${declared} bytes exceeds ${maxBytes}-byte limit`),
        { code: "BODY_TOO_LARGE" },
      );
    }
  }

  // Phase 2: read with a cap.
  const body = request.body;

  // Test double: body is already a plain string.
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > maxBytes) {
      throw Object.assign(
        new Error(`request body too large: exceeds ${maxBytes}-byte limit`),
        { code: "BODY_TOO_LARGE" },
      );
    }
    return body;
  }

  // Test double: request.text() is provided as a function (returns a string).
  if (typeof request.text === "function") {
    const text: string = await request.text();
    if (typeof text === "string" && Buffer.byteLength(text) > maxBytes) {
      throw Object.assign(
        new Error(`request body too large: exceeds ${maxBytes}-byte limit`),
        { code: "BODY_TOO_LARGE" },
      );
    }
    return text;
  }

  // Production: Harper Request.body is a RequestBody (async-iterable, wraps
  // Node IncomingMessage). Read chunk by chunk with a running cap.
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        throw Object.assign(
          new Error(`request body too large: exceeds ${maxBytes}-byte limit`),
          { code: "BODY_TOO_LARGE" },
        );
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  // Fallback: body is absent or an unrecognised shape.
  return String(body ?? "");
}

// ─── JSON-RPC helpers ────────────────────────────────────────────────────────

function rpcResult(id: any, result: any) {
  return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id, result }) };
}

function rpcError(id: any, code: number, message: string, httpStatus = 200) {
  return {
    status: httpStatus,
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
  };
}

// ─── sub → Agent resolution ─────────────────────────────────────────────────

/**
 * Should an unknown IdP subject be JIT-provisioned into a new Principal+
 * Credential? Gated by an explicit, auditable trust anchor — an OPEN JIT-provision
 * means anyone who can obtain a token (which requires passing the AS's own login
 * + DCR gate) auto-materializes a flair agent. That is the Sherlock req-4 boundary
 * on the resolution side: provisioning is a deliberate decision, not a default.
 *
 * `FLAIR_MCP_JIT_PROVISION` — truthy ("1"/"true"/"yes"/"on") enables it. Default
 * OFF: an unknown subject is denied (the operator must pre-provision the
 * Agent+Credential, or explicitly opt into JIT). This composes with the AS-side
 * DCR gate (initialAccessToken) — both must be deliberately opened.
 */
function jitProvisionEnabled(): boolean {
  const raw = (process.env.FLAIR_MCP_JIT_PROVISION ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Resolve the OAuth token `sub` to a flair `Agent` (Principal) id.
 *
 * Lookup: `Credential` where `kind === "idp"` AND `idpSubject === sub`. The
 * Credential's `principalId` is the Agent id. This is the SAME credential surface
 * XAA's ID-JAG path uses (resources/XAA.ts resolveOrCreatePrincipal) — one
 * identity model, keyed on the IdP subject.
 *
 * `clientId` (flair#718 authorship-provenance) is NOT part of sub resolution —
 * it rides along from the verified token's `client_id` claim (see
 * handleToolCall's stamp-site comment for why `client_id` and never
 * `client_name`) and is copied onto the resolved agent unchanged so downstream
 * write tools (memory_store/memory_update) can thread it into `claimedClient`.
 * Omitted from the returned object entirely when absent — never stamped as
 * `undefined` — so existing callers/tests that don't pass one see the exact
 * same `{ agentId, isAdmin }` shape as before this field existed.
 *
 * When a Credential maps the sub, the mapped principal must exist and be
 * active — the rule the Ed25519 path applies (resources/agent-auth.ts,
 * `isPrincipalDeactivated`) — and its record is read on every resolution, so a
 * token minted while the principal was active stops resolving once the
 * principal is deactivated. If that read fails, or the credential lookup itself
 * fails, resolution is refused. An unreadable answer is never taken as
 * "allowed", and never as "no mapping": JIT provisioning runs only for a
 * subject the credential lookup answered for. Resolution writes nothing to an
 * existing credential; the handler updates its `lastUsedAt`, best effort, after
 * a tool has run (handleToolCall).
 *
 * Returns:
 *   - `{ agentId, isAdmin, clientId? }` when a Credential maps the sub to an
 *     existing, active Agent.
 *   - null when no Credential maps the sub AND JIT-provisioning is disabled or
 *     failed → the handler denies the tool call (sub is unresolvable).
 *
 * Throws `PrincipalRefusedError` (the handler returns its JSON-RPC error) when
 * the mapped principal is deactivated or missing, or when the credential or
 * principal could not be read.
 */
export async function resolveAgentFromSub(sub: string, clientId?: string): Promise<ResolvedAgent | null> {
  return (await resolveMapping(sub, clientId))?.agent ?? null;
}

/**
 * resolveAgentFromSub's result together with the credential that mapped the
 * subject: the existing credential, or the one JIT provisioning has just
 * created without `lastUsedAt`.
 */
interface SubMapping {
  agent: ResolvedAgent;
  credential: any | null;
}

async function resolveMapping(sub: string, clientId?: string): Promise<SubMapping | null> {
  if (!sub) return null;

  // 1. Existing IdP credential → its principalId is the Agent id.
  let mapped: any = null;
  try {
    for await (const cred of (databases as any).flair.Credential.search({
      conditions: [
        { attribute: "kind", comparator: "equals", value: "idp" },
        { attribute: "idpSubject", comparator: "equals", value: sub },
      ],
    })) {
      if (cred?.principalId && cred.status !== "revoked") {
        mapped = cred;
        break;
      }
    }
  } catch {
    throw new PrincipalRefusedError(
      -32000,
      "unavailable: the credential for this token's subject could not be read, so the call was refused. " +
        "Retry; if this persists, an operator should check the flair server log.",
    );
  }

  if (mapped) {
    const principalId = String(mapped.principalId);
    const principal = await requireActivePrincipal(principalId);
    const resolved: ResolvedAgent = { agentId: principalId, isAdmin: agentRecordIsAdmin(principal) };
    if (clientId) resolved.clientId = clientId;
    return { agent: resolved, credential: mapped };
  }

  // 2. No mapping. JIT-provision only behind the explicit trust anchor.
  if (!jitProvisionEnabled()) return null;

  try {
    const { principalId, credential } = await jitProvisionPrincipal(sub);
    // A JIT-provisioned principal is a fresh, non-admin agent by construction.
    const resolved: ResolvedAgent = { agentId: principalId, isAdmin: false };
    if (clientId) resolved.clientId = clientId;
    return { agent: resolved, credential };
  } catch {
    return null;
  }
}

/**
 * JIT-provision a Principal (Agent record) + an IdP Credential from a verified
 * token subject. Mirrors XAA.resolveOrCreatePrincipal's provisioning shape (the
 * `Credential.kind:"idp"` + `idpSubject` surface) but keyed on the MCP token sub.
 * The created agent is non-admin, `kind:"agent"`, unverified trust tier.
 * Returns the principal id and the new credential, which is created without
 * `lastUsedAt`.
 */
async function jitProvisionPrincipal(sub: string): Promise<{ principalId: string; credential: any }> {
  const now = new Date().toISOString();
  const principalId = `agt_mcp_${sub.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 24)}_${randomBytes(4).toString("hex")}`;
  // flair#2359 — the shared agent-ID rule. The id above is built to conform,
  // but the rule is enforced on the value that is actually written, so a future
  // change to this construction cannot store an id AgentSeed would refuse.
  if (!isValidAgentId(principalId)) throw new Error(invalidAgentIdMessage(principalId));

  // flair#1965 r2: this is a raw Agent create (it bypasses the Agent resource's
  // post()), so stamp the local instance id here — every create path carries it.
  const principalRow: any = {
    id: principalId,
    name: principalId,
    displayName: principalId,
    kind: "agent",
    type: "agent",
    status: "active",
    // Placeholder public key — an MCP-OAuth agent authenticates via bearer token,
    // not an Ed25519 signing key. Marks provenance without forging a real key.
    publicKey: `mcp-oauth:${sub}`,
    defaultTrustTier: "unverified",
    admin: false,
    createdAt: now,
    updatedAt: now,
  };
  await stampOriginatorOnCreate(principalRow);
  await (databases as any).flair.Agent.put(principalRow);
  const credential = {
    id: `cred_mcp_${randomBytes(8).toString("hex")}`,
    principalId,
    kind: "idp",
    label: "MCP OAuth (native /mcp)",
    status: "active",
    idpProvider: "mcp-oauth",
    idpSubject: sub,
    createdAt: now,
  };
  await (databases as any).flair.Credential.put(credential);

  return { principalId, credential };
}

/**
 * A token subject whose principal may not call tools. `rpcCode` and the message
 * are the JSON-RPC error the handler returns. The message names the principal
 * when there is one, and says what an operator has to do, or that the caller
 * should retry after a failed read.
 */
export class PrincipalRefusedError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "PrincipalRefusedError";
    this.rpcCode = rpcCode;
  }
}

/**
 * Read the mapped principal for this call and require it to exist and be
 * active (`isPrincipalDeactivated`, the predicate the Ed25519 path uses: a
 * record with no `status` field counts as active).
 * Returns the principal record; throws `PrincipalRefusedError` otherwise,
 * including when the record cannot be read.
 *
 * Admin status is read from the same record, through the one shared predicate
 * (resources/agent-admin.ts, flair#941): a MCP-OAuth agent is NON-admin unless
 * an operator has set its Agent record's `role` to "admin" — the MCP surface
 * never elevates on its own. This surface is gated behind FLAIR_MCP_OAUTH and is
 * default-OFF.
 */
async function requireActivePrincipal(principalId: string): Promise<any> {
  let principal: any;
  try {
    principal = await (databases as any).flair.Agent.get(principalId);
  } catch {
    throw new PrincipalRefusedError(
      -32000,
      `unavailable: the status of principal '${principalId}' could not be read, so the call was refused. ` +
        "Retry; if this persists, an operator should check the flair server log.",
    );
  }
  if (principal == null) {
    throw new PrincipalRefusedError(
      -32001,
      `forbidden: this token's subject maps to principal '${principalId}', which does not exist. ` +
        "An operator must map the subject to an existing principal: a full `flair mcp enable` run against " +
        "this instance, with --principal <agent-id> and --idp-subject <subject>, writes that mapping in its " +
        "identity-mapping step.",
    );
  }
  if (isPrincipalDeactivated(principal)) {
    throw new PrincipalRefusedError(
      -32001,
      `forbidden: principal '${principalId}' is deactivated, so this token can no longer call tools. ` +
        "An operator must reactivate the principal (set its status to \"active\") to restore access.",
    );
  }
  return principal;
}

// ─── MCP protocol dispatch ───────────────────────────────────────────────────

/**
 * The custom /mcp handler. `withMCPAuth` guarantees `request.mcp` is present here
 * (it fails closed before us on a missing/invalid token), so we read the verified
 * `sub` directly. Handles a single JSON-RPC request per POST (the minimal
 * Streamable-HTTP shape the curated surface needs; batching is not used by the
 * MCP clients we target).
 */
export async function mcpHandler(request: any): Promise<any> {
  // MCP is a POST-only JSON-RPC surface. A GET (e.g. an SSE stream open) is not
  // part of the curated request/response tool flow — reject cleanly.
  const method = String(request?.method ?? "POST").toUpperCase();
  if (method !== "POST") {
    return rpcError(null, -32600, "method not allowed: /mcp accepts JSON-RPC POST only", 405);
  }

  // Parse the JSON-RPC body with a size cap. Harper's Request wraps a Node
  // stream — read text, but never unbounded.
  let msg: any;
  try {
    const text = await readBodyCapped(request, MAX_MCP_BODY_SIZE);
    msg = typeof text === "string" ? JSON.parse(text) : text;
  } catch (err: any) {
    if (err?.code === "BODY_TOO_LARGE") {
      return rpcError(null, -32000, err.message, 413);
    }
    return rpcError(null, -32700, "parse error: invalid JSON");
  }
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, -32600, "invalid request: expected JSON-RPC 2.0");
  }

  const { id, method: rpcMethod, params } = msg;

  switch (rpcMethod) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "flair", version: resolveVersion() },
      });

    // Notifications (no id) — acknowledge with 202-ish empty 200; MCP clients send
    // `notifications/initialized` after initialize.
    case "notifications/initialized":
      return { status: 200, headers: JSON_HEADERS, body: "" };

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: listToolDefs() });

    case "tools/call":
      return handleToolCall(request, id, params);

    default:
      return rpcError(id, -32601, `method not found: ${rpcMethod}`);
  }
}

/**
 * tools/call: resolve the token sub → flair Agent, then dispatch to the curated
 * tool. An unresolvable sub is DENIED (not silently run as anonymous or admin).
 */
async function handleToolCall(request: any, id: any, params: any): Promise<any> {
  const toolName = params?.name;
  const args = params?.arguments ?? {};

  const entry = toolName ? TOOLS[toolName] : undefined;
  if (!entry) {
    return rpcError(id, -32602, `unknown tool: ${toolName ?? "(none)"}`);
  }

  // withMCPAuth guarantees request.mcp on success. Defense-in-depth: if it's
  // somehow absent, deny (never run a tool without a verified sub).
  const sub = request?.mcp?.sub;
  if (!sub) {
    return rpcError(id, -32001, "unauthorized: no verified token subject");
  }

  // flair#718 authorship-provenance, Sherlock's binding refinement: source
  // the authorship stamp from `client_id` (the server-generated
  // `flair_cl_...` machine id — resources/OAuth.ts, an RS256-verified JWT
  // claim, not a secret) — NEVER `client_name` (a free-text label the client
  // supplied at Dynamic Client Registration time and fully controls). Do NOT
  // "helpfully" switch this to `client_name` for a prettier label; that would
  // turn a server-verified, stable id into caller-forgeable data landing in
  // stored provenance. Absent/non-string client_id → omitted, not invented.
  const clientId = typeof request?.mcp?.client_id === "string" ? request.mcp.client_id : undefined;

  // For a call that resolves through an existing credential mapping, the
  // principal's status is read here, on every such call (resolveMapping): a
  // deactivated or missing principal, or one whose status cannot be read, is
  // refused with the actionable error it carries.
  let mapping: SubMapping | null;
  try {
    mapping = await resolveMapping(String(sub), clientId);
  } catch (err) {
    if (err instanceof PrincipalRefusedError) return rpcError(id, err.rpcCode, err.message);
    return rpcError(
      id,
      -32000,
      "unavailable: the token subject could not be resolved to a principal, so the call was refused. " +
        "Retry; if this persists, an operator should check the flair server log.",
    );
  }
  if (!mapping) {
    // Sub verified by the AS but not mapped to a flair Agent (and JIT disabled /
    // failed). Deny — do NOT fall back to anonymous or admin.
    return rpcError(id, -32001, "forbidden: token subject is not a provisioned flair agent");
  }
  const agent = mapping.agent;

  // The tool implementations are written for their declared argument types;
  // a value of another type is refused before the tool runs, and a null
  // optional argument is treated as absent rather than forwarded.
  const argError = checkToolArguments(entry.def.inputSchema, params?.arguments);
  if (argError) return rpcError(id, -32602, `invalid arguments for ${toolName}: ${argError}`);
  const toolArgs = withoutNullArguments(args);

  let result: any;
  try {
    result = await entry.impl(agent, toolArgs);
  } catch (err: any) {
    return rpcError(id, -32000, `tool execution failed: ${err?.message ?? String(err)}`);
  }
  // The tool has run and returned (a tool-level error result included): only
  // now is the mapping credential, a JIT-provisioned one included, marked used.
  // A refused call, rejected arguments, or a tool that throws leave `lastUsedAt`
  // as it was. Best effort: a failed write is ignored and does not change the
  // answer.
  await touchLastUsed(mapping.credential);

  // MCP tools/call result: content blocks. Surface the handler's JSON payload
  // as a text block (structuredContent carries the raw object for programmatic
  // clients). A handler-level error object (from unwrap of a Response) is
  // reported as an MCP tool error (isError) rather than a JSON-RPC error, so
  // the client sees the structured message.
  const text = typeof result === "string" ? result : JSON.stringify(result);
  const isError = !!(result && typeof result === "object" && "error" in result && "status" in result);
  return rpcResult(id, {
    content: [{ type: "text", text }],
    structuredContent: typeof result === "object" ? result : { value: result },
    isError,
  });
}

/**
 * Mark the mapping credential used, once a tool has run (best-effort). The
 * update writes `lastUsedAt` alone, as a field-level patch from an internal
 * context (no request, no user), and is skipped when a read just before it
 * finds no stored credential row.
 */
async function touchLastUsed(credential: any | null): Promise<void> {
  const credentialId = credential?.id;
  if (credentialId == null) return;
  try {
    const Credential = (databases as any).flair.Credential;
    if ((await Credential.get(credentialId, {})) == null) return;
    await Credential.patch(credentialId, { lastUsedAt: new Date().toISOString() }, {});
  } catch { /* non-fatal: a failure here does not change the call's answer */ }
}
