// seed-post-caller-txn-3170 — TEST-ONLY resource for flair#3170's in-place case.
//
// test/integration/skill-retry-backfill-3170.test.ts installs this file as
// `dist/resources/zz-seed-post-caller-txn-3170.js` in a PRIVATE composed copy of
// the built component, the same shape as component-with-replay-probe. Nothing
// under resources/ references it and it is never packed or shipped.
//
// It writes a Memory record inside a transaction the caller owns and, when
// asked, aborts that transaction after the write returns: the shape of an
// in-process caller that composes a Memory write with its own and then fails.
// The internal context is the operator source a reserved seed write requires.
import { Resource, databases, server, transaction } from "harper";
import { collectionResource, internalContext } from "./in-process.js";

class CallerAbort extends Error {}

export class SeedPostCallerTxnProbe extends Resource {
  allowCreate() {
    return true;
  }

  async post(body) {
    const record = body?.record;
    const ctx = internalContext();
    let written = null;
    let staged = null;
    // The staged values a caller can see INSIDE its own transaction, before it
    // commits or aborts: the row content the write put there and the newest
    // version it appended. A version row is staged in the transaction's write
    // set (its deterministic id is subjectType:subjectId:sequence) and is not
    // visible to a table read until commit, so read the staged write's id.
    const readStaged = async () => {
      const row = await databases.flair.Memory.get(record.id, ctx);
      const store = databases.flair.InstructionVersion.primaryStore;
      const prefix = `skill:${record.id}:`;
      let version = null;
      for (const write of ctx.transaction?.writes ?? []) {
        if (write?.store !== store) continue;
        const key = String(write.key);
        if (!key.startsWith(prefix)) continue;
        const sequence = Number(key.slice(prefix.length));
        if (Number.isInteger(sequence) && (version === null || sequence > version)) version = sequence;
      }
      return { content: row?.content ?? null, version };
    };
    try {
      await transaction(ctx, async () => {
        const h = await collectionResource(server.resources.get("Memory").Resource, ctx);
        written = await h.post(record);
        if (written instanceof Response) return;
        staged = await readStaged();
        if (body?.abort === true) {
          throw new CallerAbort("the caller aborts its transaction after the write");
        }
      });
    } catch (err) {
      if (!(err instanceof CallerAbort)) throw err;
      return { aborted: true, written: written?.written === true, staged };
    }
    if (written instanceof Response) {
      return { aborted: false, written: false, status: written.status, body: await written.text() };
    }
    return { aborted: false, written: written?.written === true, staged };
  }
}
