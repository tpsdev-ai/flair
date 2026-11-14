// MCP OAuth route registration.

import { mock, describe, it, expect, beforeEach, spyOn } from "bun:test";
import { expandEnvVarsDeep, normalizeMcpSecurityConfig } from "../../node_modules/@harperfast/oauth/dist/lib/config.js";
import { runInNewContext } from "node:vm";
import type * as Harper from "../../node_modules/harper/dist/index.js";

type HarperRegistryMock = {
  [K in keyof Pick<typeof Harper, "server">]: {
    [R in keyof Pick<typeof Harper.server, "resources">]: Pick<typeof Harper.server.resources, "get">;
  };
};

// Suppress the module-level auto-registration on import — we call
// registerMcpOAuthRoute() directly with injected deps.
process.env.FLAIR_MCP_NO_AUTOSTART = "1";

// A complete-enough harper mock: `server` (what mcp-oauth.ts reads) PLUS
// `Resource` + `databases` so that if the real mcp-handler → mcp-tools → resource
// import graph loads under this mock (module-cache ordering in the full suite),
// it still links. `mock.module` is process-global in bun, so a superset mock is
// the safe shape.
class NoopBase { constructor(_id?: any, _ctx?: any) {} }
const dbStub = new Proxy({}, { get: () => new Proxy({}, { get: () => NoopBase }) });
mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: NoopBase,
  databases: { flair: dbStub },
}));
// NO mock.module for ./mcp-handler.ts: mcp-oauth.ts no longer statically imports
// it (it's resolved lazily / via deps.mcpHandler), so loading mcp-oauth.ts here
// doesn't pull in the resource graph and there's nothing to stub for link-time.
// The handler is injected via deps.mcpHandler in makeDeps() below. Crucially,
// this file must NOT process-globally mock a module that mcp-handler.test.ts
// legitimately `await import(...)`s for real — that was the source of the
// intermittent "35 tests failed" flake in mcp-handler.test.ts.

const { registerMcpOAuthRoute, mcpRouteState, rateLimitedMcpHandler, readEffectiveMcpEnabled } = await import("../../resources/mcp-oauth.ts");
const { __resetBucketsForTest } = await import("../../resources/rate-limit.ts");
const { MULTI_WORKER_GUARD_HTTP_NAME } = await import("../../resources/multi-worker-guard.ts");

const ENV = ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "FLAIR_PUBLIC_URL"];
function clearEnv() { for (const k of ENV) delete process.env[k]; }

let httpCalls: { handler: any; options: any }[];
let withMCPAuthCalls: { handler: any; options: any }[];
let loadCount: number;

function makeDeps() {
  httpCalls = [];
  withMCPAuthCalls = [];
  loadCount = 0;
  return {
    server: { http: (handler: any, options: any) => { httpCalls.push({ handler, options }); } },
    loadWithMCPAuth: async () => {
      loadCount++;
      return (handler: any, options: any) => {
        withMCPAuthCalls.push({ handler, options });
        return { __wrapped: true, handler, options };
      };
    },
    // Inject the /mcp handler directly (replaces the old process-global
    // mock.module of ./mcp-handler.ts) — same shape the mock used to return.
    mcpHandler: () => ({ status: 200 }),
    // Skip the boot guard in existing tests: they use a Harper mock that
    // doesn't exercise the real config.yaml path. The guard is tested
    // explicitly in the "flair#1021 boot guard" describe block below.
    skipComponentGuard: true,
    harper: { server: { resources: { get: () => ({
      Resource: { mcpConfig: { enabled: true } }, path: "oauth", exportTypes: {}, hasSubPaths: false, relativeURL: "",
    }) } } } satisfies HarperRegistryMock,
  };
}

beforeEach(clearEnv);

