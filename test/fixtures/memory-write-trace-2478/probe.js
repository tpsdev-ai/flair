import { databases } from "harper";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const { Memory } = databases.flair;
const output = join(process.env.ROOTPATH, "memory-write-trace-2478.jsonl");
const writerContext = new AsyncLocalStorage();
export function traceMemoryWriter(writer, call) {
  return writerContext.run(writer ?? "unattributed", call);
}
for (const method of ["put", "update", "post", "delete"]) {
  const original = Memory[method];
  if (typeof original !== "function") continue;
  Memory[method] = function (...args) {
    // put(record), update(id, fields), post(record[, context]), delete(id[, context])
    const record = method === "update" ? args[1] : method === "delete" ? null : args[0];
    appendFileSync(output, JSON.stringify({
      writer: writerContext.getStore() ?? "unattributed",
      method,
      id: String(method === "update" || method === "delete" ? args[0] : record.id),
      fields: record ? Object.keys(record).sort() : [],
      promotionStatus: record?.promotionStatus,
    }) + "\n");
    return original.apply(this, args);
  };
}
