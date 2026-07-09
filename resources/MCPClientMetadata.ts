import { Resource, databases } from "@harperfast/harper";
import { mcpIssuer } from "./mcp-oauth-flag.js";
import { agentPublicKeyToJwk, buildCimdDocument } from "./mcp-client-metadata-fields.js";

/**
 * MCPClientMetadata — serves a Client ID Metadata Document (CIMD) for a
 * Flair agent at `GET /MCPClientMetadata/{agentId}`.
 *
 * This is the "publish" half of RFC 7523 private_key_jwt / client_credentials
 * agent-auth (see ~/ops/FLAIR-AGENT-AUTH-CONSUMER-SPEC.md and
 * HarperFast/oauth#159/#167). An authorization server that treats an agent's
 * `client_id` as this URL fetches this document to learn the agent's JWKS
 * (its EXISTING Ed25519 identity key) instead of doing a DCR registration —
 * no registration state to replicate across Fabric nodes, matching Flair's
 * stateless posture (see the beta-alignment doc's Delta 2/4).
 *
 * Public, unauthenticated — mirrors AgentCard.ts. CIMD documents are meant
 * to be fetched by an AS with no prior trust relationship (same posture as
 * an A2A agent card / OIDC client metadata); this document exposes ONLY the
 * agent's already-public identity key (the same value a verified caller
 * already reads via `GET /Agent/{id}`), never anything secret.
 *
 * ── pending oauth#162 ───────────────────────────────────────────────────────
 * The document served here is the TARGET shape (`grant_types:
 * ["client_credentials"]`, `token_endpoint_auth_method: "private_key_jwt"`),
 * which today's merged #167 CIMD validator does not yet accept — see
 * mcp-client-metadata-fields.ts's header for the exact gaps. Serving it is
 * harmless (an AS that doesn't yet understand client_credentials CIMD
 * clients simply 400s on fetch, the same fail-closed outcome as if this
 * route didn't exist) and means no code change is needed HERE once #162
 * lands — the fix is entirely on the plugin side.
 */
export class MCPClientMetadata extends Resource {
  allowRead(): boolean {
    return true;
  }

  async get(pathInfo?: any) {
    const agentId =
      (typeof pathInfo === "string" ? pathInfo : null) ??
      (this as any).getId?.() ??
      null;

    if (!agentId) {
      return new Response(
        JSON.stringify({ error: "agentId required in path: GET /MCPClientMetadata/{agentId}" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const issuer = mcpIssuer();
    if (!issuer) {
      // Fail closed rather than guess a client_id URL — CIMD requires the
      // document's client_id to equal the URL it was fetched from, byte for
      // byte, so a floating/unpinned origin would produce a document that
      // never validates.
      return new Response(
        JSON.stringify({
          error: "mcp_issuer_not_configured",
          message:
            "FLAIR_MCP_ISSUER (or FLAIR_PUBLIC_URL) must be set to publish a stable client_id URL.",
        }),
        { status: 501, headers: { "Content-Type": "application/json" } },
      );
    }

    const agent = await (databases as any).flair.Agent.get(agentId).catch(() => null);
    if (!agent?.publicKey) {
      return new Response(JSON.stringify({ error: "agent_not_found_or_no_key", agentId }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    let jwk;
    try {
      jwk = agentPublicKeyToJwk(String(agent.publicKey), agentId);
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: "invalid_agent_key", message: err?.message ?? String(err) }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const clientId = `${issuer.replace(/\/+$/, "")}/MCPClientMetadata/${agentId}`;
    const doc = buildCimdDocument({
      clientId,
      clientName: String(agent.name ?? agent.displayName ?? agentId),
      jwk,
    });

    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