describe("registerMcpOAuthRoute — flag-OFF no-op", () => {
  it("flag OFF → server.http NEVER called, plugin NEVER loaded, returns false", async () => {
    clearEnv();
    const deps = makeDeps();
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(false);
    expect(httpCalls).toHaveLength(0);
    expect(loadCount).toBe(0); // the oauth plugin is not even imported when off
  });

  it("flag ON but no issuer → NOT mounted (no floating iss), returns false", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    const deps = makeDeps();
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(false);
    expect(httpCalls).toHaveLength(0);
    expect(loadCount).toBe(0); // bails before loading the plugin
  });

  it("flag ON + issuer → withMCPAuth(handler) mounted on urlPath '/mcp'", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const deps = makeDeps();
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(true);
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0].options).toEqual({ urlPath: "/mcp", after: MULTI_WORKER_GUARD_HTTP_NAME });
    // The registered handler is the withMCPAuth-wrapped one.
    expect(httpCalls[0].handler.__wrapped).toBe(true);
    // getConfig pins iss/resource for the wrapper.
    expect(withMCPAuthCalls).toHaveLength(1);
    const cfg = withMCPAuthCalls[0].options.getConfig();
    expect(cfg).toEqual({
      enabled: true,
      issuer: "https://flair.example.com",
      resource: "https://flair.example.com/mcp",
    });
  });

  it("the handler handed to withMCPAuth is the RATE-LIMITED one, not the bare handler", async () => {
    // The wrapper has to sit INSIDE withMCPAuth so it can key on the verified
    // token subject. If a future edit passes `handler` straight through, /mcp
    // goes back to being unthrottled for anyone holding a valid token — with no
    // other symptom. This asserts the composition, so that edit fails here.
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const deps = makeDeps();
    await registerMcpOAuthRoute(deps);
    expect(withMCPAuthCalls[0].handler).not.toBe(deps.mcpHandler);
  });
});

describe("rateLimitedMcpHandler", () => {
  const MCP_ENV = ["FLAIR_MCP_RATE_LIMIT", "FLAIR_RATE_LIMIT"];
  let savedMcpEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    __resetBucketsForTest();
    savedMcpEnv = {};
    for (const k of MCP_ENV) { savedMcpEnv[k] = process.env[k]; delete process.env[k]; }
  });

  const restore = () => {
    for (const k of MCP_ENV) {
      if (savedMcpEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedMcpEnv[k];
    }
  };

  const call = (sub: string) => ({ mcp: { sub, client_id: "cid" }, ip: "203.0.113.7" });

  it("POSITIVE CONTROL: calls under the limit reach the real handler", async () => {
    process.env.FLAIR_MCP_RATE_LIMIT = "3";
    let reached = 0;
    const wrapped = rateLimitedMcpHandler(async () => { reached++; return { status: 200 }; });
    for (let i = 0; i < 3; i++) expect((await wrapped(call("s1"))).status).toBe(200);
    expect(reached).toBe(3);
    restore();
  });

  it("over the limit it returns 429 and the real handler is NEVER invoked", async () => {
    process.env.FLAIR_MCP_RATE_LIMIT = "2";
    let reached = 0;
    const wrapped = rateLimitedMcpHandler(async () => { reached++; return { status: 200 }; });
    for (let i = 0; i < 2; i++) await wrapped(call("s1"));
    const res = await wrapped(call("s1"));
    expect(res.status).toBe(429);
    expect(reached).toBe(2); // the tool surface was not touched by the rejected call
    restore();
  });

  it("a different verified subject is unaffected by another's exhausted budget", async () => {
    process.env.FLAIR_MCP_RATE_LIMIT = "2";
    const wrapped = rateLimitedMcpHandler(async () => ({ status: 200 }));
    for (let i = 0; i < 3; i++) await wrapped(call("s1"));
    expect((await wrapped(call("s1"))).status).toBe(429);
    expect((await wrapped(call("s2"))).status).toBe(200);
    restore();
  });
});

/**
 * flair#1001 — the router publishes what it decided, so consumers that describe
 * the surface (the admin Endpoints table) never have to re-read the flag and
 * cannot disagree with the routing decision. These assertions pin the recorded
 * state to the same branch that produced the `mounted` return value.
 */
