import { databases } from "@harperfast/harper";
import { allowVerified, allowAdmin } from "./agent-auth.js";

/**
 * ObsAgentSnapshot — observatory per-agent snapshot read-model. Writes are
 * system-driven (internal sync); agents may read. See ObsOffice for the
 * allowRead=allowVerified security default (flag for Sherlock).
 */
export class ObsAgentSnapshot extends (databases as any).flair.ObsAgentSnapshot {
  allowRead()   { return allowVerified((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowAdmin((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }
}
