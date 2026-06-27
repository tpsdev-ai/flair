import { databases } from "@harperfast/harper";
import { allowAdmin } from "./agent-auth.js";
import { MCP_HIDDEN } from "./mcp-curation.js";

/**
 * OAuthClient holds registered OAuth client records (incl. secrets) — admin/system
 * only, no agent grant. OAuth endpoints (OAuthRegister/Authorize/Token) read+write
 * clients via internal calls (allowAdmin permits internal), so the OAuth flows keep
 * working; direct anonymous table access is denied. Self-authorizes now that the
 * global gate is non-rejecting.
 */
export class OAuthClient extends (databases as any).flair.OAuthClient {
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
  allowRead()   { return allowAdmin((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowAdmin((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }
}