describe("mcpRouteState — the router's own record of the mount decision", () => {
  it("flag OFF → not mounted, and the status names the flag that would enable it", async () => {
    clearEnv();
    await registerMcpOAuthRoute(makeDeps());
    const state = mcpRouteState();
    expect(state.mounted).toBe(false);
    expect((state as any).status).toBe("Not enabled");
    expect((state as any).reason).toContain("FLAIR_MCP_OAUTH");
  });

  it("flag ON but no issuer → still not mounted, and the reason names the issuer variable", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    await registerMcpOAuthRoute(makeDeps());
    const state = mcpRouteState();
    // The flag alone is not enough — this is why a consumer re-reading
    // FLAIR_MCP_OAUTH would still advertise a /mcp that 404s.
    expect(state.mounted).toBe(false);
    expect((state as any).reason).toContain("FLAIR_MCP_ISSUER");
  });

  it("flag ON + issuer → mounted, matching the route that was actually registered", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    await registerMcpOAuthRoute(makeDeps());
    expect(mcpRouteState().mounted).toBe(true);
    expect(httpCalls[0].options).toEqual({ urlPath: "/mcp", after: MULTI_WORKER_GUARD_HTTP_NAME });
  });

  it("the recorded state always agrees with the returned mounted value", async () => {
    for (const env of [
      {},
      { FLAIR_MCP_OAUTH: "1" },
      { FLAIR_MCP_OAUTH: "1", FLAIR_MCP_ISSUER: "https://flair.example.com" },
      { FLAIR_MCP_OAUTH: "off", FLAIR_MCP_ISSUER: "https://flair.example.com" },
    ] as Array<Record<string, string>>) {
      clearEnv();
      Object.assign(process.env, env);
      const mounted = await registerMcpOAuthRoute(makeDeps());
      expect(mcpRouteState().mounted).toBe(mounted);
    }
    clearEnv();
  });
});

describe("effective mcp.enabled matches the installed component", () => {
  it.each([
    ...["true", " TRUE ", "TRUE", "false", "1", "yes", "", undefined, null, true, false]
      .map(value => ({ value, env: undefined })),
    ...["true", " TRUE ", "1", undefined]
      .map(env => ({ value: "${FLAIR_MCP_OAUTH}", env })),
  ])("normalizes %p", ({ value, env }) => {
    if (env !== undefined) process.env.FLAIR_MCP_OAUTH = env;
    const componentConfig = expandEnvVarsDeep({ enabled: value });
    normalizeMcpSecurityConfig(componentConfig);
    const read = readEffectiveMcpEnabled({ mcp: { enabled: value } });
    expect(read.kind).toBe("bool");
    expect(read.kind === "bool" && read.enabled).toBe(componentConfig.enabled === true);
  });
});

/**
 * flair#1021 — boot guard: FLAIR_MCP_OAUTH=on with no @harperfast/oauth
 * component in config.yaml must FAIL LOUDLY at boot, not silently degrade.
 *
 * These tests inject a mock harper namespace via deps.harper so they don't
 * depend on process-global mock.module ordering (bun's mock.module is not
 * isolated per test file — the first mock wins, and 26 other test files also
 * mock harper).
 */
