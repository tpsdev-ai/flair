// Test-only probe for the MemoryMaintenance orphan sweep's read set.
//
// Installed as an extra resource in a private component copy (see
// test/helpers/component-with-replay-probe.ts). It wraps the
// MemoryHostSource table's search so each iteration appends one JSON line to
// <ROOTPATH>/maintenance-read-probe-2084.jsonl with the query's conditions and
// the number of rows the search yielded. A test reads that line to assert how
// many pointer rows the sweep read, independent of wall-clock timing. Every
// other method and property of the original result is passed through.
import { databases } from "harper";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const table = databases.flair.MemoryHostSource;
const output = join(process.env.ROOTPATH, "maintenance-read-probe-2084.jsonl");
const originalSearch = table.search;

table.search = function (query, ...rest) {
  const result = originalSearch.call(this, query, ...rest);
  return new Proxy(result, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return async function* () {
          let count = 0;
          for await (const row of target) {
            count += 1;
            yield row;
          }
          appendFileSync(output, JSON.stringify({ conditions: query?.conditions ?? null, rows: count }) + "\n");
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
