/**
 * npm-registry.test.ts — flair#1688 (resolution) + flair#1692 (security review).
 *
 * Unit coverage for the resolver that replaced the hardcoded
 * `registry.npmjs.org` host in the upgrade/update-check path. npm itself is
 * never spawned here: the config reader is injected, so these assert the
 * resolution RULES (scope mapping beats default, env beats .npmrc, unset /
 * unavailable falls back to the public default) AND the security boundaries
 * added for the flair#1692 review — scheme allowlist, source reporting, strict
 * semver validation, and redirect refusal.
 *
 * The end-to-end proof that `flair upgrade --check` actually queries the
 * configured registry lives in
 * test/unit-isolated/upgrade-registry-resolution.test.ts.
 */

import { describe, test, expect } from "bun:test";
import {
  DEFAULT_NPM_REGISTRY,
  INSECURE_REGISTRY_ENV,
  RegistryRefusalError,
  createRegistryNoticePrinter,
  fetchLatestVersion,
  formatRegistryLine,
  isStrictSemver,
  packageScope,
  parseNpmConfigList,
  registryAuthTokenKey,
  registryNeedsNpmTransport,
  resolveNpmRegistry,
  resolveNpmRegistryDetailed,
  validateRegistryUrl,
  type NpmConfigEntries,
  type NpmConfigEntry,
  type NpmConfigEntryReader,
} from "../../src/lib/npm-registry.js";

/** An entry reader backed by a plain object; unlisted keys resolve to null. */
function reader(values: Record<string, string | null>): NpmConfigEntryReader {
  return async (key) =>
    key in values
      ? { value: values[key] ?? "", layer: "project", source: "project .npmrc (/tmp/.npmrc)" }
      : null;
}

function noEntries(): Promise<NpmConfigEntries> {
  return Promise.resolve(new Map());
}

describe("packageScope", () => {
  test("extracts the scope of a scoped package", () => {
    expect(packageScope("@tpsdev-ai/flair")).toBe("@tpsdev-ai");
    expect(packageScope("@scope/name")).toBe("@scope");
  });

  test("returns null for unscoped or malformed names", () => {
    expect(packageScope("lodash")).toBeNull();
    expect(packageScope("@nope")).toBeNull();
    expect(packageScope("@/name")).toBeNull();
    // Characters that do not belong in an npm scope must never reach a config
    // key (or, on Windows, a shell) — a fake scope falls back to the default.
    expect(packageScope("@bad;scope/name")).toBeNull();
    expect(packageScope("@bad scope/name")).toBeNull();
  });
});

// ─── npm config list parse: value + source ──────────────────────────────────

describe("parseNpmConfigList", () => {
  test("names the layer each active value came from", () => {
    const entries = parseNpmConfigList(
      [
        '; "user" config from /home/u/.npmrc',
        "",
        '@acme:registry = "https://userscope.example/"',
        "",
        '; "project" config from /work/.npmrc',
        "",
        '@tpsdev-ai:registry = "https://scope.example/"',
        'registry = "https://proj.example/"',
        "",
      ].join("\n"),
    );
    expect(entries.get("@acme:registry")?.value).toBe("https://userscope.example/");
    expect(entries.get("@acme:registry")?.source).toBe("user .npmrc (/home/u/.npmrc)");
    expect(entries.get("@tpsdev-ai:registry")?.source).toBe("project .npmrc (/work/.npmrc)");
    expect(entries.get("registry")?.source).toBe("project .npmrc (/work/.npmrc)");
  });

  test("commented-out (overridden) values are ignored", () => {
    const entries = parseNpmConfigList(
      [
        '; "project" config from /work/.npmrc',
        "",
        '; registry = "https://proj.example/" ; overridden by env',
        "",
        '; "env" config from environment',
        "",
        'registry = "https://env.example/"',
        "",
      ].join("\n"),
    );
    expect(entries.get("registry")?.value).toBe("https://env.example/");
    expect(entries.get("registry")?.source).toBe("env");
  });

  test("publishConfig values are publish-time only and ignored", () => {
    const entries = parseNpmConfigList(
      [
        '; "publishConfig" from /work/package.json',
        "; This set of config values will be used at publish-time.",
        "",
        'access = "public"',
        'registry = "https://publish.example/"',
        "",
      ].join("\n"),
    );
    expect(entries.has("access")).toBe(false);
    expect(entries.has("registry")).toBe(false);
  });

  test("protected auth values keep presence without the secret", () => {
    const entries = parseNpmConfigList(
      ['; "project" config from /work/.npmrc', "", "//registry.example.com/:_authToken = (protected)"].join("\n"),
    );
    expect(entries.has("//registry.example.com/:_authToken")).toBe(true);
    expect(entries.get("//registry.example.com/:_authToken")?.value).toBe("");
  });

  test("unquoted booleans parse as plain values", () => {
    const entries = parseNpmConfigList(
      ['; "project" config from /work/.npmrc', "", "strict-ssl = false"].join("\n"),
    );
    expect(entries.get("strict-ssl")?.value).toBe("false");
  });
});

