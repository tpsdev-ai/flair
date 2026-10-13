/**
 * AgentKeyRegistration.ts — the Flair resource route for the key-registration
 * audit log (flair#2266).
 *
 * One row per committed POST /AgentKeyRegister. It carries no secret (the key
 * FINGERPRINT, never the key). On this route reads are admin-only and create,
 * update and delete are refused. The registration operation is the table's only
 * application writer, through the raw table in its registration transaction.
 * The Harper operations API is a separate raw-table trust root, not governed
 * here.
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
