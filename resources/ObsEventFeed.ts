import { databases } from "@harperfast/harper";
import { allowVerified, allowAdmin } from "./agent-auth.js";
import { MCP_HIDDEN } from "./mcp-curation.js";

/**
 * ObsEventFeed — observatory event-feed read-model. Writes are system-driven
 * (internal sync); agents may read. See ObsOffice for the allowRead=allowVerified
 * security default (flag for Sherlock).
 */
export class ObsEventFeed extends (databases as any).flair.ObsEventFeed {
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
  allowRead()   { return allowVerified((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowAdmin((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }
}
