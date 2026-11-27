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
import { Resource, server, transaction } from "harper";
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
    try {
      await transaction(ctx, async () => {
        const h = await collectionResource(server.resources.get("Memory").Resource, ctx);
        written = await h.post(record);
        if (body?.abort === true && !(written instanceof Response)) {
          throw new CallerAbort("the caller aborts its transaction after the write");
        }
      });
    } catch (err) {
      if (!(err instanceof CallerAbort)) throw err;
      return { aborted: true, written: true };
    }
    if (written instanceof Response) {
      return { aborted: false, written: false, status: written.status, body: await written.text() };
    }
    return { aborted: false, written: written != null };
  }
}
