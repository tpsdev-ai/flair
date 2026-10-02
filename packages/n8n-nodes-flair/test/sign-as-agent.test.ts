// flair#1942 — the n8n nodes authenticate as the credential's agent.
//
// Before this change every node built its FlairClient with `adminUser: "admin"`
// + the credential's admin password, so a workflow ran with the instance
// administrator's authority (every agent's memories, private included) and
// nothing was signed. Each test below drives the real node against the real
// flair-client with `fetch` stubbed, and verifies the Ed25519 signature the
// request carried — i.e. as the credential's agent, not as the administrator.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify as ed25519Verify, type KeyObject } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";

import { FlairApi } from "../src/credentials/FlairApi.credentials";
import { FlairChatMemory } from "../src/nodes/FlairChatMemory/FlairChatMemory.node";
import { FlairSearch } from "../src/nodes/FlairSearch/FlairSearch.node";
import { FlairWrite } from "../src/nodes/FlairWrite/FlairWrite.node";
import {
  flairCredentialTest,
  makeClient,
  type FlairCredentials,
} from "../src/client";

const BASE_URL = "http://127.0.0.1:19926";

/** A fresh Ed25519 agent key, in the encoding a `~/.flair/keys/<id>.key` file holds. */
function newAgentKey(): { keyText: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyText = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return { keyText, publicKey };
}

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let seen: SeenRequest[] = [];
let reply: (request: SeenRequest) => { status: number; body: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  reply = () => ({ status: 200, body: {} });
  globalThis.fetch = (async (input: unknown, init: Record<string, any> = {}) => {
    const request: SeenRequest = {
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    seen.push(request);
    const r = reply(request);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function loggerStub(): { logger: any; warns: string[]; logs: string[] } {
  const warns: string[] = [];
  const logs: string[] = [];
  const record = (level: string) => (message: unknown) => logs.push(`${level}: ${String(message)}`);
  return {
    logger: {
      warn: (message: string) => {
        warns.push(message);
        logs.push(`warn: ${message}`);
      },
      error: record("error"),
      info: record("info"),
      debug: record("debug"),
    },
    warns,
    logs,
  };
}

/** Assert this request was signed by `publicKey` as `agentId` — a real signature, not just a header. */
function expectAgentSignature(header: string | undefined, publicKey: KeyObject, request: SeenRequest): string {
  expect(header).toBeDefined();
  expect(header!.startsWith("TPS-Ed25519 ")).toBe(true);
  expect(header!.toLowerCase().includes("basic ")).toBe(false);
  const rest = header!.slice("TPS-Ed25519 ".length);
  const cut = rest.indexOf(":");
  const agentId = rest.slice(0, cut);
  const [ts, nonce, signature] = rest.slice(cut + 1).split(":");
  const url = new URL(request.url);
  const payload = `${agentId}:${ts}:${nonce}:${request.method}:${url.pathname}${url.search}`;
  expect(ed25519Verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64"))).toBe(true);
  return agentId;
}

function writeCtx(credentials: FlairCredentials, logger: any, content = "hello from n8n"): any {
  const params: Record<string, unknown> = {
    content,
    subject: "",
    tags: "",
    durability: "standard",
    type: "session",
    skipEmpty: true,
  };
  return {
    getCredentials: async () => credentials,
    getNodeParameter: (name: string, _index?: number, fallback?: unknown) =>
      name in params ? params[name] : fallback,
    getInputData: () => [{ json: { content } }],
    logger,
  };
}

function searchCtx(credentials: FlairCredentials, params: Record<string, unknown>, logger: any): any {
  return {
    getCredentials: async () => credentials,
    getNodeParameter: (name: string, _index?: number, fallback?: unknown) =>
      name in params ? params[name] : fallback,
    getInputData: () => [{ json: {} }],
    logger,
  };
}

function chatCtx(
  credentials: FlairCredentials,
  logger: any,
  params: Record<string, unknown> = { subject: "workflow-name", sessionKey: "", contextWindowLength: 10 },
): any {
  return {
    getCredentials: async () => credentials,
    getNodeParameter: (name: string, _index?: number, fallback?: unknown) =>
      name in params ? params[name] : fallback,
    logger,
  };
}

describe("the nodes sign as the credential's agent (flair#1942)", () => {
  test("FlairWrite signs its write as the credential's agent", async () => {
    const { keyText, publicKey } = newAgentKey();
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-writer", agentPrivateKey: keyText };
    const { logger, warns } = loggerStub();
    reply = () => ({ status: 200, body: { id: "mem-1", written: true } });

    const out = await (new FlairWrite().execute as any).call(writeCtx(credentials, logger));

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("PUT");
    expectAgentSignature(seen[0].headers["authorization"], publicKey, seen[0]);
    expect(warns).toHaveLength(0);
    expect(out[0][0].json._flair_id).toBe("mem-1");
  }, 10_000);

  test("FlairSearch signs its semantic search as the credential's agent", async () => {
    const { keyText, publicKey } = newAgentKey();
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-searcher", agentPrivateKey: keyText };
    const { logger, warns } = loggerStub();
    reply = (request) =>
      request.url.includes("/SemanticSearch")
        ? {
            status: 200,
            body: {
              results: [
                { id: "m1", content: "a fact", _score: 0.9, type: "fact", tags: [], createdAt: "2026-01-01T00:00:00Z" },
              ],
            },
          }
        : { status: 200, body: [] };

    const supply = await (new FlairSearch().supplyData as any).call(
      searchCtx(credentials, { operation: "search", limit: 5 }, logger),
      0,
    );
    const json = await (supply.response as any).func({ query: "anything" });

    expect(JSON.parse(json)[0].id).toBe("m1");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expectAgentSignature(seen[0].headers["authorization"], publicKey, seen[0]);
    expect(warns).toHaveLength(0);
  }, 10_000);

  test("FlairSearch's Get By Subject signs as the credential's agent", async () => {
    const { keyText, publicKey } = newAgentKey();
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-subject", agentPrivateKey: keyText };
    const { logger } = loggerStub();
    reply = () => ({ status: 200, body: [] });

    const supply = await (new FlairSearch().supplyData as any).call(
      searchCtx(credentials, { operation: "getBySubject", subject: "topic", limit: 5 }, logger),
      0,
    );
    await (supply.response as any).func({});

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expectAgentSignature(seen[0].headers["authorization"], publicKey, seen[0]);
  }, 10_000);

  test("FlairChatMemory signs its history read and write as the credential's agent", async () => {
    const { keyText, publicKey } = newAgentKey();
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-chat", agentPrivateKey: keyText };
    const { logger, warns } = loggerStub();
    reply = (request) =>
      request.method === "GET" ? { status: 200, body: [] } : { status: 200, body: { id: "m-1", written: true } };

    const supply = await (new FlairChatMemory().supplyData as any).call(chatCtx(credentials, logger), 0);
    const history = (supply.response as any).chatHistory;
    await history.addMessage(new HumanMessage("hi"));
    await history.getMessages();

    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expectAgentSignature(request.headers["authorization"], publicKey, request);
    }
    expect(warns).toHaveLength(0);
  }, 10_000);

  test("an agent key wins when the credential also carries an admin password", async () => {
    const { keyText, publicKey } = newAgentKey();
    const credentials: FlairCredentials = {
      baseUrl: BASE_URL,
      agentId: "n8n-both",
      agentPrivateKey: keyText,
      adminPassword: "legacy-secret",
    };
    const { logger, warns } = loggerStub();
    reply = () => ({ status: 200, body: { id: "mem-1", written: true } });

    await (new FlairWrite().execute as any).call(writeCtx(credentials, logger));

    expect(seen).toHaveLength(1);
    expectAgentSignature(seen[0].headers["authorization"], publicKey, seen[0]);
    expect(warns).toHaveLength(0);
  }, 10_000);
});

describe("the deprecated admin password still works and warns (flair#1942)", () => {
  test("every execution authenticates with Basic admin and logs a warning", async () => {
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-legacy", adminPassword: "legacy-secret" };
    const { logger, warns } = loggerStub();
    reply = () => ({ status: 200, body: { id: "m", written: true } });

    await (new FlairWrite().execute as any).call(writeCtx(credentials, logger));
    await (new FlairWrite().execute as any).call(writeCtx(credentials, logger));

    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.headers["authorization"]).toBe(
        "Basic " + Buffer.from("admin:legacy-secret").toString("base64"),
      );
    }
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain("deprecated");
    expect(warns[0]).toContain("n8n-legacy");
  }, 10_000);

  test("the warning is logged before the request, so a failing execution still warns", async () => {
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-legacy", adminPassword: "legacy-secret" };
    const { logger, warns } = loggerStub();
    reply = () => ({ status: 401, body: { error: "unauthorized" } });

    await expect((new FlairWrite().execute as any).call(writeCtx(credentials, logger))).rejects.toThrow();

    expect(warns).toHaveLength(1);
  }, 10_000);

  test("the credential test reports the deprecated path when the request succeeds", async () => {
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-legacy", adminPassword: "legacy-secret" };
    reply = () => ({ status: 200, body: [] });

    const result = await (flairCredentialTest as any).call({}, { data: credentials });

    expect(result.status).toBe("OK");
    expect(result.message).toContain("deprecated");
  }, 10_000);
});

describe("the agent key never leaves the credential (flair#1942)", () => {
  test("no node output, log line or error message carries the key", async () => {
    const { keyText } = newAgentKey();
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-secret", agentPrivateKey: keyText };

    // Success: the write node's output, the search node's payload, the
    // chat-memory history and every log line carry only memory data.
    reply = (request) =>
      request.method === "GET"
        ? { status: 200, body: [] }
        : {
            status: 200,
            body: { id: "m", written: true, results: [{ id: "m", content: "c", _score: 1 }] },
          };
    const writeLog = loggerStub();
    const searchLog = loggerStub();
    const chatLog = loggerStub();
    const writeOut = await (new FlairWrite().execute as any).call(writeCtx(credentials, writeLog.logger));
    const searchOut = await (new FlairSearch().execute as any).call(
      searchCtx(credentials, { operation: "search", query: "q", limit: 5 }, searchLog.logger),
    );
    const chat = await (new FlairChatMemory().supplyData as any).call(chatCtx(credentials, chatLog.logger), 0);
    await (chat.response as any).chatHistory.addMessage(new HumanMessage("hi"));

    expect(
      JSON.stringify([writeOut, searchOut, writeLog.logs, searchLog.logs, chatLog.logs]),
    ).not.toContain(keyText);

    // Failure: the server refuses, and the error must not quote the credential.
    seen = [];
    reply = () => ({ status: 401, body: { error: "unauthorized" } });
    let message = "";
    try {
      await (new FlairWrite().execute as any).call(writeCtx(credentials, loggerStub().logger));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(keyText);

    // The credential test's error path too.
    const result = await (flairCredentialTest as any).call({}, { data: credentials });
    expect(result.status).toBe("Error");
    expect(result.message).not.toContain(keyText);
  }, 20_000);

  test("a credential with neither field is refused by name", async () => {
    await expect(makeClient({ baseUrl: BASE_URL, agentId: "n8n-none" })).rejects.toThrow(/Agent Private Key/);
  }, 10_000);

  test("a PEM pasted into the key field is refused with the expected encoding", async () => {
    await expect(
      makeClient({
        baseUrl: BASE_URL,
        agentId: "n8n-pem",
        agentPrivateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
      }),
    ).rejects.toThrow(/base64/);
  }, 10_000);

  test("the key field is a masked secret and the admin field is named deprecated", () => {
    const cred = new FlairApi();
    const key = cred.properties.find((p) => p.name === "agentPrivateKey")!;
    expect((key as any).typeOptions?.password).toBe(true);
    expect(key.required).toBeUndefined();

    const admin = cred.properties.find((p) => p.name === "adminPassword")!;
    expect((admin as any).typeOptions?.password).toBe(true);
    expect(admin.displayName.toLowerCase()).toContain("deprecated");
    expect(admin.required).toBeUndefined();
  }, 10_000);

  test("each node declares the credential test and provides it", () => {
    for (const node of [new FlairWrite(), new FlairSearch(), new FlairChatMemory()] as any[]) {
      const declared = node.description.credentials![0];
      expect(declared.name).toBe("flairApi");
      expect(declared.testedBy).toBe("flairCredentialTest");
      expect(typeof node.methods.credentialTest.flairCredentialTest).toBe("function");
    }
  }, 10_000);
});
