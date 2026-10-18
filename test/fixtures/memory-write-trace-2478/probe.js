import { databases } from "harper";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const { Memory } = databases.flair;
const output = join(process.env.ROOTPATH, "memory-write-trace-2478.jsonl");
for (const method of ["put", "update"]) {
  const original = Memory[method];
  Memory[method] = function (...args) {
    const record = method === "update" ? args[1] : args[0];
    appendFileSync(output, JSON.stringify({
      method,
      id: String(method === "update" ? args[0] : record.id),
      fields: Object.keys(record).sort(),
      promotionStatus: record.promotionStatus,
    }) + "\n");
    return original.apply(this, args);
  };
}