// ─── Scheme allowlist (flair#1692 item 2) ───────────────────────────────────

describe("validateRegistryUrl", () => {
  test("https is always allowed and not insecure", () => {
    const res = validateRegistryUrl("https://mirror.example/npm", "registry (.npmrc)");
    expect(res.url).toBe("https://mirror.example/npm");
    expect(res.insecure).toBe(false);
  });

  test("http is allowed for loopback hosts in every spelling", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const res = validateRegistryUrl(`http://${host}:8080`, "env");
      expect(res.insecure).toBe(false);
    }
  });

  test("http to a non-loopback host is refused by default", () => {
    expect(() => validateRegistryUrl("http://evil.internal:8080", "registry (user .npmrc)")).toThrow(
      RegistryRefusalError,
    );
    // The refusal must be actionable: actor + state + remedy.
    try {
      validateRegistryUrl("http://evil.internal:8080", "registry (user .npmrc)");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("actor:");
      expect(msg).toContain("state:");
      expect(msg).toContain("remedy:");
      expect(msg).toContain(INSECURE_REGISTRY_ENV);
    }
  });

  test("http to a non-loopback host is allowed with the explicit opt-in and marked INSECURE", () => {
    const res = validateRegistryUrl(
      "http://evil.internal:8080",
      "env",
      { [INSECURE_REGISTRY_ENV]: "1" },
    );
    expect(res.insecure).toBe(true);
    expect(formatRegistryLine(res)).toContain("[INSECURE]");
  });

  test("file: and ftp: are refused even with the insecure opt-in", () => {
    for (const url of ["file:///etc/passwd", "ftp://x/"]) {
      expect(() =>
        validateRegistryUrl(url, "registry (project .npmrc)", { [INSECURE_REGISTRY_ENV]: "1" }),
      ).toThrow(RegistryRefusalError);
    }
  });

  test("an unparseable value is refused, never fetched", () => {
    expect(() => validateRegistryUrl("not a url", "registry")).toThrow(RegistryRefusalError);
  });
});

// ─── Resolution + source reporting (flair#1692 item 1) ──────────────────────

describe("resolveNpmRegistry", () => {
  test("no configuration → public npm default", async () => {
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", { env: {}, readConfig: reader({}) }),
    ).resolves.toBe(DEFAULT_NPM_REGISTRY);
    await expect(
      resolveNpmRegistry("lodash", { env: {}, readConfig: reader({}) }),
    ).resolves.toBe(DEFAULT_NPM_REGISTRY);
  });

  test("npm reporting 'undefined' counts as unset → public default", async () => {
    const readConfig = reader({ "@tpsdev-ai:registry": "undefined", registry: "undefined" });
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", { env: {}, readConfig }),
    ).resolves.toBe(DEFAULT_NPM_REGISTRY);
  });

  test("default registry is used for any package when no scope mapping exists", async () => {
    const readConfig = reader({ registry: "https://mirror.example/npm" });
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", { env: {}, readConfig }),
    ).resolves.toBe("https://mirror.example/npm");
    await expect(
      resolveNpmRegistry("lodash", { env: {}, readConfig }),
    ).resolves.toBe("https://mirror.example/npm");
  });

  test("scope mapping beats the default registry for scoped packages", async () => {
    const readConfig = reader({
      "@tpsdev-ai:registry": "https://scope.example/",
      registry: "https://mirror.example/npm",
    });
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", { env: {}, readConfig }),
    ).resolves.toBe("https://scope.example");
  });

  test("scope mapping is ignored for an unscoped package", async () => {
    const readConfig = reader({
      "@tpsdev-ai:registry": "https://scope.example",
      registry: "https://mirror.example/npm",
    });
    await expect(
      resolveNpmRegistry("@other/pkg", { env: {}, readConfig }),
    ).resolves.toBe("https://mirror.example/npm");
    await expect(resolveNpmRegistry("lodash", { env: {}, readConfig })).resolves.toBe(
      "https://mirror.example/npm",
    );
  });

  test("env npm_config_<scope>:registry beats everything", async () => {
    const readConfig = reader({
      "@tpsdev-ai:registry": "https://npmrc-scope.example",
      registry: "https://npmrc-default.example",
    });
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", {
        env: { "npm_config_@tpsdev-ai:registry": "https://env-scope.example/" },
        readConfig,
      }),
    ).resolves.toBe("https://env-scope.example");
  });

  test("env npm_config_registry beats the .npmrc default", async () => {
    const readConfig = reader({ registry: "https://npmrc-default.example" });
    await expect(
      resolveNpmRegistry("lodash", {
        env: { npm_config_registry: "https://env-default.example/" },
        readConfig,
      }),
    ).resolves.toBe("https://env-default.example");
  });

  test("a .npmrc scope mapping still beats env npm_config_registry for scoped packages", async () => {
    // npm precedence: the two keys are independent; a scope-specific mapping
    // wins over the default for that scope regardless of where the default came
    // from. This is the case a naive "env first, always" resolver gets wrong.
    const readConfig = reader({ "@tpsdev-ai:registry": "https://npmrc-scope.example" });
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", {
        env: { npm_config_registry: "https://env-default.example" },
        readConfig,
      }),
    ).resolves.toBe("https://npmrc-scope.example");
  });

  test("trailing slashes are stripped so callers can join paths", async () => {
    const readConfig = reader({ registry: "https://mirror.example/npm///" });
    await expect(
      resolveNpmRegistry("lodash", { env: {}, readConfig }),
    ).resolves.toBe("https://mirror.example/npm");
  });

  test("a configured reader that throws never breaks resolution", async () => {
    const readConfig: NpmConfigEntryReader = async () => {
      throw new Error("npm exploded");
    };
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", { env: {}, readConfig }),
    ).resolves.toBe(DEFAULT_NPM_REGISTRY);
  });

  test("when npm is unavailable the default is still npmjs (no behaviour change)", async () => {
    const readConfig = reader({ "@tpsdev-ai:registry": null, registry: null });
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", { env: {}, readConfig }),
    ).resolves.toBe(DEFAULT_NPM_REGISTRY);
  });
});

