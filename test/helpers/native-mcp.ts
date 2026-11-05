/**
 * An MCP client session on Harper's native MCP route, for the integration
 * tests that start a test-Harper with `mcp.application` configured
 * (test/integration/table-subscription-mcp.test.ts,
 * test/integration/native-mcp-application-tools.test.ts). It sends JSON-RPC
 * over HTTP POST with the caller's Authorization header, keeps the session id
 * Harper returns, and reads the session's SSE stream.
 */
import { expect } from "bun:test";

export interface RpcReply { status: number; session: string | null; text: string; body: any }

/** One MCP client session on Harper's native MCP route, with its SSE stream. */
export class McpSession {
  id: string | null = null;
  private nextId = 1;
  private streamText = "";
  private streamStatus: number | undefined;
  private ctrl = new AbortController();
  private pump: Promise<void> | undefined;

  constructor(private url: string, private authorization: string) {}

  async rpc(method: string, params?: unknown, notification = false): Promise<RpcReply> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: this.authorization,
    };
    if (this.id) headers["Mcp-Session-Id"] = this.id;
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    if (!notification) message.id = this.nextId++;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(message) });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: res.status, session: res.headers.get("mcp-session-id"), text, body };
  }

  async open(): Promise<void> {
    const init = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flair-test", version: "1" } });
    expect(init.status, init.text.slice(0, 300)).toBe(200);
    expect(init.body?.result?.capabilities?.resources?.subscribe, "Harper advertises resources/subscribe").toBe(true);
    this.id = init.session;
    expect(this.id, "initialize returns an Mcp-Session-Id").toBeTruthy();
    expect((await this.rpc("notifications/initialized", undefined, true)).status).toBe(202);
    this.pump = (async () => {
      try {
        const res = await fetch(this.url, {
          headers: { Accept: "text/event-stream", Authorization: this.authorization, "Mcp-Session-Id": this.id! },
          signal: this.ctrl.signal,
        });
        this.streamStatus = res.status;
        if (!res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.streamText += dec.decode(value, { stream: true });
        }
      } catch { /* aborted by close() */ }
    })();
    const deadline = Date.now() + 10_000;
    while (!this.streamText.includes("mcp stream open") && Date.now() < deadline) await Bun.sleep(50);
    expect(this.streamStatus, "the session's SSE stream opens").toBe(200);
    expect(this.streamText).toContain("mcp stream open");
  }

  /** Every resource `resources/list` advertises, across pages. */
  async listResources(): Promise<Array<{ uri: string; name: string }>> {
    const out: Array<{ uri: string; name: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const reply = await this.rpc("resources/list", cursor ? { cursor } : {});
      expect(reply.status, reply.text.slice(0, 300)).toBe(200);
      out.push(...(reply.body?.result?.resources ?? []));
      cursor = reply.body?.result?.nextCursor;
      if (!cursor) return out;
    }
    throw new Error("resources/list did not finish within 100 pages");
  }

  /** Every tool `tools/list` advertises to this session, by name, across pages. */
  async listToolNames(): Promise<Set<string>> {
    const out = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const reply = await this.rpc("tools/list", cursor ? { cursor } : {});
      expect(reply.status, reply.text.slice(0, 300)).toBe(200);
      for (const tool of reply.body?.result?.tools ?? []) out.add(tool.name);
      cursor = reply.body?.result?.nextCursor;
      if (!cursor) return out;
    }
    throw new Error("tools/list did not finish within 100 pages");
  }

  /** `tools/call` for the tool named, whether or not `tools/list` advertised it to this session. */
  callTool(name: string, args: Record<string, unknown>): Promise<RpcReply> {
    return this.rpc("tools/call", { name, arguments: args });
  }

  stream(): string { return this.streamText; }

  async close(): Promise<void> {
    this.ctrl.abort();
    await this.pump;
  }
}
