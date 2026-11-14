import { afterEach, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

const publicJwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
const getAgent = mock(async (_id: string) => ({
  name: "CIMD fallback agent",
  publicKey: Buffer.from(publicJwk.x!, "base64url").toString("base64"),
}));
mock.module("harper", () => ({
  Resource: class {},
  databases: { flair: { Agent: { get: getAgent } } },
}));
const { MCPClientMetadata } = await import("../../resources/MCPClientMetadata.ts");
const savedIssuer = process.env.FLAIR_MCP_ISSUER;
const savedPublicUrl = process.env.FLAIR_PUBLIC_URL;
afterEach(() => {
  if (savedIssuer === undefined) delete process.env.FLAIR_MCP_ISSUER;
  else process.env.FLAIR_MCP_ISSUER = savedIssuer;
  if (savedPublicUrl === undefined) delete process.env.FLAIR_PUBLIC_URL;
  else process.env.FLAIR_PUBLIC_URL = savedPublicUrl;
});

test("CIMD get uses FLAIR_PUBLIC_URL when FLAIR_MCP_ISSUER is unset", async () => {
  delete process.env.FLAIR_MCP_ISSUER;
  process.env.FLAIR_PUBLIC_URL = "https://cimd-public.example/";
  const resource = Object.create(MCPClientMetadata.prototype) as InstanceType<typeof MCPClientMetadata>;
  const response = await resource.get("cimd-fallback-agent");
  expect(response.status).toBe(200);
  const metadata = await response.json();
  expect(getAgent).toHaveBeenCalledWith("cimd-fallback-agent");
  expect(metadata.client_id).toBe("https://cimd-public.example/MCPClientMetadata/cimd-fallback-agent");
  expect(metadata.client_name).toBe("CIMD fallback agent");
  expect(metadata.jwks.keys).toEqual([{
    kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid: "cimd-fallback-agent",
  }]);
});