describe("flair#1021 — boot guard (loud failure when flag on but component absent)", () => {
  /** Build a mock harper namespace with the given component config. */
  function mockHarper(componentConfig: Record<string, any> | null) {
    return {
      app: {
        config: {
          get: (key: string) => key === "@harperfast/oauth" ? componentConfig : undefined,
        },
      },
    };
  }

  it("flag ON + component absent → throws with actor/state/remedy in the message", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper(null); // component absent
    await expect(registerMcpOAuthRoute(deps)).rejects.toThrow(
      /FLAIR_MCP_OAUTH is enabled.*@harperfast\/oauth.*config\.yaml/i,
    );
  });

  it.each([
    { label: "public URL without MCP issuer", issuer: undefined, publicUrl: "https://flair.example.com" },
    { label: "path-bearing MCP issuer", issuer: "https://flair.example.com/wrong-path", publicUrl: undefined },
    { label: "literal component issuer overrides valid env", issuer: "https://flair.example.com", publicUrl: undefined,
      configured: "https://flair.example.com/wrong-path" },
    ...["https://user:pass@flair.example.com", "https://flair.example.com?x=1",
      "https://flair.example.com#fragment", "ftp://flair.example.com", "${UNSET_MCP_ISSUER}"]
      .map(issuer => ({ label: issuer, issuer, publicUrl: undefined })),
  ])("refuses $label before mounting with an issuer remedy", async (fixture) => {
    process.env.FLAIR_MCP_OAUTH = "true";
    if (fixture.issuer !== undefined) process.env.FLAIR_MCP_ISSUER = fixture.issuer;
    if (fixture.publicUrl !== undefined) process.env.FLAIR_PUBLIC_URL = fixture.publicUrl;
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper({ mcp: {
      enabled: "${FLAIR_MCP_OAUTH}",
      issuer: "configured" in fixture ? fixture.configured : "${FLAIR_MCP_ISSUER}",
    } });
    await expect(registerMcpOAuthRoute(deps)).rejects.toThrow(
      /Refusing to mount \/mcp\. Set FLAIR_MCP_ISSUER to an absolute http\(s\) origin without a path, query, fragment or userinfo/,
    );
    expect(httpCalls).toHaveLength(0);
  });

  it("names the issuer variable and failed rule without disclosing its value", async () => {
    process.env.FLAIR_MCP_OAUTH = "true";
    const canary = "canary-7f3a9c";
    const value = `https://${canary}.example/path?k=${canary}`;
    const previous = process.env.SOME_CANARY_VAR;
    process.env.SOME_CANARY_VAR = value;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper({ mcp: { enabled: true, issuer: "${SOME_CANARY_VAR}" } });
    try {
      const error = await registerMcpOAuthRoute(deps).then(() => null, error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(canary);
      expect(error.message).not.toContain(value);
      expect(error.message).toContain("SOME_CANARY_VAR");
      expect(error.message).toContain("has a path");
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).not.toContain(canary);
      expect(logged).not.toContain(value);
      expect(httpCalls).toHaveLength(0);
    } finally {
      errors.mockRestore();
      if (previous === undefined) delete process.env.SOME_CANARY_VAR;
      else process.env.SOME_CANARY_VAR = previous;
    }
  });

  it.each([
    { issuer: "canary-relative", rule: "not absolute" },
    { issuer: "ftp://canary.example", rule: "not http/https" },
    { issuer: "https://canary.example/path", rule: "has a path" },
    { issuer: "https://canary.example?k=secret", rule: "has a query/hash" },
    { issuer: "https://canary.example#secret", rule: "has a query/hash" },
    { issuer: "https://secret@canary.example", rule: "has userinfo" },
  ])("names the failed rule $rule for a literal issuer", async ({ issuer, rule }) => {
    process.env.FLAIR_MCP_OAUTH = "true";
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper({ mcp: { enabled: true, issuer } });
    const error = await registerMcpOAuthRoute(deps).then(() => null, error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`(${rule})`);
    expect(error.message).not.toContain(issuer);
    expect(httpCalls).toHaveLength(0);
  });

  it.each(["https://flair.example.com?", "https://flair.example.com#", "https://flair.example.com/?"]
    .flatMap(issuer => [false, true].map(envRef => ({ issuer, envRef }))))(
    "refuses empty issuer delimiters: $issuer (env reference: $envRef)", async ({ issuer, envRef }) => {
      process.env.FLAIR_MCP_OAUTH = "true";
      process.env.FLAIR_MCP_ISSUER = issuer;
      const deps = makeDeps();
      delete (deps as any).skipComponentGuard;
      (deps as any).harper = mockHarper({ mcp: {
        enabled: true, issuer: envRef ? "${FLAIR_MCP_ISSUER}" : issuer,
      } });
      const error = await registerMcpOAuthRoute(deps).then(() => null, error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("has a query/hash");
      expect(error.message).not.toContain(issuer);
      if (envRef) expect(error.message).toContain('environment variable "FLAIR_MCP_ISSUER"');
      expect(httpCalls).toHaveLength(0);
    },
  );

  it.each(["https://flair.example.com", "https://flair.example.com/"]
    .flatMap(issuer => [false, true].map(envRef => ({ issuer, envRef }))))(
    "mounts a plain issuer origin: $issuer (env reference: $envRef)", async ({ issuer, envRef }) => {
      process.env.FLAIR_MCP_OAUTH = "true";
      process.env.FLAIR_MCP_ISSUER = issuer;
      const deps = makeDeps();
      delete (deps as any).skipComponentGuard;
      (deps as any).harper = mockHarper({ mcp: {
        enabled: true, issuer: envRef ? "${FLAIR_MCP_ISSUER}" : issuer,
      } });
      expect(await registerMcpOAuthRoute(deps)).toBe(true);
      expect(httpCalls).toHaveLength(1);
    },
  );

  it("names an unset issuer variable", async () => {
    delete process.env.FLAIR_MCP_ISSUER;
    process.env.FLAIR_MCP_OAUTH = "true";
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper({ mcp: { enabled: true, issuer: "${FLAIR_MCP_ISSUER}" } });
    await expect(registerMcpOAuthRoute(deps)).rejects.toThrow('environment variable "FLAIR_MCP_ISSUER" is unset');
    expect(httpCalls).toHaveLength(0);
  });

  it("flag disagreement does not echo a config-chosen variable's value", async () => {
    process.env.FLAIR_MCP_OAUTH = "true";
    const previous = process.env.SOME_CANARY_VAR;
    process.env.SOME_CANARY_VAR = "canary-enabled-7f3a9c";
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper({ mcp: { enabled: "${SOME_CANARY_VAR}" } });
    try {
      const error = await registerMcpOAuthRoute(deps).then(() => null, error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('FLAIR_MCP_OAUTH is "true"');
      expect(error.message).not.toContain(process.env.SOME_CANARY_VAR!);
      expect(httpCalls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.SOME_CANARY_VAR;
      else process.env.SOME_CANARY_VAR = previous;
    }
  });

  it("canonical true: env reference resolves to true and the route mounts", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "true";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper({ mcp: { enabled: "${FLAIR_MCP_OAUTH}", issuer: "${FLAIR_MCP_ISSUER}" } });
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(true);
    expect(httpCalls).toHaveLength(1);
  });

  it("a VM-realm config with a non-enumerable get mounts when effectively enabled", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "true";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const config = runInNewContext(`
      const component = { mcp: { enabled: true, issuer: "\${FLAIR_MCP_ISSUER}" } };
      const config = {};
      Object.defineProperty(config, "get", {
        enumerable: false,
        value(key) { return key === "@harperfast/oauth" ? component : undefined; },
      });
      config;
    `);
    expect(Object.keys(config)).toHaveLength(0);
    expect(Object.getPrototypeOf(config)).not.toBe(Object.prototype);
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = { app: { config } };
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(true);
    expect(httpCalls).toHaveLength(1);
  });

  it("literal mcp.enabled true agrees with a legacy env value, so the route mounts", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper({ mcp: { enabled: true, issuer: "${FLAIR_MCP_ISSUER}" } });
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(true);
  });

  it("flag OFF → guard is bypassed (no throw even with component absent)", async () => {
    clearEnv();
    // Flag is off
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper(null); // component absent
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(false); // returns false, no error
  });

  it("error message does not contain a hardcoded hostname or example domain", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper(null);
    await expect(registerMcpOAuthRoute(deps)).rejects.toThrow(
      /FLAIR_MCP_OAUTH is enabled/,
    );
    // Catch the error to inspect the message.
    try {
      await registerMcpOAuthRoute(deps);
    } catch (e: any) {
      const msg: string = e.message;
      // Must not contain a hardcoded issuer URL.
      expect(msg).not.toMatch(/https:\/\/[^\s]+/);
      // Must name the component and the config file.
      expect(msg).toContain("@harperfast/oauth");
      expect(msg).toContain("config.yaml");
      // Must name the flag the operator set.
      expect(msg).toContain("FLAIR_MCP_OAUTH");
      // The example's issuer is ${FLAIR_MCP_ISSUER}. FLAIR_PUBLIC_URL does not fill it.
      expect(msg).toContain("FLAIR_MCP_ISSUER");
      expect(msg).not.toContain("FLAIR_PUBLIC_URL");
      // The example is the mcp block, not the old providers block.
      expect(msg).toContain("mcp:");
      expect(msg).not.toContain("authorizationEndpoint");
    }
  });

  it.each(["mcp", "enabled"])("throwing %s getter refuses with a named config remedy", async (field) => {
    process.env.FLAIR_MCP_OAUTH = "true";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const component = { mcp: { enabled: true, issuer: "${FLAIR_MCP_ISSUER}" } };
    Object.defineProperty(field === "mcp" ? component : component.mcp, field, {
      get() { throw new Error("getter failed"); },
    });
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper(component);
    await expect(registerMcpOAuthRoute(deps)).rejects.toThrow(
      /configuration could not be read.*Remedy: make config\.yaml.*set FLAIR_MCP_OAUTH=true/,
    );
    expect(httpCalls).toHaveLength(0);
  });

  const envRef = { mcp: { enabled: "${FLAIR_MCP_OAUTH}", issuer: "${FLAIR_MCP_ISSUER}" } };

  it.each(["1", "yes", "on", "YES"])(
    "legacy truthy %s with the shipped env reference refuses and names true",
    async (flag) => {
      clearEnv();
      process.env.FLAIR_MCP_OAUTH = flag;
      process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map((part) => String(part)).join(" "));
      };
      const component = { mcp: { enabled: "${FLAIR_MCP_OAUTH}", issuer: "${FLAIR_MCP_ISSUER}" } };
      const deps = makeDeps();
      delete (deps as any).skipComponentGuard;
      (deps as any).harper = mockHarper(component);
      try {
        await expect(registerMcpOAuthRoute(deps)).rejects.toThrow(/Set FLAIR_MCP_OAUTH=true/);
        expect(httpCalls).toHaveLength(0);
        expect(errors.join("\n")).not.toContain("[mcp-oauth] /mcp mounted");
        expect(component.mcp.enabled).toBe("${FLAIR_MCP_OAUTH}");
      } finally {
        console.error = orig;
      }
    },
  );

  it("disabled flag does not mount and does not throw", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "false";
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((part) => String(part)).join(" "));
    };
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper(envRef);
    try {
      const mounted = await registerMcpOAuthRoute(deps);
      expect(mounted).toBe(false);
      expect(httpCalls).toHaveLength(0);
      expect(errors.join("\n")).not.toContain("[mcp-oauth] /mcp mounted");
    } finally {
      console.error = orig;
    }
  });

  it("missing flag does not mount and does not throw", async () => {
    clearEnv();
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper(envRef);
    const mounted = await registerMcpOAuthRoute(deps);
    expect(mounted).toBe(false);
    expect(httpCalls).toHaveLength(0);
  });

  it("flag true and mcp.enabled omitted refuses and names mcp.enabled", async () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "true";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    const deps = makeDeps();
    delete (deps as any).skipComponentGuard;
    (deps as any).harper = mockHarper({ providers: { github: {} } });
    await expect(registerMcpOAuthRoute(deps)).rejects.toThrow(/Set mcp\.enabled to true/);
    expect(httpCalls).toHaveLength(0);
  });

  it("unreadable config refuses: nothing mounted, no success text, not treated as absent", async () => {
    const cases: Array<{ label: string; harper: any }> = [
      {
        label: "lookup throws",
        harper: { app: { config: { get: () => { throw new Error("disk failed"); }, name: "flair" } } },
      },
      {
        label: "empty body",
        harper: { app: { config: {} } },
      },
      {
        label: "unreadable component",
        harper: { app: { config: { get: () => "", name: "flair" } } },
      },
      {
        label: "unparseable mcp.enabled",
        harper: { app: { config: { get: () => ({ mcp: { enabled: { bad: true } } }) } } },
      },
      {
        label: "array config",
        harper: { app: { config: ["not", "a", "record"] } },
      },
      {
        label: "class instance",
        harper: {
          app: {
            config: new (class Config {
              get(): { mcp: { enabled: boolean } } {
                return { mcp: { enabled: true } };
              }
            })(),
          },
        },
      },
    ];
    for (const c of cases) {
      clearEnv();
      process.env.FLAIR_MCP_OAUTH = "true";
      process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map((part) => String(part)).join(" "));
      };
      const deps = makeDeps();
      delete (deps as any).skipComponentGuard;
      (deps as any).harper = c.harper;
      try {
        let message = "";
        try {
          await registerMcpOAuthRoute(deps);
          throw new Error(`expected refusal for ${c.label}`);
        } catch (err: any) {
          if (String(err?.message ?? "").startsWith("expected refusal")) throw err;
          message = String(err?.message ?? "");
        }
        expect(message).toContain("Remedy:");
        expect(message).not.toMatch(/\bnot declared\b/i);
        expect(message).not.toMatch(/\babsent\b/i);
        expect(message).not.toMatch(/\bnot found\b/i);
        expect(message).not.toMatch(/\bok\b/i);
        expect(message).not.toContain("[mcp-oauth] /mcp mounted");
        expect(httpCalls).toHaveLength(0);
        expect(errors.join("\n")).not.toContain("[mcp-oauth] /mcp mounted");
      } finally {
        console.error = orig;
      }
    }
  });
});
