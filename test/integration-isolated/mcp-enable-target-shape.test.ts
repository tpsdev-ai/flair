import { expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tempDir } from "../helpers/temp-dir.ts";
import { enableMcp, generateRsaSigningKeyPair } from "../../src/lib/mcp-enable.ts";

const ISSUER = "https://mcp.acme.example";

async function stub(push = false) {
  const calls: string[] = [];
  const credentials = new Map<string, any>();
  const publicKey = push ? generateRsaSigningKeyPair().publicKey : undefined;
  let pid = 100;
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    calls.push(body.operation ?? req.url!);
    let value: any = {};
    if (req.url === "/.well-known/oauth-authorization-server") {
      value = { issuer: ISSUER, token_endpoint: `${ISSUER}/oauth/mcp/token`,
        client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ["none"] };
    } else if (body.operation === "system_information") {
      value = { system: { hostname: hostname() }, harperdb_processes: { core: [{ pid: ++pid }] } };
    } else if (body.operation === "get_secrets_public_key") {
      if (publicKey) value = { public_key: publicKey };
      else res.statusCode = 404;
    } else if (body.operation === "search_by_value") {
      value = body.table === "hdb_secret" ? [{ name: body.search_value, processEnv: true }] : [{ id: "self" }];
    } else if (body.operation === "search_by_conditions") value = [...credentials.values()];
    else if (body.operation === "upsert") for (const r of body.records) credentials.set(r.id, r);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fetchImpl = ((input: any, init?: RequestInit) => fetch(`${url}${new URL(String(input)).pathname}`, init)) as typeof fetch;
  return { url, calls, fetchImpl, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function fixture(instance: string) {
  const dir = tempDir("flair-2189-http-");
  const config = readFileSync(join(import.meta.dir, "../../config.yaml"), "utf8");
  const localConfigPath = join(dir, "config.yaml");
  writeFileSync(localConfigPath, config);
  return { dir, config, params: {
    instance, issuer: ISSUER, adminUser: "admin", adminPass: "pw",
    idpClientId: "client", idpClientSecret: "secret", idpSubject: "octocat",
    localConfigPath, signingKeyFilePath: join(dir, "key.pem"), secretsStagingPath: join(dir, "secrets.env"),
  } };
}

test("remote URL is refused although the HTTP stub reports this machine's hostname", async () => {
  const s = await stub();
  try {
    const report = await s.fetchImpl(ISSUER, { method: "POST", body: JSON.stringify({ operation: "system_information" }) });
    expect((await report.json()).system.hostname).toBe(hostname());
    s.calls.length = 0;
    const f = fixture(ISSUER);
    const result = await enableMcp({ ...f.params, confirmSecretsApplied: true }, { fetchImpl: s.fetchImpl });
    expect(result.failedStep).toBe("target-shape-check");
    expect(s.calls).toEqual([]);
    expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
    expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
  } finally { await s.close(); }
}, 15000);

test("loopback target with a public issuer sends restart to the stub ops API", async () => {
  const s = await stub();
  try {
    const f = fixture(s.url);
    const result = await enableMcp({ ...f.params, confirmSecretsApplied: true }, { fetchImpl: s.fetchImpl });
    expect(result.ok).toBe(true);
    expect(s.calls.filter(c => c === "restart")).toHaveLength(1);
    expect(result.steps.some(s => s.step === "local-config-update")).toBe(true);
  } finally { await s.close(); }
}, 15000);

for (const instance of [ISSUER, "https://acme.harperfabric.com"]) {
  test(`CIMD Fabric refusal makes no HTTP call: ${instance}`, async () => {
    const s = await stub();
    try {
      const f = fixture(instance);
      const result = await enableMcp({ ...f.params, fabric: instance === ISSUER, cimdAllowedHosts: ["claude.ai"] }, { fetchImpl: s.fetchImpl });
      expect(result.failedStep).toBe("cimd-allowed-hosts");
      expect(s.calls).toEqual([]);
      expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
    } finally { await s.close(); }
  }, 15000);

  test.each([false, true])(`Fabric staging through HTTP: ${instance}, push=%s`, async (push) => {
    const s = await stub(push);
    try {
      const f = fixture(instance);
      let prompt = "";
      const result = await enableMcp({ ...f.params, fabric: instance === ISSUER }, {
        fetchImpl: s.fetchImpl, confirmPrompt: async (message) => { prompt = message; return false; },
      });
      expect(result.failedStep).toBe("secrets-provisioning");
      expect(result.secretsMechanism).toBe("fabric-env-secrets");
      expect(result.secretsPath).toBe(f.params.secretsStagingPath);
      if (push) {
        expect(s.calls.filter(c => c === "set_secret")).toHaveLength(5);
        expect(prompt).toContain("Have you restarted the Fabric instance");
      } else {
        expect(result.steps.find(s => s.step === "secrets-provisioning")!.detail).toContain("Fabric Studio");
      }
      expect(s.calls).not.toContain("restart");
      expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
    } finally { await s.close(); }
  }, 15000);
}
