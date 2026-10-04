import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { NON_CANONICAL_TARGETS, UNSPECIFIED_TARGETS } from "../helpers/mcp-enable-target-shapes.ts";
import { enableMcp, type SecretsMechanism } from "../../src/lib/mcp-enable.ts";

const PUBLIC = "https://mcp.acme.example";
const FABRIC = "https://acme.harperfabric.com";
const LOOPBACK_SPELLINGS = [
  "http://localhost.:9926", "http://LOCALHOST.:9926", "http://sub.localhost.:9926",
  "http://[::ffff:127.0.0.1]:9926", "http://[::ffff:7f00:1]:9926", "http://[0:0:0:0:0:ffff:127.1.2.3]:9926",
];

function fixture(instance = PUBLIC) {
  const dir = tempDir("flair-2189-");
  const config = readFileSync(join(import.meta.dir, "../../config.yaml"), "utf8");
  const localConfigPath = join(dir, "config.yaml");
  writeFileSync(localConfigPath, config);
  return {
    dir, config,
    params: {
      instance, issuer: PUBLIC, adminUser: "admin", adminPass: "pw",
      idpClientId: "client", idpClientSecret: "secret", idpSubject: "octocat",
      localConfigPath, secretsStagingPath: join(dir, "secrets.env"),
    },
  };
}

