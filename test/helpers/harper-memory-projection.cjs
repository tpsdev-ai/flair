// Run under Node: Bun's loader stalls importing Harper's cyclic module graph.
// Exercise the installed ops validator and Table selector without opening a
// database or starting a server. Only table discovery and row storage are fake.
const { readFileSync } = require("node:fs");
const { makeTable } = require("../../node_modules/harper/dist/resources/Table.js");
const databases = require("../../node_modules/harper/dist/resources/databases.js");
const { ResourceBridge } = require("../../node_modules/harper/dist/dataLayer/harperBridge/ResourceBridge.js");

// A stand-in path for the fake primary store: makeTable keys its storage
// reclamation handler on it but this fixture opens no database.
const FIXTURE_STORE_PATH = "/tmp/flair-memory-projection-fixture";

async function main() {
  const { query, rows } = JSON.parse(readFileSync(0, "utf8"));
  const schema = readFileSync(require.resolve("../../schemas/memory.graphql"), "utf8");
  const body = schema.match(/^type Memory @table[^\n]*\{([\s\S]*?)^\}/m)?.[1];
  if (!body) throw new Error("Memory schema not found");
  const attributes = [...body.matchAll(/^  (\w+):/gm)].map(([, name]) => ({ name, attribute: name }));
  const table = makeTable({
    tableName: "Memory", databaseName: "flair", primaryKey: "id", attributes,
    indices: {}, schemaDefined: true,
    // Harper 5.3's makeTable reads `primaryStore.rootStore.path` and
    // `primaryStore.path` at construction, so the fake store carries both.
    primaryStore: { encoder: { structPrototype: {} }, path: FIXTURE_STORE_PATH, rootStore: { path: FIXTURE_STORE_PATH } },
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
