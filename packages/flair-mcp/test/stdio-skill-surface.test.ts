import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER_TOOL_NAMES } from "../src/adapter-surface.ts";

/**
 * flair#1575 — "shipped ≠ reachable" smoke.
 *
 * The probe that caught the gap: spawn the stdio adapter, MCP handshake,
 * tools/list → skill_* were absent. Server/registry unit tests never touch
 * this process. This file is that probe, plus tools/call so "present" is
 * not enough — the handlers must be callable.
 *
 * A tiny HTTP stand-in plays the Flair daemon so the calls exercise the
 * adapter's FlairClient forwards (not a live Harper). Progressive disclosure
 * is asserted here: skill_search must not leak `content` even when the
 * stand-in returns a full memory row. skill_get must not leak the
 * embedding vector even when GET /Memory returns one (flair#1579).
 */

const PKG = join(import.meta.dir, "..");
const ENTRY = join(PKG, "src", "index.ts");

const AGENT = "stdio-skill-smoke";
const stored = new Map<string, Record<string, unknown>>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

let server: Server;
let mockUrl: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  expect(existsSync(ENTRY), `stdio adapter entry must exist: ${ENTRY}`).toBe(true);

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stdio-skill-mock.local");
    const method = req.method ?? "GET";
    try {
      if (method === "PUT" && url.pathname.startsWith("/Memory/")) {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        const id = typeof body.id === "string" ? body.id : url.pathname.slice("/Memory/".length);
        const record = { ...body, id, written: true };
        stored.set(id, record);
        json(res, 200, record);
        return;
      }
      if (method === "GET" && url.pathname.startsWith("/Memory/")) {
        const id = decodeURIComponent(url.pathname.slice("/Memory/".length));
        const record = stored.get(id);
        if (!record) {
          json(res, 404, { error: "not found" });
          return;
        }
        // Raw Memory GET includes the vector — skill_get must strip it
        // (flair#1579). The store path does not write these fields.
        json(res, 200, {
          ...record,
          embedding: [0.11, 0.22, 0.33],
          embeddingModel: "mock-embed",
        });
        return;
      }
      if (method === "POST" && url.pathname === "/SemanticSearch") {
        const results = [...stored.values()].map((row) => ({
          ...row,
          content: row.content ?? "THE FULL PROCEDURE — must not appear on the catalog",
          embedding: [0.1, 0.2],
          embeddingModel: "mock",
        }));
        json(res, 200, { results });
        return;
      }
      if (method === "POST" && url.pathname === "/Presence") {
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { error: `unhandled ${method} ${url.pathname}` });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock server did not bind a TCP port");
  mockUrl = `http://127.0.0.1:${addr.port}`;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: PKG,
    stderr: "pipe",
    env: {
      ...getDefaultEnvironment(),
      FLAIR_AGENT_ID: AGENT,
      FLAIR_URL: mockUrl,
      FLAIR_MCP_PARENT_POLL_MS: "30000",
    },
  });
  client = new Client({ name: "stdio-skill-surface-test", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("stdio adapter smoke — handshake + tools/list + skill_* callable (flair#1575)", () => {
  test("initialize reports the flair server", () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe("flair");
    expect(info?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("tools/list exposes skill_store / skill_search / skill_get and matches ADAPTER_TOOL_NAMES", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual([...ADAPTER_TOOL_NAMES].sort());
    for (const name of ["skill_store", "skill_search", "skill_get"]) {
      expect(names, `tools/list must include ${name} — this is the probe that caught flair#1575`).toContain(name);
    }
    const skillGet = listed.tools.find((t) => t.name === "skill_get");
    const props = (skillGet?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    expect(
      props,
      "skill_get must not advertise includeEmbedding — the vector is never returned (flair#1579)",
    ).not.toHaveProperty("includeEmbedding");
  });

  test("skill_store / skill_search / skill_get are callable over stdio", async () => {
    const storedCall = await client.callTool({
      name: "skill_store",
      arguments: {
        content: "1. Convert to sRGB.\n2. Resize to max 1600px.",
        trigger: "when resizing an image before upload",
        name: "resize-image",
        description: "Resize an image to a max dimension",
        tags: ["images"],
      },
    });
    expect(storedCall.isError).toBeFalsy();
    const storeText = (storedCall.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(storeText).toContain("Skill stored");
    const storeId = (storedCall.structuredContent as { id?: string } | undefined)?.id;
    expect(storeId).toBeTruthy();

    const searchCall = await client.callTool({
      name: "skill_search",
      arguments: { task: "resize an image before upload", limit: 5 },
    });
    expect(searchCall.isError).toBeFalsy();
    const cards = (searchCall.structuredContent as { results?: Array<Record<string, unknown>> } | undefined)?.results ?? [];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]?.id).toBe(storeId);
    expect(cards[0]?.name).toBe("resize-image");
    expect("content" in (cards[0] ?? {})).toBe(false);
    expect("embedding" in (cards[0] ?? {})).toBe(false);
    const searchText = (searchCall.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(searchText).not.toContain("1. Convert to sRGB");

    const getCall = await client.callTool({
      name: "skill_get",
      arguments: { id: storeId },
    });
    expect(getCall.isError).toBeFalsy();
    const getText = (getCall.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(getText).toContain("1. Convert to sRGB");
    const got = getCall.structuredContent as Record<string, unknown> | undefined;
    expect(got?.content).toBe("1. Convert to sRGB.\n2. Resize to max 1600px.");
    expect("embedding" in (got ?? {}), "skill_get strips embedding even when GET /Memory returns the vector").toBe(false);
    expect("embeddingModel" in (got ?? {})).toBe(false);
  });

  test("skill_get never returns embedding even if includeEmbedding is passed (flair#1579)", async () => {
    stored.set("sk-embed-footgun", {
      id: "sk-embed-footgun",
      agentId: AGENT,
      content: "THE PROCEDURE — keep this, drop the vector",
      tags: ["skill"],
      trigger: "when testing the embedding strip",
    });
    const getCall = await client.callTool({
      name: "skill_get",
      arguments: { id: "sk-embed-footgun", includeEmbedding: true },
    });
    expect(getCall.isError).toBeFalsy();
    const got = getCall.structuredContent as Record<string, unknown> | undefined;
    expect(got?.content).toBe("THE PROCEDURE — keep this, drop the vector");
    expect("embedding" in (got ?? {})).toBe(false);
    expect("embeddingModel" in (got ?? {})).toBe(false);
    const text = (getCall.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(text).toContain("THE PROCEDURE");
    expect(text).not.toContain("0.11");
  });

  test("skill_get on a non-skill id is not-found (not an alias for memory_get)", async () => {
    stored.set("mem-ordinary", {
      id: "mem-ordinary",
      agentId: AGENT,
      content: "an ordinary memory",
      tags: ["lesson"],
    });
    const getCall = await client.callTool({
      name: "skill_get",
      arguments: { id: "mem-ordinary" },
    });
    expect(getCall.isError).toBeFalsy();
    const text = (getCall.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(text).toContain("not found");
    expect(text).not.toContain("an ordinary memory");
  });
});
