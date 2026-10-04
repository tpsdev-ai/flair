/**
 * flair-agent-role-boot.ts — at server start, attempts to bring an existing
 * `flair_agent` role to this release's grants (flair#2141 S1).
 *
 * `flair init` writes the role. Each worker runs `alignFlairAgentRole` once,
 * through Harper's in-process operations API; it never creates the role. A
 * failure is logged with the `[flair-agent-role]` marker and the server keeps
 * serving.
 *
 * Plain module (no Resource export), loaded at boot like
 * resources/migration-boot.ts.
 */
import { server } from "harper";
import { alignFlairAgentRole, type RoleOperation } from "../src/lib/flair-agent-role.js";

export function scheduleFlairAgentRoleAlign(op?: RoleOperation): void {
  const run: RoleOperation = op ?? ((body) => server.operation(body, { user: null }, false));
  setImmediate(() => {
    alignFlairAgentRole(run).then(
      (outcome) => {
        if (outcome === "updated") console.log("[flair-agent-role] the flair_agent role was updated to this release's grants");
      },
      (err) => {
        console.error(
          "[flair-agent-role] the flair_agent role could not be checked or updated, so it may lack the grants for tables added since it was set; restart the server to retry",
          { err: err instanceof Error ? err.message : String(err) },
        );
      },
    );
  });
}

scheduleFlairAgentRoleAlign();
