import { databases } from "@harperfast/harper";
import { allowVerified, allowAdmin } from "./agent-auth.js";

/**
 * Instance is read-only reference data for agents (flair_agent grant: read only).
 * Verified agents + admin may read; writes are admin/internal only. Self-authorizes
 * now that the global gate is non-rejecting (anonymous denied).
 */
export class Instance extends (databases as any).flair.Instance {
  allowRead()   { return allowVerified((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowAdmin((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }
}