describe("resolveNpmRegistryDetailed — source reporting", () => {
  test("names the env variable that set a scoped registry", async () => {
    const res = await resolveNpmRegistryDetailed("@tpsdev-ai/flair", {
      env: { "npm_config_@tpsdev-ai:registry": "https://env-scope.example" },
      readConfig: reader({}),
    });
    expect(res.source).toBe("env npm_config_@tpsdev-ai:registry");
  });

  test("names the scope mapping and the npmrc layer", async () => {
    const entries = parseNpmConfigList(
      ['; "user" config from /home/u/.npmrc', "", '@tpsdev-ai:registry = "https://scope.example"'].join("\n"),
    );
    const readConfig: NpmConfigEntryReader = async (key) => entries.get(key) ?? null;
    const res = await resolveNpmRegistryDetailed("@tpsdev-ai/flair", { env: {}, readConfig });
    expect(res.url).toBe("https://scope.example");
    expect(res.source).toBe("@tpsdev-ai:registry (user .npmrc (/home/u/.npmrc))");
  });

  test("names the default registry and the project npmrc path", async () => {
    const entries = parseNpmConfigList(
      ['; "project" config from /work/.npmrc', "", 'registry = "https://proj.example"'].join("\n"),
    );
    const readConfig: NpmConfigEntryReader = async (key) => entries.get(key) ?? null;
    const res = await resolveNpmRegistryDetailed("lodash", { env: {}, readConfig });
    expect(res.url).toBe("https://proj.example");
    expect(res.source).toBe("registry (project .npmrc (/work/.npmrc))");
    expect(formatRegistryLine(res)).toBe(
      "registry: https://proj.example (source: registry (project .npmrc (/work/.npmrc)))",
    );
  });

  test("names the public default", async () => {
    const res = await resolveNpmRegistryDetailed("lodash", { env: {}, readConfig: reader({}) });
    expect(res.source).toBe("default npm public registry");
  });
});

// ─── Strict semver (flair#1692 item 3) ──────────────────────────────────────

describe("isStrictSemver", () => {
  test("accepts strict semver, including prerelease and build metadata", () => {
    expect(isStrictSemver("1.2.3")).toBe(true);
    expect(isStrictSemver("0.0.0")).toBe(true);
    expect(isStrictSemver("1.2.3-rc.1")).toBe(true);
    expect(isStrictSemver("1.2.3+build.5")).toBe(true);
    expect(isStrictSemver(" 1.2.3 ")).toBe(true);
  });

  test("rejects the shapes that become an arbitrary install spec", () => {
    for (const bad of [
      "https://attacker.example/x.tgz",
      "file:///etc/passwd",
      "latest",
      "next",
      "^1.2.3",
      "~1.2.3",
      "1.2",
      "v1.2.3",
      "1.2.3 || 2.0.0",
      "",
      null,
      undefined,
      123,
    ]) {
      expect(isStrictSemver(bad)).toBe(false);
    }
  });
});

// ─── Transport detection (flair#1692 item 4) ────────────────────────────────

