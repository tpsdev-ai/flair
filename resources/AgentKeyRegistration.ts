/**
 * AgentKeyRegistration.ts — the admin-read-only view of the key-registration
 * audit log (flair#2266).
 *
 * One row per committed POST /AgentKeyRegister. It carries no secret (the key
 * FINGERPRINT, never the key). Reads are admin-only; every REST write is refused
 * — the only writer is resources/AgentKeyRegister.ts, through the raw table in
 * its registration transaction.
 */
import { databases } from "harper";
import { allowAdmin } from "./agent-auth.js";

export class AgentKeyRegistration extends (databases as any).flair.AgentKeyRegistration {
  allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  allowCreate(): boolean {
    return false;
  }

  allowUpdate(): boolean {
    return false;
  }

  allowDelete(): boolean {
    return false;
  }
}
