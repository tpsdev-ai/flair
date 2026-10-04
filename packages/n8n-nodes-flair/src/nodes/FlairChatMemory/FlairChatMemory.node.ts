import { BufferWindowMemory } from "@langchain/classic/memory";
import {
  type ISupplyDataFunctions,
  type INodeType,
  type INodeTypeDescription,
  type SupplyData,
  NodeConnectionTypes,
} from "n8n-workflow";

import {
  flairCredentialTest,
  makeClient,
  warnDeprecatedAdminPassword,
  asFlairCredentials,
} from "../../client";

import { FlairChatMessageHistory } from "./FlairChatMessageHistory";

export class FlairChatMemory implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Flair Chat Memory",
    name: "flairChatMemory",
    icon: "file:flair.svg",
    group: ["transform"],
    version: [1],
    description:
      "Store n8n AI Agent chat history in Flair, a portable agent memory backend. The same memory is readable from Claude Code, OpenClaw, and any other Flair client.",
    defaults: {
      name: "Flair Chat Memory",
    },
    credentials: [
      {
        name: "flairApi",
        required: true,
        testedBy: "flairCredentialTest",
      },
    ],
    codex: {
      categories: ["AI"],
      subcategories: {
        AI: ["Memory"],
        Memory: ["Other memories"],
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
    outputs: [NodeConnectionTypes.AiMemory],
    outputNames: ["Memory"],
    properties: [
      {
        displayName: "Subject",
        name: "subject",
        type: "string",
        default: '={{ $workflow.name }}',
        required: true,
        description:
          "Flair subject that scopes the chat history. Defaults to the workflow name. Workflows that share a subject share memory.",
      },
      {
        displayName: "Session Sub-Key",
        name: "sessionKey",
        type: "string",
        default: "",
        description:
          "Optional sub-scope appended to the subject as `<subject>:<sessionKey>`. Use the n8n execution id (`={{ $execution.id }}`) for per-run chat-history grouping by subject, or leave blank to share memory across runs.",
      },
      {
        displayName: "Context Window Length",
        name: "contextWindowLength",
        type: "number",
        default: 10,
        description:
          "How many message turns (user + AI = 1 turn) to keep in the buffer window.",
      },
    ],
  };

  methods = { credentialTest: { flairCredentialTest } };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const credentials = asFlairCredentials(await this.getCredentials("flairApi"));
    const subject = this.getNodeParameter("subject", itemIndex) as string;
    const sessionKey = this.getNodeParameter("sessionKey", itemIndex, "") as string;
    const k = this.getNodeParameter("contextWindowLength", itemIndex, 10) as number;

    const composedSubject = sessionKey ? `${subject}:${sessionKey}` : subject;

    const flair = await makeClient(credentials);
    warnDeprecatedAdminPassword(this.logger, credentials);

    const history = new FlairChatMessageHistory(flair, composedSubject, k);

    const memory = new BufferWindowMemory({
      memoryKey: "chat_history",
      chatHistory: history,
      returnMessages: true,
      inputKey: "input",
      outputKey: "output",
      k,
    });

    return { response: memory };
  }
}