describe("registryAuthTokenKey / registryNeedsNpmTransport", () => {
  test("finds the longest matching scoped token key", () => {
    const entries: NpmConfigEntries = new Map<string, NpmConfigEntry>([
      ["//registry.example.com/:_authToken", { value: "", layer: "user", source: "user .npmrc" }],
      ["//registry.example.com/npm/:_authToken", { value: "", layer: "project", source: "project .npmrc" }],
    ]);
    expect(registryAuthTokenKey("https://registry.example.com/npm", entries)).toBe(
      "//registry.example.com/npm/:_authToken",
    );
    expect(registryAuthTokenKey("https://registry.example.com/other", entries)).toBe(
      "//registry.example.com/:_authToken",
    );
    expect(registryAuthTokenKey("https://other.example.com", entries)).toBeNull();
  });

  test("legacy unscoped _authToken is detected", () => {
    const entries: NpmConfigEntries = new Map([
      ["_authToken", { value: "", layer: "user", source: "user .npmrc" }],
    ]);
    expect(registryAuthTokenKey("https://registry.example.com", entries)).toBe("_authToken");
  });

  test("auth token, custom CA, and strict-ssl=false all require npm transport", () => {
    expect(registryNeedsNpmTransport({ strictSsl: true, cafile: null, ca: null, authTokenKey: null })).toBe(false);
    expect(registryNeedsNpmTransport({ strictSsl: false, cafile: null, ca: null, authTokenKey: null })).toBe(true);
    expect(registryNeedsNpmTransport({ strictSsl: true, cafile: "/tmp/ca.pem", ca: null, authTokenKey: null })).toBe(true);
    expect(registryNeedsNpmTransport({ strictSsl: true, cafile: null, ca: "PEM", authTokenKey: null })).toBe(true);
    expect(registryNeedsNpmTransport({ strictSsl: true, cafile: null, ca: null, authTokenKey: "_authToken" })).toBe(true);
  });
});

// ─── Fetching: scheme, redirects, semver refusal ────────────────────────────

describe("fetchLatestVersion", () => {
  test("returns a strict-semver latest and refuses redirects", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchLatestVersion("lodash", {
      env: {},
      readConfig: reader({}),
      readConfigMap: noEntries,
      fetchImpl,
      timeoutMs: 1000,
    });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.version).toBe("1.2.3");
    // flair#1692 item 5 — a 302 must not silently bypass the allowlist.
    expect(calls[0].init?.redirect).toBe("error");
    expect(calls[0].url).toBe(`${DEFAULT_NPM_REGISTRY}/lodash/latest`);
  });

  test("a non-semver registry value is refused, not returned as an install spec", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ version: "https://attacker.example/x.tgz" }), { status: 200 })) as unknown as typeof fetch;
    const res = await fetchLatestVersion("lodash", {
      env: {},
      readConfig: reader({}),
      readConfigMap: noEntries,
      fetchImpl,
      timeoutMs: 1000,
    });
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") expect(res.value).toBe("https://attacker.example/x.tgz");
  });

  test("a disallowed registry is refused and never fetched", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await fetchLatestVersion("lodash", {
      env: { npm_config_registry: "file:///etc/passwd" },
      readConfig: reader({}),
      readConfigMap: noEntries,
      fetchImpl,
      timeoutMs: 1000,
    });
    expect(res.kind).toBe("refused");
    expect(called).toBe(false);
  });

  test("http loopback (the CI lane) is fetched normally", async () => {
    let seen = "";
    const fetchImpl = (async (url: string | URL | Request) => {
      seen = String(url);
      return new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await fetchLatestVersion("@tpsdev-ai/flair", {
      env: { npm_config_registry: "http://127.0.0.1:4123" },
      readConfig: reader({}),
      readConfigMap: noEntries,
      fetchImpl,
      timeoutMs: 1000,
    });
    expect(res.kind).toBe("ok");
    expect(seen).toBe("http://127.0.0.1:4123/@tpsdev-ai/flair/latest");
  });

  test("a non-2xx registry answer is unavailable, not an error", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const res = await fetchLatestVersion("lodash", {
      env: {},
      readConfig: reader({}),
      readConfigMap: noEntries,
      fetchImpl,
      timeoutMs: 1000,
    });
    expect(res.kind).toBe("unavailable");
  });
});

describe("createRegistryNoticePrinter", () => {
  test("prints each distinct registry line once", () => {
    const lines: string[] = [];
    const notice = createRegistryNoticePrinter((l) => lines.push(l));
    const http = { url: "http://x.example", source: "env", insecure: true };
    const https = { url: "https://x.example", source: "env", insecure: false };
    notice(https);
    notice({ ...https });
    notice(http);
    notice(http);
    expect(lines).toEqual([
      "registry: https://x.example (source: env)",
      "registry: http://x.example (source: env) [INSECURE]",
    ]);
  });
});
