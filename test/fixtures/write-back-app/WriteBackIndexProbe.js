import { Resource, databases } from "harper";

export class WriteBackIndexProbe extends Resource {
  allowCreate() { return true; }
  async post({ id, agentId }) {
    const table = databases.flair.Memory;
    await table.indices.agentId.remove(agentId, id);
    let indexed = false;
    for await (const row of table.search({ conditions: [{ attribute: "agentId", comparator: "equals", value: agentId }] }, {})) {
      if (row.id === id) indexed = true;
    }
    return { indexed };
  }
}
