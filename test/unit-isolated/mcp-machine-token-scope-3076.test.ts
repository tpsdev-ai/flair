// mcp-machine-token-scope-3076.test.ts — a machine client's token carries the
// scope Flair's client metadata document declares, and /mcp serves it
// (flair#3076).
//
// In process: Flair's real document (buildCimdDocument) and client assertion
// (signClientAssertion) go through @harperfast/oauth's real token handler
// (handleToken, client_credentials). The minted access token is then presented
// to Flair's real mounted /mcp listener (registerMcpOAuthRoute with the real
// withMCPAuth) in front of the real mcpHandler. Faked: the Harper tables and
// the network transport of the document fetch.
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

const savedEnv = { ...process.env };
const ISSUER = "https://machine-token.flair.test";
process.env.FLAIR_MCP_NO_AUTOSTART = "1";
process.env.FLAIR_MCP_OAUTH = "true";
process.env.FLAIR_MCP_ISSUER = ISSUER;

const AGENT = "agent-a";
const CLIENT_ID = `${ISSUER}/MCPClientMetadata/${AGENT}`;

// The flair tables the /mcp handler reads: the client's subject maps to AGENT.
const credentials = [{ id: "cred-agent-a", principalId: AGENT, kind: "idp", idpSubject: CLIENT_ID, status: "active" }];
const flair = {
  Credential: {
    async *search(q: any) {
      for (const c of credentials) {
        if ((q?.conditions ?? []).every((x: any) => (c as any)[x.attribute] === x.value)) yield c;
      }
    },
    async get(id: string) { return credentials.find((c) => c.id === id) ?? null; },
    async patch() {},
  },
  Agent: { async get(id: string) { return id === AGENT ? { id, kind: "agent", status: "active" } : null; } },
};
mock.module("harper", () => ({
  Resource: class {},
  server: {},
  databases: { flair },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { handleToken } = await import("../../node_modules/@harperfast/oauth/dist/lib/mcp/token.js");
const { _setDnsLookup, _setFetch, _clearCimdCache } = await import("../../node_modules/@harperfast/oauth/dist/lib/mcp/cimd.js");
const { resetMCPKeysTableCache } = await import("../../node_modules/@harperfast/oauth/dist/lib/mcp/keyStore.js");
const { resetMCPAssertionJtisTableCache } = await import("../../node_modules/@harperfast/oauth/dist/lib/mcp/assertionJtiStore.js");
const { buildCimdDocument } = await import("../../resources/mcp-client-metadata-fields.ts");
const { publicJwkFromPrivateKey, signClientAssertion } = await import("../../src/mcp-client-assertion.ts");
const { registerMcpOAuthRoute } = await import("../../resources/mcp-oauth.ts");
const { mcpHandler } = await import("../../resources/mcp-handler.ts");
const { __setHandlers } = await import("../../resources/mcp-tools.ts");

// memory_store's delegated handler: records the call instead of writing.
let stored: { agentId: unknown; content: unknown } | null = null;
const restoreHandlers = __setHandlers({
  Memory: class {
    #collection = false;
    _ctx: any;
    constructor(_id: any, ctx: any) { this._ctx = ctx; }
    get isCollection() { return this.#collection; }
    static getResource(_t: any, ctx: any, options?: any) {
      const r: any = new (this as any)(undefined, ctx);
      if (options?.isCollection) r.#collection = true;
      return r;
    }
    async post(body: any) {
      stored = { agentId: this._ctx?.request?.tpsAgent, content: body?.content };
      return { id: "stored-1", written: true, deduplicated: false };
    }
  },
});

afterEach(() => {
  _clearCimdCache();
  _setDnsLookup(undefined as any);
  _setFetch(undefined as any);
});
afterAll(() => {
  restoreHandlers();
  process.env = savedEnv;
  resetMCPKeysTableCache();
  resetMCPAssertionJtisTableCache();
  delete (globalThis as any).databases;
});

function jwtPayload(token: string): any {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

test("a client_credentials token minted from Flair's document carries its scope, and /mcp serves it", async () => {
  // The plugin's own tables, read through the Harper global.
  const keys = new Map<string, any>();
  const jtis = new Map<string, any>();
  (globalThis as any).databases = { oauth: {
    harper_oauth_mcp_keys: { async put(row: any) { keys.set(row.kid, row); }, async *search() { yield* keys.values(); } },
    mcp_assertion_jtis: {
      async get(id: string) { return jtis.get(id) ?? null; },
      async patch(id: string, row: any) { jtis.set(id, { ...row, uses: (jtis.get(id)?.uses ?? 0) + row.uses.value }); },
    },
  } };
  resetMCPKeysTableCache();
  resetMCPAssertionJtisTableCache();

  const { privateKey } = generateKeyPairSync("ed25519");
  const doc = buildCimdDocument({ clientId: CLIENT_ID, clientName: AGENT, jwk: publicJwkFromPrivateKey(privateKey) });
  _setDnsLookup(async () => [{ address: "8.8.8.8", family: 4 }]);
  _setFetch(async (url: string) => {
    expect(url).toBe(CLIENT_ID);
    return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: new Response(JSON.stringify(doc)).body };
  });

  const mcpConfig = {
    enabled: true,
    issuer: ISSUER,
    resource: `${ISSUER}/mcp`,
    clientCredentials: { enabled: true },
    clientIdMetadataDocuments: { allowedHosts: ["machine-token.flair.test"] },
  };
  const { assertion } = signClientAssertion({ clientId: CLIENT_ID, tokenEndpoint: `${ISSUER}/oauth/mcp/token`, privateKey });
  const minted = await handleToken({ headers: {} } as any, {
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  }, mcpConfig);
  expect(minted.status, JSON.stringify(minted.body)).toBe(200);
  const accessToken = minted.body.access_token as string;
  expect(jwtPayload(accessToken).scope).toBe("memory:read memory:write principal:read");
  expect(jwtPayload(accessToken).sub).toBe(CLIENT_ID);

  // The token on Flair's mounted /mcp listener, real withMCPAuth in front of the real handler.
  let listener: (request: any, next: () => any) => Promise<any> = async () => { throw new Error("/mcp was not mounted"); };
  const mounted = await registerMcpOAuthRoute({
    skipComponentGuard: true,
    server: { http(handler: any) { listener = handler; } },
    mcpHandler,
    harper: { server: { resources: { get: () => ({ Resource: { mcpConfig }, path: "oauth", exportTypes: {}, hasSubPaths: false, relativeURL: "" }) } } } as any,
  });
  expect(mounted).toBe(true);
  const res: any = await listener({
    method: "POST",
    pathname: "/mcp",
    headers: { authorization: `Bearer ${accessToken}` },
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_store", arguments: { content: "machine write" } } }),
  }, () => ({ status: 404 }));
  const status: number = res.status;
  const text = String(res.body);
  expect(status, text).toBe(200);
  expect(JSON.parse(text).error, text).toBeUndefined();
  expect(stored).toEqual({ agentId: AGENT, content: "machine write" });
});