function targetFetch(push = false) {
  const publicKey = push ? generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey : undefined;
  const calls: string[] = [];
  const credentials = new Map<string, any>();
  const fetchImpl = (async (url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(body.operation ?? String(url));
    if (new URL(String(url)).pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ issuer: PUBLIC, token_endpoint: `${PUBLIC}/oauth/mcp/token`,
        client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ["none"] });
    }
    if (body.operation === "system_information") {
      return Response.json({ system: { hostname: hostname() }, harperdb_processes: { core: [{ pid: process.pid }] } });
    }
    if (body.operation === "get_secrets_public_key") return publicKey ? Response.json({ public_key: publicKey }) : new Response("missing", { status: 404 });
    if (body.operation === "set_secret") return Response.json({});
    if (body.operation === "search_by_value") return Response.json(body.table === "hdb_secret"
      ? [{ name: body.search_value, processEnv: true }] : [{ id: "self" }]);
    if (body.operation === "search_by_conditions") return Response.json([...credentials.values()]);
    if (body.operation === "upsert") {
      for (const r of body.records) credentials.set(r.id, r);
      return Response.json({});
    }
    throw new Error(`Unexpected operation ${body.operation}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("enableMcp target URL and Fabric declaration", () => {
  for (const instance of ["http://127.0.0.1:9926", "http://localhost:9926", "http://[::1]:9926", ...LOOPBACK_SPELLINGS, ...UNSPECIFIED_TARGETS]) {
    test.each([false, true])(`refuses --fabric with local target ${instance} without CIMD (dryRun=%s)`, async (dryRun) => {
      const f = fixture(instance);
      const { calls, fetchImpl } = targetFetch();
      let prompts = 0;
      const result = await enableMcp({ ...f.params, fabric: true, dryRun }, {
        fetchImpl, confirmPrompt: async () => { prompts++; return true; },
      });
      expect(result.failedStep).toBe("target-shape-check");
      expect(result.refused?.message).toContain(NON_CANONICAL_TARGETS.find(([target]) => target === instance)?.[1]
        ? `Use ${new URL(instance).origin}`
        : "--fabric cannot be used with a loopback or unspecified target");
      expect(calls).toEqual([]);
      expect(prompts).toBe(0);
      expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
      expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
    });
  }

  for (const issuer of ["https://[fd00::1]", "https://[fe80::1]", "https://[::ffff:192.168.1.1]", "not a url"]) {
    test.each([false, true])(`refuses issuer ${issuer} before side effects (dryRun=%s)`, async (dryRun) => {
      const f = fixture(FABRIC);
      const { calls, fetchImpl } = targetFetch();
      let prompts = 0;
      const result = await enableMcp({ ...f.params, issuer, dryRun }, {
        fetchImpl, confirmPrompt: async () => { prompts++; return true; },
      });
      expect(result.failedStep).toBe("local-origin-check");
      expect(result.refused).toMatchObject({ reason: issuer === "not a url" ? "invalid" : "local" });
      if (issuer === "not a url") expect(result.refused?.message).not.toContain("local");
      expect(calls).toEqual([]);
      expect(prompts).toBe(0);
      expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
      expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
    });
  }

  for (const [issuer, fabric] of [[undefined, false], [PUBLIC, true]] as const) {
    test.each([false, true])(`canonical remedy takes precedence: issuer=${issuer}, fabric=${fabric}, dryRun=%s`, async (dryRun) => {
      const f = fixture("http://LOCALHOST.:9926");
      const { calls, fetchImpl } = targetFetch();
      let prompts = 0;
      const result = await enableMcp({ ...f.params, issuer, fabric, dryRun }, {
        fetchImpl, confirmPrompt: async () => { prompts++; return true; },
      });
      expect(result.failedStep).toBe("target-shape-check");
      expect(result.refused?.message).toContain("Use http://localhost.:9926");
      expect(calls).toEqual([]);
      expect(prompts).toBe(0);
      expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
      expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
    });
  }

  for (const [instance, canonical] of NON_CANONICAL_TARGETS) {
    test.each([false, true])(`refuses non-canonical ${instance} before writes (dryRun=%s)`, async (dryRun) => {
      const f = fixture(instance);
      const { calls, fetchImpl } = targetFetch();
      let prompts = 0;
      const result = await enableMcp({ ...f.params, dryRun, confirmSecretsApplied: true }, {
        fetchImpl, confirmPrompt: async () => { prompts++; return true; },
      });
      expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
      expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
      expect(result.failedStep).toBe("target-shape-check");
      expect(result.refused?.message).toContain(`Use ${canonical}`);
      expect(result.refused?.message).not.toContain("secret");
      expect(calls).toEqual([]);
      expect(prompts).toBe(0);
    });
  }

  test.each(["http://localhost.:9926", "http://sub.localhost.:9926", "http://[::ffff:7f00:1]:9926", ...UNSPECIFIED_TARGETS])(
    "accepts canonical local origin %s without --fabric in dry run", async (instance) => {
      const f = fixture(new URL(instance).origin);
      const { calls, fetchImpl } = targetFetch();
      const result = await enableMcp({ ...f.params, dryRun: true }, { fetchImpl });
      expect(result.ok).toBe(true);
      expect(calls).toEqual([]);
      expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
    },
  );

  test.each(UNSPECIFIED_TARGETS)("accepts local destination %s through identity mapping without --fabric", async (instance) => {
    const f = fixture(new URL(instance).origin);
    const { fetchImpl } = targetFetch();
    const result = await enableMcp({ ...f.params, confirmSecretsApplied: true }, { fetchImpl });
    expect(result.steps.find(s => s.step === "identity-mapping")?.ok).toBe(true);
    expect(result.steps.map(s => s.step)).not.toContain("target-shape-check");
  });

  test.each([PUBLIC, "https://127.0.0.1.evil.example", "http://10.0.0.1", "http://machine.local"])(
    "refuses non-loopback %s even when its stub reports this machine", async (instance) => {
      const f = fixture(instance);
      const { calls, fetchImpl } = targetFetch();
      let prompts = 0;
      const result = await enableMcp(f.params, { fetchImpl, confirmPrompt: async () => { prompts++; return true; } });
      expect(result.failedStep).toBe("target-shape-check");
      expect(result.refused?.message).toContain("--fabric");
      expect(calls).toEqual([]);
      expect(prompts).toBe(0);
      expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
      expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
    },
  );

  test("refuses a custom remote with CIMD before any network call", async () => {
    const f = fixture();
    const calls: { url: string; authorization: string | null }[] = [];
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") });
      return Response.json({ system: { hostname: "not-this-machine" }, harperdb_processes: { core: [{ pid: process.pid }] } });
    }) as typeof fetch;
    const result = await enableMcp({ ...f.params, cimdAllowedHosts: ["claude.ai"] }, { fetchImpl });
    expect(calls).toEqual([]);
    expect(result.failedStep).toBe("target-shape-check");
    expect(result.refused?.message).toContain("--fabric");
    expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
    expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
  });

  for (const [instance, fabric] of [[PUBLIC, true], [FABRIC, false], ["http://127.0.0.1:9926", true]] as const) {
    test.each([false, true])(`CIMD refusal before side effects: ${instance}, fabric=${fabric}, dryRun=%s`, async (dryRun) => {
      const f = fixture(instance);
      const { calls, fetchImpl } = targetFetch();
      let prompts = 0;
      const result = await enableMcp({ ...f.params, fabric, dryRun, cimdAllowedHosts: ["claude.ai"] }, {
        fetchImpl, confirmPrompt: async () => { prompts++; return true; },
      });
      const loopbackFabric = instance === "http://127.0.0.1:9926";
      expect(result.failedStep).toBe(loopbackFabric ? "target-shape-check" : "cimd-allowed-hosts");
      expect(result.refused?.message).toContain(loopbackFabric
        ? "--fabric cannot be used with a loopback or unspecified target" : "refused for a Fabric instance");
      expect(calls).toEqual([]);
      expect(prompts).toBe(0);
      expect(readdirSync(f.dir)).toEqual(["config.yaml"]);
      expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
    });
  }

  for (const [instance, fabric] of [[PUBLIC, true], [FABRIC, false]] as const) {
    test.each([false, true])(`Fabric staging and confirmation: ${instance}, push=%s`, async (push) => {
      const f = fixture(instance);
      const { calls, fetchImpl } = targetFetch(push);
      let prompt = "";
      const result = await enableMcp({ ...f.params, fabric }, {
        fetchImpl, confirmPrompt: async (message) => { prompt = message; return false; },
      });
      expect(result.failedStep).toBe("secrets-provisioning");
      expect(result.secretsMechanism).toBe("fabric-env-secrets");
      expect(result.secretsPath).toBe(f.params.secretsStagingPath);
      expect(readFileSync(f.params.secretsStagingPath, "utf8")).toContain(`FLAIR_MCP_ISSUER=${PUBLIC}`);
      const detail = result.steps.find(s => s.step === "secrets-provisioning")!.detail;
      if (push) {
        expect(calls.filter(c => c === "set_secret")).toHaveLength(5);
        expect(prompt).toContain("Have you restarted the Fabric instance to load them?");
        expect(result.steps.at(-1)!.detail).toContain("restart the Fabric instance");
      } else {
        expect(calls).not.toContain("set_secret");
        expect(detail).toContain("Fabric Studio");
        expect(detail).not.toContain("systemd/launchd");
        expect(prompt).toContain(f.params.secretsStagingPath);
      }
      expect(calls).not.toContain("restart");
      expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
    });

    test.each(["env-file", "fabric-env-secrets"] as SecretsMechanism[])(`explicit mechanism preserved: ${instance}, %s`, async (secretsMechanism) => {
      const f = fixture(instance);
      const { calls, fetchImpl } = targetFetch();
      const result = await enableMcp({ ...f.params, fabric, secretsMechanism, confirmSecretsApplied: true }, { fetchImpl });
      expect(result.ok).toBe(true);
      expect(result.secretsMechanism).toBe(secretsMechanism);
      expect(result.steps.some(s => s.step === "fabric-operator-deploy")).toBe(true);
      expect(calls).not.toContain("get_secrets_public_key");
      expect(calls).not.toContain("restart");
      expect(readFileSync(f.params.localConfigPath, "utf8")).toBe(f.config);
    });
  }
});
