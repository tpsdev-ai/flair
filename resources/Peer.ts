import { databases } from "@harperfast/harper";
import { allowAdmin } from "./agent-auth.js";
import { MCP_HIDDEN } from "./mcp-curation.js";

/**
 * Peer holds federation peer records (URLs + credentials) — system/admin data,
 * no agent grant. Before the auth flip the global gate was its only protection;
 * the non-rejecting gate means it must self-authorize. Admin/internal only on
 * every path. (Federation pairing/sync use dedicated endpoints — FederationPair,
 * FederationSync — not direct Peer table access.)
 */
export class Peer extends (databases as any).flair.Peer {
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
  allowRead()   { return allowAdmin((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowAdmin((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }
}
