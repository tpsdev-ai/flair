import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../../schemas/agent.graphql", import.meta.url), "utf8");
const agent = schema.match(/type Agent\b[^\{]*\{([^}]+)\}/)![1];
const requiredStrings = [...agent.matchAll(/^\s*(\w+): String!/gm)].map(match => match[1]);

export function agentInsertSchemaError(records: Array<Record<string, unknown>>): Response | undefined {
  for (const record of records) {
    for (const field of requiredStrings) {
      if (record[field] == null) {
        return Response.json({ error: `Property ${field} is required` }, { status: 400 });
      }
      if (typeof record[field] !== "string") {
        return Response.json({ error: `Property ${field} must be a string` }, { status: 400 });
      }
    }
  }
}
