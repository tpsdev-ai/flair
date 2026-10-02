// flair#1942 — Agent Private Key requests sign as the credential's Agent ID.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify as ed25519Verify, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanMessage } from "@langchain/core/messages";

import { FlairApi } from "../src/credentials/FlairApi.credentials";
import { FlairChatMemory } from "../src/nodes/FlairChatMemory/FlairChatMemory.node";
import { FlairSearch } from "../src/nodes/FlairSearch/FlairSearch.node";
import { FlairWrite } from "../src/nodes/FlairWrite/FlairWrite.node";
import {
  asFlairCredentials,
  flairCredentialTest,
  makeClient,
  type FlairCredentials,
} from "../src/client";

const BASE_URL = "http://127.0.0.1:19926";

/** Base64 PKCS8 fixture; the CLI key file contains a raw seed. */
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

/** Assert this request was signed by `publicKey` as `expectedAgentId`. */
function expectAgentSignature(header: string | undefined, publicKey: KeyObject, request: SeenRequest, expectedAgentId: string): string {
  expect(header).toBeDefined();
  expect(header!.startsWith("TPS-Ed25519 ")).toBe(true);
  expect(header!.toLowerCase().includes("basic ")).toBe(false);
  const rest = header!.slice("TPS-Ed25519 ".length);
  const cut = rest.indexOf(":");
  const agentId = rest.slice(0, cut);
  expect(agentId).toBe(expectedAgentId);
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

test("credential normalization trims only Agent ID and key text", () => {
  expect(asFlairCredentials({
    baseUrl: ` ${BASE_URL} `, agentId: " agent ", agentPrivateKey: " key ", adminPassword: " password ",
  })).toEqual({
    baseUrl: ` ${BASE_URL} `, agentId: "agent", agentPrivateKey: "key", adminPassword: " password ",
  });
});

describe("the nodes sign as the credential's agent (flair#1942)", () => {
  test("FlairWrite signs its write as the credential's agent", async () => {
    const { keyText, publicKey } = newAgentKey();
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-writer", agentPrivateKey: keyText };
    const { logger, warns } = loggerStub();
    reply = () => ({ status: 200, body: { id: "mem-1", written: true } });

    const out = await (new FlairWrite().execute as any).call(writeCtx(credentials, logger));

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("PUT");
    expectAgentSignature(seen[0].headers["authorization"], publicKey, seen[0], credentials.agentId);
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
    expectAgentSignature(seen[0].headers["authorization"], publicKey, seen[0], credentials.agentId);
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
    expectAgentSignature(seen[0].headers["authorization"], publicKey, seen[0], credentials.agentId);
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
      expectAgentSignature(request.headers["authorization"], publicKey, request, credentials.agentId);
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
    expectAgentSignature(seen[0].headers["authorization"], publicKey, seen[0], credentials.agentId);
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

describe("credential key handling (flair#1942)", () => {
  test("write/search execute outputs, write/search/chat logs, and write/credential-test 401 errors omit the key", async () => {
    const { keyText } = newAgentKey();
    const credentials: FlairCredentials = { baseUrl: BASE_URL, agentId: "n8n-secret", agentPrivateKey: keyText };

    // Check write/search execute outputs and write/search/chat logs for the key.
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

    // Check the write 401 error for the key.
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

    // Check the credential-test 401 error for the key.
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

const entryPoints: Array<[string, (credentials: FlairCredentials, logger: any) => Promise<unknown>]> = [
  ["FlairWrite.execute", async (credentials, logger) =>
    (new FlairWrite().execute as any).call(writeCtx(credentials, logger))],
  ["FlairSearch.execute", async (credentials, logger) =>
    (new FlairSearch().execute as any).call(searchCtx(credentials, { operation: "search", query: "q", limit: 5 }, logger))],
  ["FlairSearch.supplyData", async (credentials, logger) => {
    const supply = await (new FlairSearch().supplyData as any).call(
      searchCtx(credentials, { operation: "search", limit: 5 }, logger), 0,
    );
    return (supply.response as any).func({ query: "q" });
  }],
  ["FlairChatMemory.supplyData", async (credentials, logger) => {
    const supply = await (new FlairChatMemory().supplyData as any).call(chatCtx(credentials, logger), 0);
    await (supply.response as any).chatHistory.addMessage(new HumanMessage("hi"));
    return (supply.response as any).chatHistory.getMessages();
  }],
];

for (const [name, run] of entryPoints) {
  for (const agentId of ["", " \t "]) {
    for (const auth of ["key", "basic"] as const) {
      test(`${name}: ${auth} refuses ${JSON.stringify(agentId)} Agent ID despite ambient identity`, async () => {
        const savedAgentId = process.env.FLAIR_AGENT_ID;
        const credentials: FlairCredentials = {
          baseUrl: BASE_URL,
          agentId,
          ...(auth === "key" ? { agentPrivateKey: newAgentKey().keyText } : { adminPassword: "legacy-secret" }),
        };
        try {
          process.env.FLAIR_AGENT_ID = "ambient-agent";
          reply = () => ({ status: 200, body: [] });
          const result = await (flairCredentialTest as any).call({}, { data: credentials });
          expect(result.status).toBe("Error");
          expect(result.message).toContain("Agent ID");
          expect(result.message).not.toContain("Signed as agent ''");
          expect(seen).toHaveLength(0);
          const { logger, warns } = loggerStub();
          await expect(run(credentials, logger)).rejects.toThrow(/Agent ID/);
          expect(warns).toHaveLength(0);
          expect(seen).toHaveLength(0);
          await expect(makeClient(credentials)).rejects.toThrow(/Agent ID/);
          expect(seen).toHaveLength(0);
        } finally {
          if (savedAgentId === undefined) delete process.env.FLAIR_AGENT_ID;
          else process.env.FLAIR_AGENT_ID = savedAgentId;
        }
      }, 10_000);
    }
  }

  test(`${name}: Basic preserves password edge spaces through normalization`, async () => {
    const password = " \tlegacy-secret \t";
    const credentials: FlairCredentials = {
      baseUrl: BASE_URL, agentId: " n8n-legacy ", adminPassword: password,
    };
    const authorization = "Basic " + Buffer.from(`admin:${password}`).toString("base64");
    const { logger, warns } = loggerStub();
    reply = (request) => request.headers.authorization === authorization
      ? { status: 200, body: request.method === "GET" ? [] : { id: "m", written: true, results: [] } }
      : { status: 401, body: { error: "wrong password" } };
    const result = await (flairCredentialTest as any).call({}, { data: credentials });
    expect(result.status).toBe("OK");
    await run(credentials, logger);
    expect(seen.length).toBeGreaterThan(1);
    for (const request of seen) expect(request.headers.authorization).toBe(authorization);
    expect(warns).toHaveLength(1);
  }, 10_000);

  test(`${name}: whitespace-only key selects Basic like the credential test, despite a local key`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-n8n-basic-"));
    const savedKeyDir = process.env.FLAIR_KEY_DIR;
    const credentials: FlairCredentials = {
      baseUrl: BASE_URL, agentId: "n8n-local", agentPrivateKey: " \t ", adminPassword: "legacy-secret",
    };
    try {
      process.env.FLAIR_KEY_DIR = dir;
      writeFileSync(join(dir, "n8n-local.key"), Buffer.alloc(32, 7));
      const { logger, warns } = loggerStub();
      reply = (request) => ({ status: 200, body: request.method === "GET" ? [] : { id: "m", written: true, results: [] } });
      const result = await (flairCredentialTest as any).call({}, { data: credentials });
      expect(result.status).toBe("OK");
      expect(result.message).toContain("Harper administrator");
      await run(credentials, logger);
      expect(seen.length).toBeGreaterThan(1);
      for (const request of seen) {
        expect(request.headers.authorization).toBe("Basic " + Buffer.from("admin:legacy-secret").toString("base64"));
      }
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("This execution runs as the Harper administrator");
    } finally {
      if (savedKeyDir === undefined) delete process.env.FLAIR_KEY_DIR;
      else process.env.FLAIR_KEY_DIR = savedKeyDir;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test(`${name}: surrounding whitespace in Agent ID is normalized like the credential test`, async () => {
    const { keyText, publicKey } = newAgentKey();
    const credentials: FlairCredentials = {
      baseUrl: BASE_URL, agentId: " \tn8n-trimmed ", agentPrivateKey: ` ${keyText} `,
    };
    const { logger, warns } = loggerStub();
    reply = (request) => ({ status: 200, body: request.method === "GET" ? [] : { id: "m", written: true, results: [] } });
    const result = await (flairCredentialTest as any).call({}, { data: credentials });
    expect(result.status).toBe("OK");
    expect(result.message).toBe("Signed as agent 'n8n-trimmed'.");
    await run(credentials, logger);
    expect(seen.length).toBeGreaterThan(1);
    for (const request of seen) {
      expectAgentSignature(request.headers.authorization, publicKey, request, "n8n-trimmed");
      const url = new URL(request.url);
      expect(url.searchParams.get("agentId")).toBeOneOf([null, "n8n-trimmed"]);
      if (request.body && request.method === "PUT") expect(JSON.parse(request.body).agentId).toBe("n8n-trimmed");
    }
    expect(warns).toHaveLength(0);
  }, 10_000);
}
