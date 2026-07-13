/**
 * mcp-handler.ts — the Model-2 custom MCP protocol handler.
 *
 * A minimal in-process MCP (JSON-RPC 2.0) handler serving the 12 curated flair
 * tools over Streamable HTTP. It is wrapped by `@harperfast/oauth`'s
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

import { databases } from "@harperfast/harper";
import { randomBytes } from "node:crypto";
import { TOOLS, listToolDefs, type ResolvedAgent } from "./mcp-tools.js";

// The MCP protocol revision we implement (initialize handshake).
const PROTOCOL_VERSION = "2025-06-18";

const JSON_HEADERS = { "content-type": "application/json" };

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
 * Returns:
 *   - `{ agentId, isAdmin }` when a Credential maps the sub to an Agent.
 *   - null when no Credential maps the sub AND JIT-provisioning is disabled or
 *     failed → the handler denies the tool call (sub is unresolvable).
 */
export async function resolveAgentFromSub(sub: string): Promise<ResolvedAgent | null> {
  if (!sub) return null;

  // 1. Existing IdP credential → its principalId is the Agent id.
  try {
    for await (const cred of (databases as any).flair.Credential.search({
      conditions: [
        { attribute: "kind", comparator: "equals", value: "idp" },
        { attribute: "idpSubject", comparator: "equals", value: sub },
      ],
    })) {
      if (cred?.principalId && cred.status !== "revoked") {
        // Touch lastUsedAt (best-effort; a failure here must not deny a valid call).
        try {
          await (databases as any).flair.Credential.put({ ...cred, lastUsedAt: new Date().toISOString() });
        } catch { /* non-fatal */ }
        return { agentId: String(cred.principalId), isAdmin: await isAgentAdmin(cred.principalId) };
      }
    }
  } catch { /* Credential table empty / search error → fall through to JIT/deny */ }

  // 2. No mapping. JIT-provision only behind the explicit trust anchor.
  if (!jitProvisionEnabled()) return null;

  try {
    const principalId = await jitProvisionPrincipal(sub);
    // A JIT-provisioned principal is a fresh, non-admin agent by construction.
    return { agentId: principalId, isAdmin: false };
  } catch {
    return null;
  }
}

/**
 * JIT-provision a Principal (Agent record) + an IdP Credential from a verified
 * token subject. Mirrors XAA.resolveOrCreatePrincipal's provisioning shape (the
 * `Credential.kind:"idp"` + `idpSubject` surface) but keyed on the MCP token sub.
 * The created agent is non-admin, `kind:"agent"`, unverified trust tier.
 */
async function jitProvisionPrincipal(sub: string): Promise<string> {
  const now = new Date().toISOString();
  const principalId = `agt_mcp_${sub.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 24)}_${randomBytes(4).toString("hex")}`;

  await (databases as any).flair.Agent.put({
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
  });

  await (databases as any).flair.Credential.put({
    id: `cred_mcp_${randomBytes(8).toString("hex")}`,
    principalId,
    kind: "idp",
    label: "MCP OAuth (native /mcp)",
    status: "active",
    idpProvider: "mcp-oauth",
    idpSubject: sub,
    createdAt: now,
    lastUsedAt: now,
  });

  return principalId;
}

/**
 * Is this Principal a flair admin? Reads the Agent record's `admin`/`role`
 * fields. A MCP-OAuth agent is NON-admin unless an operator has explicitly
 * marked its Agent record admin — the MCP surface never elevates on its own.
 */
async function isAgentAdmin(principalId: string): Promise<boolean> {
  try {
    const agent = await (databases as any).flair.Agent.get(principalId);
    return agent?.admin === true || agent?.role === "admin";
  } catch {
    return false;
  }
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

  // Parse the JSON-RPC body. Harper's Request wraps a Node stream — read text.
  let msg: any;
  try {
    const text = typeof request.text === "function" ? await request.text() : request.body;
    msg = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
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
        serverInfo: { name: "flair", version: "0.1.0" },
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

  const agent = await resolveAgentFromSub(String(sub));
  if (!agent) {
    // Sub verified by the AS but not mapped to a flair Agent (and JIT disabled /
    // failed). Deny — do NOT fall back to anonymous or admin.
    return rpcError(id, -32001, "forbidden: token subject is not a provisioned flair agent");
  }

  try {
    const result = await entry.impl(agent, args);
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
  } catch (err: any) {
    return rpcError(id, -32000, `tool execution failed: ${err?.message ?? String(err)}`);
  }
}
