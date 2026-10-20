// Test-only probe for the MemoryMaintenance read sets.
//
// Installed as an extra resource in a private component copy (see
// test/helpers/component-with-replay-probe.ts). It wraps the
// MemoryHostSource table's search, appending one JSON line per iteration to
// <ROOTPATH>/maintenance-read-probe-2084.jsonl with the query's conditions and
// the number of rows the search yielded, and wraps the Memory table's search
// the same way into maintenance-memory-read-probe-2084.jsonl. A test reads
// those lines to assert which rows a run read, independent of wall-clock
// timing. Every other method and property of the original result is passed
// through.
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

// Same wrap for the Memory table's search, logged separately: the Memory item
// loop's read set is observed by the owner-scope test that checks a run scoped
// to one agent supplies the indexed agentId condition.
const memoryTable = databases.flair.Memory;
const memoryOutput = join(process.env.ROOTPATH, "maintenance-memory-read-probe-2084.jsonl");
const originalMemorySearch = memoryTable.search;

memoryTable.search = function (query, ...rest) {
  const result = originalMemorySearch.call(this, query, ...rest);
  return new Proxy(result, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return async function* () {
          let count = 0;
          for await (const row of target) {
            count += 1;
            yield row;
          }
          appendFileSync(memoryOutput, JSON.stringify({ conditions: query?.conditions ?? null, rows: count }) + "\n");
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
