// chain-write-probe-2686 — TEST-ONLY resource for flair#2686's caller-hook cases.
//
// test/integration/skill-update-caller-transaction-2686.test.ts installs this
// file as `dist/resources/zz-chain-write-2686.js` in a PRIVATE composed copy of
// the built component, the same shape as component-with-replay-probe: nothing
// under resources/ references it and it is never packed or shipped.
//
// It wraps the exported `defaultSkillHooks.closePredecessor`, which Memory's own
// hooks spread into every skill write, so a superseding write runs the caller
// hook inside its transaction. When armed for a predecessor id, the hook writes
// one row to a second database through the same context. That write makes
// Harper create a real `transaction.next` link, which the write journal has to
// capture for compensation to undo it.
import { Resource, databases } from "harper";
import { defaultSkillHooks } from "./skill-version-write.js";

// Declared by the composed copy's schemas/zz-chain-2686.graphql. A table in a
// second database makes the hook's write create a real `transaction.next` link.
const chainRows = () => databases.chain2686.ChainRow;

let armed = null;
let writes = 0;

const originalClose = defaultSkillHooks.closePredecessor;
defaultSkillHooks.closePredecessor = async (predecessor, patch, shared) => {
  const result = await originalClose(predecessor, patch, shared);
  const target = armed;
  if (target && String(predecessor.id) === target.predecessorId) {
    armed = null;
    await chainRows().put({ id: target.rowId, value: "caller-chain" }, shared);
    writes++;
  }
  return result;
};

export class ChainWriteProbe extends Resource {
  allowCreate() {
    return true;
  }

  async post(body) {
    switch (body?.op) {
      case "arm":
        armed = { predecessorId: String(body.predecessorId), rowId: String(body.rowId) };
        writes = 0;
        return { armed: true };
      case "state":
        return { writes, armed };
      case "read":
        return { row: (await chainRows().get(String(body.id), {})) ?? null };
      default:
        return { error: "unknown op" };
    }
  }
}
