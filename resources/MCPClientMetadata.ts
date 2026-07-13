import { Resource, databases } from "@harperfast/harper";
import { mcpIssuer } from "./mcp-oauth-flag.js";
import { agentPublicKeyToJwk, buildCimdDocument } from "./mcp-client-metadata-fields.js";

/**
 * MCPClientMetadata — serves a Client ID Metadata Document (CIMD) for a
 * Flair agent at `GET /MCPClientMetadata/{agentId}`.
 *
 * This is the "publish" half of RFC 7523 private_key_jwt / client_credentials
 * agent-auth (see docs/notes/mcp-agent-auth-consumer.md and
 * HarperFast/oauth#159, whose full chain is now shipped in the published
 * @harperfast/oauth@2.2.0: assertion verification #160/PR #165, CIMD-first
 * client resolution #161/#167, token-endpoint grant + issuance rate
 * limiting #162/#163 via PRs #170/#171). An authorization server that
 * treats an agent's `client_id` as this URL fetches this document to learn
 * the agent's JWKS (its EXISTING Ed25519 identity key) instead of doing a
 * DCR registration — no registration state to replicate across Fabric
 * nodes, matching Flair's stateless posture.
 *
 * Public, unauthenticated — mirrors AgentCard.ts. CIMD documents are meant
 * to be fetched by an AS with no prior trust relationship (same posture as
 * an A2A agent card / OIDC client metadata); this document exposes ONLY the
 * agent's already-public identity key (the same value a verified caller
 * already reads via `GET /Agent/{id}`), never anything secret.
 *
 * The document served here is proven against the REAL published plugin:
 * test/unit/mcp-client-credentials-live-package.test.ts feeds it through
 * 2.2.0's actual `resolveCimdClient` fetch+validate pipeline, and
 * test/integration/mcp-client-credentials-e2e.test.ts serves it from a live
 * spawned Harper. Note the plugin's CIMD fetch enforces an UNCONDITIONAL
 * SSRF gate (https only, no private/loopback/link-local DNS answers, no
 * override knob) — so an AS can only ever consume this document when it is
 * served from a genuinely public HTTPS host. See the doc note's
 * "SSRF/loopback boundary" section.
 *
 * Deployment coordination: the AS's `clientIdMetadataDocuments.allowedHosts`
 * config MUST include this route's host (derived from `FLAIR_MCP_ISSUER` /
 * `FLAIR_PUBLIC_URL`, same env vars as `mcpIssuer()` below) — merely being
 * reachable is not enough; the allowlist gate is AS-side config and
 * fail-closed. See docs/notes/mcp-agent-auth-consumer.md.
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
