import { databases } from "@harperfast/harper";
import { allowAdmin } from "./agent-auth.js";

/**
 * PairingToken holds one-time federation pairing secrets — admin/system only,
 * no agent grant. The FederationPair endpoint consumes tokens via internal calls
 * (allowAdmin permits internal), so dedicated flows keep working; direct anonymous
 * table access is denied. Self-authorizes now that the global gate is non-rejecting.
 */
export class PairingToken extends (databases as any).flair.PairingToken {
  allowRead()   { return allowAdmin((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowAdmin((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }
}
