// checked-write-probe-2478 — TEST-ONLY resource for flair#2478 part 3a.
//
// test/integration/memory-archive-lock-2478.test.ts installs this file as
// `dist/resources/zz-checked-write-probe-2478.js` in a PRIVATE composed copy of
// the built component (the component-with-replay-probe shape): nothing under
// resources/ references it and it is never packed or shipped. It also installs
// `zz-memory-write-lock-copy-2478.js`, a byte copy of the built
// memory-write-lock.js: a second module instance, so a second token registry.
//
// Each op runs one checked-write scenario in the server process and reports
// what the built modules answered: a capability refusal's `reason`, or the
// lock and scope outcomes.
import { Resource, databases } from "harper";
import { patchMemoryWithLock, putMemoryWithLock } from "./Memory.js";
import { withMemoryWriteLock } from "./memory-write-lock.js";
import { withLockedMemoryTransaction } from "./memory-write-transaction.js";
import { withMemoryWriteLock as withCopiedRegistryLock } from "./zz-memory-write-lock-copy-2478.js";

const store = () => databases.flair.Memory.primaryStore;
const PHASE = { phase: "checked-write-probe" };

function refusal(err) {
  if (err && err.name === "MemoryWriteCapabilityError") return { refused: err.reason };
  throw err;
}

async function edit(id, text) {
  const row = await databases.flair.Memory.get(id, {});
  return { ...row, content: text };
}

export class CheckedWriteProbe2478 extends Resource {
  allowCreate() {
    return true;
  }

  async post(body) {
    const ctx = this.getContext();
    const id = String(body?.id);
    switch (body?.op) {
      case "control": {
        const content = await edit(id, body.text);
        const lock = await withMemoryWriteLock(store(), [id], (held) =>
          withLockedMemoryTransaction(held, ctx, (tx) => putMemoryWithLock(held, tx, { id, content })), PHASE);
        return { lock: lock.kind, scope: lock.value?.kind, confirmed: lock.value?.confirmed };
      }
      case "patch-commit":
      case "patch-abort": {
        // A checked PATCH: the committed read made while the scope is open
        // shows whether the write is staged in the scope's transaction; the
        // abort case refuses after the write staged.
        let receipt;
        let duringScope;
        const lock = await withMemoryWriteLock(store(), [id], (held) =>
          withLockedMemoryTransaction(held, ctx, async (tx) => {
            receipt = await patchMemoryWithLock(held, tx, { id, content: { content: body.text } });
            duringScope = (await databases.flair.Memory.get(id, {}))?.content;
            if (body.op === "patch-abort") return new Response(JSON.stringify({ error: "probe_refusal" }), { status: 409 });
            return "kept";
          }), PHASE);
        return {
          lock: lock.kind,
          scope: lock.value?.kind,
          confirmed: lock.value?.confirmed?.length,
          refusedStatus: lock.value?.response?.status,
          receipt: receipt?.status,
          duringScope,
        };
      }
      case "revoked": {
        const content = await edit(id, body.text);
        let saved;
        await withMemoryWriteLock(store(), [id], (held) =>
          withLockedMemoryTransaction(held, ctx, async (tx) => { saved = { held, tx }; return "kept"; }), PHASE);
        try {
          await putMemoryWithLock(saved.held, saved.tx, { id, content });
          return { refused: "none" };
        } catch (err) {
          return refusal(err);
        }
      }
      case "wrong-id": {
        const otherId = String(body.otherId);
        const content = await edit(otherId, body.text);
        let write;
        try {
          await withMemoryWriteLock(store(), [id], (held) =>
            withLockedMemoryTransaction(held, ctx, async (tx) => {
              try {
                await putMemoryWithLock(held, tx, { id: otherId, content });
                write = { refused: "none" };
              } catch (err) {
                write = refusal(err);
              }
              return "caught";
            }), PHASE);
          return { write, scope: "completed" };
        } catch (err) {
          return { write, scope: refusal(err) };
        }
      }
      case "foreign-registry": {
        const content = await edit(id, body.text);
        let scope;
        let write;
        await withCopiedRegistryLock(store(), [id], async (held) => {
          try {
            await withLockedMemoryTransaction(held, ctx, async () => "never");
            scope = { refused: "none" };
          } catch (err) {
            scope = refusal(err);
          }
          try {
            await putMemoryWithLock(held, {}, { id, content });
            write = { refused: "none" };
          } catch (err) {
            write = refusal(err);
          }
        }, PHASE);
        return { scope, write };
      }
      default:
        return { error: "unknown op" };
    }
  }
}
