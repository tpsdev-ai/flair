import { databases } from "harper";
import { Memory } from "./Memory.js";

const identity = (row) => row == null ? null : ({
  agentId: row.agentId, content: row.content, instanceToken: row.instanceToken,
  subject: row.subject, dims: row.embedding?.length,
});
const written = new Map();
const table = databases.flair.Memory;
const get = table.get;
table.get = async function (id, ctx) {
  const row = await get.call(this, id, ctx);
  if (String(id).startsWith("wbc-stamp-") || String(id).startsWith("wbc-backfill-")) {
    console.log("[write-back-trace]", JSON.stringify({
      phase: "read", id, open: ctx?.transaction?.open === 1,
      selected: identity(row), memRow: written.get(id),
    }));
  }
  return row;
};
for (const verb of ["put", "patch"]) {
  const method = Memory.prototype[verb];
  Memory.prototype[verb] = async function (body, query) {
    const id = body?.id ?? this.getId();
    const trace = String(id).startsWith("wbc-stamp-") || String(id).startsWith("wbc-backfill-");
    const result = await method.call(this, body, query);
    if (trace) {
      written.set(id, identity(body));
      console.log("[write-back-trace]", JSON.stringify({
        phase: verb, id, memRow: identity(body),
        status: result instanceof Response ? result.status : "normal",
      }));
    }
    return result;
  };
}
