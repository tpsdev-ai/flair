// Run under Node: Bun's loader stalls importing Harper's cyclic module graph.
// Exercise the installed ops validator and Table selector without opening a
// database or starting a server. Only table discovery and row storage are fake.
const { readFileSync } = require("node:fs");
const { makeTable } = require("../../node_modules/harper/dist/resources/Table.js");
const databases = require("../../node_modules/harper/dist/resources/databases.js");
const { ResourceBridge } = require("../../node_modules/harper/dist/dataLayer/harperBridge/ResourceBridge.js");

async function main() {
  const { query, rows } = JSON.parse(readFileSync(0, "utf8"));
  const schema = readFileSync(require.resolve("../../schemas/memory.graphql"), "utf8");
  const body = schema.match(/^type Memory @table[^\n]*\{([\s\S]*?)^\}/m)?.[1];
  if (!body) throw new Error("Memory schema not found");
  const attributes = [...body.matchAll(/^  (\w+):/gm)].map(([, name]) => ({ name, attribute: name }));
  const table = makeTable({
    tableName: "Memory", databaseName: "flair", primaryKey: "id", attributes,
    indices: {}, schemaDefined: true, primaryStore: { encoder: { structPrototype: {} } },
  });
  databases.getDatabases = () => ({ flair: { Memory: table } });
  table.search = (request) => {
    const project = table.transformEntryForSelect(request.select, {}, null, null);
    return rows.map((value) => project({ value }));
  };
  const projected = await new ResourceBridge().searchByConditions(query);
  process.stdout.write(JSON.stringify(projected));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
