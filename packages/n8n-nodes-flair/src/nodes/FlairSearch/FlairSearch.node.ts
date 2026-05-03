import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  type SupplyData,
  NodeConnectionTypes,
} from "n8n-workflow";

import { FlairClient } from "@tpsdev-ai/flair-client";

interface FlairCredentials {
  baseUrl: string;
  agentId: string;
  adminPassword: string;
}

type Operation = "search" | "getBySubject";

function makeClient(credentials: FlairCredentials): FlairClient {
  return new FlairClient({
    url: credentials.baseUrl,
    agentId: credentials.agentId,
    adminUser: "admin",
    adminPassword: credentials.adminPassword,
  });
}

async function runSearch(
  flair: FlairClient,
  query: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const results = await flair.memory.search(query, { limit });
  return results.map((r) => ({
    id: r.id,
    content: r.content,
    score: r.score,
    type: r.type,
    tags: r.tags,
    createdAt: r.createdAt,
  }));
}

async function runGetBySubject(
  flair: FlairClient,
  subject: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const memories = await flair.memory.list({ subject, limit });
  return memories.map((m: any) => ({
    id: m.id,
    content: m.content,
    type: m.type,
    tags: m.tags,
    subject: m.subject,
    createdAt: m.createdAt,
  }));
}

export class FlairSearch implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Flair Search",
    name: "flairSearch",
    icon: "file:flair.svg",
    group: ["transform"],
    version: [1],
    description:
      "Search Flair memory by semantic query or by subject. Use as an AI Agent tool to give the agent access to structured Flair memories.",
    defaults: {
      name: "Flair Search",
    },
    credentials: [
      {
        name: "flairApi",
        required: true,
      },
    ],
    codex: {
      categories: ["AI"],
      subcategories: {
        AI: ["Tools"],
        Tools: ["Other Tools"],
      },
      resources: {
        primaryDocumentation: [
          {
            url: "https://github.com/tpsdev-ai/flair#n8n",
          },
        ],
      },
    },
    inputs: [],
    outputs: [NodeConnectionTypes.AiTool],
    outputNames: ["Tool"],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Semantic Search",
            value: "search",
            description: "Find memories most semantically similar to a query",
          },
          {
            name: "Get By Subject",
            value: "getBySubject",
            description:
              "List memories filtered by subject (the entity/conversation/topic they're about)",
          },
        ],
        default: "search",
      },
      {
        displayName: "Query",
        name: "query",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { operation: ["search"] } },
        description: "The semantic query to search Flair memory for",
      },
      {
        displayName: "Subject",
        name: "subject",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { operation: ["getBySubject"] } },
        description: "The subject (entity / topic) to fetch memories for",
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        default: 5,
        description: "Maximum number of memories to return",
      },
      {
        displayName:
          "Get By Tag is not yet available — flair-client.memory.list does not yet expose a tag filter (tracked in q3qf spec §6). Workaround: use Semantic Search and let the model filter results by tags in the response.",
        name: "tagNotice",
        type: "notice",
        default: "",
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const credentials = (await this.getCredentials("flairApi")) as unknown as FlairCredentials;
    const operation = this.getNodeParameter("operation", itemIndex) as Operation;
    const limit = this.getNodeParameter("limit", itemIndex, 5) as number;
    const flair = makeClient(credentials);

    if (operation === "search") {
      const tool = new DynamicStructuredTool({
        name: "flair_search",
        description:
          "Search Flair memory by semantic similarity. Returns memories ranked by relevance to the query.",
        schema: z.object({
          query: z
            .string()
            .describe("The natural-language query to search memory for"),
        }),
        func: async ({ query }: { query: string }) => {
          const results = await runSearch(flair, query, limit);
          return JSON.stringify(results);
        },
      });
      return { response: tool };
    }

    // getBySubject — subject is bound at config time so the agent only
    // chooses to invoke it (not which subject to fetch).
    const subject = this.getNodeParameter("subject", itemIndex) as string;
    const tool = new DynamicStructuredTool({
      name: "flair_get_by_subject",
      description: `Get memories about subject "${subject}" from Flair, ordered by recency.`,
      schema: z.object({}),
      func: async () => {
        const results = await runGetBySubject(flair, subject, limit);
        return JSON.stringify(results);
      },
    });
    return { response: tool };
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const credentials = (await this.getCredentials("flairApi")) as unknown as FlairCredentials;
    const flair = makeClient(credentials);
    const inputs = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < inputs.length; i++) {
      const operation = this.getNodeParameter("operation", i) as Operation;
      const limit = this.getNodeParameter("limit", i, 5) as number;
      let results: Array<Record<string, unknown>>;
      if (operation === "search") {
        const query = this.getNodeParameter("query", i) as string;
        results = await runSearch(flair, query, limit);
      } else {
        const subject = this.getNodeParameter("subject", i) as string;
        results = await runGetBySubject(flair, subject, limit);
      }
      out.push({ json: { operation, results }, pairedItem: { item: i } });
    }

    return [out];
  }
}
