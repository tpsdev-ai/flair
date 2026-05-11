/**
 * FlairWrite — pipeline-mode node that writes a memory into Flair.
 *
 * Complement to FlairSearch (read-only AI Tool) and FlairChatMemory
 * (LangChain BaseMemory adapter). FlairWrite is a regular Main-input /
 * Main-output node intended for capture-and-archive workflows: take an
 * incoming item (a TPS mail, a webhook payload, a parsed document) and
 * persist its content as a Flair memory with operator-chosen tags,
 * subject, and durability.
 *
 * Why a separate node from FlairSearch:
 *   - FlairSearch is wired into the AI Tool socket; it's read-only by
 *     design (write-as-LLM-tool needs guardrails we haven't designed
 *     yet — content sanitization, rate limiting, audit trail).
 *   - FlairWrite is operator-driven. Side effects are intentional and
 *     scoped to the workflow author's choices, not the LLM's.
 *   - Splitting keeps the AI-Tool-only contract on FlairSearch clean
 *     and lets each node evolve independently.
 *
 * The dual-purpose alternative (one node with both AI Tool and Main
 * sockets) is possible in n8n but harder to reason about — the same
 * configuration would surface differently depending on which socket
 * the user wires it to. Two narrow nodes are easier to discover and
 * easier to dogfood.
 */

import {
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  NodeConnectionTypes,
} from "n8n-workflow";

// flair-client is published ESM-only. n8n nodes compile to CJS and load via
// `require`, so a static `import { FlairClient } from "@tpsdev-ai/flair-client"`
// crashes at boot on Node 24+ with "No exports main defined" because the
// flair-client package only declares an `import` condition in its exports
// map. The `import type` line emits no runtime require, and the dynamic
// import inside `makeClient` is the standard CJS→ESM interop path.
//
// Filed: ops follow-up to ship a dual ESM/CJS build of flair-client so
// static imports work too. Until then this dynamic-import pattern is the
// load-bearing fix.
import type { FlairClient } from "@tpsdev-ai/flair-client";

interface FlairCredentials {
  baseUrl: string;
  agentId: string;
  adminPassword: string;
}

// Wrap dynamic import in Function() so TypeScript (compiled to CommonJS
// for n8n consumption) doesn't downlevel `await import(...)` to a `require()`
// call. The downleveled require() hits flair-client's ESM-only exports map
// and Node 24+ rejects it (which is what bit us in n8n at runtime —
// commit 31dd2b3 "fixed" this via dynamic import but TSC compiled it right
// back to require under `module: "CommonJS"`).
// The Function() trick keeps the import as a true native dynamic import in
// the emitted JS, which Node honors as ESM regardless of caller's module
// type. Standard CJS-to-ESM interop pattern.
const importFlairClient = (): Promise<typeof import("@tpsdev-ai/flair-client")> =>
  (new Function("return import('@tpsdev-ai/flair-client')") as () => Promise<any>)();

async function makeClient(credentials: FlairCredentials): Promise<FlairClient> {
  const mod = await importFlairClient();
  return new mod.FlairClient({
    url: credentials.baseUrl,
    agentId: credentials.agentId,
    adminUser: "admin",
    adminPassword: credentials.adminPassword,
  });
}

export class FlairWrite implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Flair Write",
    name: "flairWrite",
    icon: "file:flair.svg",
    group: ["output"],
    version: [1],
    description:
      "Write a memory into Flair from a workflow item. Use for capture-and-archive flows (mail → memory, webhook → memory, parsed-doc → memory).",
    defaults: {
      name: "Flair Write",
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
        AI: ["Memory"],
      },
      resources: {
        primaryDocumentation: [
          {
            url: "https://github.com/tpsdev-ai/flair#n8n",
          },
        ],
      },
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    properties: [
      {
        displayName: "Content",
        name: "content",
        type: "string",
        typeOptions: { rows: 4 },
        default: "={{ $json.content }}",
        required: true,
        description:
          "The memory content to store. Defaults to the input item's `content` field; override with any expression that produces a string.",
      },
      {
        displayName: "Subject",
        name: "subject",
        type: "string",
        default: "",
        description:
          "Optional subject (the entity / conversation / topic this memory is about). Maps to Flair's `subject` field. Leave blank to omit.",
      },
      {
        displayName: "Tags",
        name: "tags",
        type: "string",
        default: "",
        description:
          'Comma-separated tags (e.g. "source:tps-mail, kind:review, agent:kern"). Whitespace around commas is trimmed.',
      },
      {
        displayName: "Durability",
        name: "durability",
        type: "options",
        options: [
          { name: "Standard (default)", value: "standard" },
          { name: "Persistent (key decisions)", value: "persistent" },
          { name: "Permanent (inviolable)", value: "permanent" },
          { name: "Ephemeral (auto-expires 72h)", value: "ephemeral" },
        ],
        default: "standard",
        description:
          "Durability tier. See Flair docs for the semantic differences.",
      },
      {
        displayName: "Type",
        name: "type",
        type: "options",
        options: [
          { name: "Session (default)", value: "session" },
          { name: "Lesson", value: "lesson" },
          { name: "Decision", value: "decision" },
          { name: "Preference", value: "preference" },
          { name: "Fact", value: "fact" },
          { name: "Goal", value: "goal" },
        ],
        default: "session",
        description: "Memory type. Used by Flair's downstream filters and ranking.",
      },
      {
        displayName: "Skip Empty Content",
        name: "skipEmpty",
        type: "boolean",
        default: true,
        description:
          "If on, items whose content evaluates to an empty/whitespace-only string are passed through without writing. Off = the node throws on empty content (fail-loud for required-field workflows).",
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const credentials = (await this.getCredentials("flairApi")) as unknown as FlairCredentials;
    const flair = await makeClient(credentials);
    const inputs = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < inputs.length; i++) {
      const content = this.getNodeParameter("content", i) as string;
      const subject = this.getNodeParameter("subject", i, "") as string;
      const tagsStr = this.getNodeParameter("tags", i, "") as string;
      const durability = this.getNodeParameter("durability", i, "standard") as
        | "standard"
        | "persistent"
        | "permanent"
        | "ephemeral";
      const type = this.getNodeParameter("type", i, "session") as
        | "session"
        | "lesson"
        | "decision"
        | "preference"
        | "fact"
        | "goal";
      const skipEmpty = this.getNodeParameter("skipEmpty", i, true) as boolean;

      const trimmedContent = (content ?? "").trim();
      if (trimmedContent === "") {
        if (skipEmpty) {
          // Pass-through: surface that we skipped, but don't error.
          out.push({
            json: { ...inputs[i].json, _flair_skipped: "empty content" },
            pairedItem: { item: i },
          });
          continue;
        }
        throw new Error(
          `FlairWrite: empty content on item ${i} (skipEmpty is off). ` +
            `Content evaluated to "${content ?? ""}".`,
        );
      }

      const tags = tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const result = await flair.memory.write(trimmedContent, {
        type,
        durability,
        tags: tags.length > 0 ? tags : undefined,
        subject: subject || undefined,
      });

      out.push({
        json: {
          ...inputs[i].json,
          _flair_id: result.id,
          _flair_subject: subject || null,
          _flair_tags: tags,
          _flair_durability: durability,
          _flair_type: type,
        },
        pairedItem: { item: i },
      });
    }

    return [out];
  }
}
