/**
 * npm-registry.test.ts — flair#1688.
 *
 * Unit coverage for the resolver that replaced the hardcoded
 * `registry.npmjs.org` host in the upgrade/update-check path. npm itself is
 * never spawned here: `readConfig` is injected, so these assert the resolution
 * RULES (scope mapping beats default, env beats .npmrc, unset/unavailable
 * falls back to the public default) deterministically and offline.
 *
 * The end-to-end proof that `flair upgrade --check` actually queries the
 * configured registry lives in
 * test/unit-isolated/upgrade-registry-resolution.test.ts.
 */

import { describe, test, expect } from "bun:test";
import {
  DEFAULT_NPM_REGISTRY,
  packageScope,
  resolveNpmRegistry,
  type NpmConfigReader,
} from "../../src/lib/npm-registry.js";

/** A reader backed by a plain object; unlisted keys resolve to null (unset). */
function reader(values: Record<string, string | null>): NpmConfigReader {
  return async (key) => (key in values ? values[key] : null);
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
    const readConfig: NpmConfigReader = async () => {
      throw new Error("npm exploded");
    };
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", { env: {}, readConfig }),
    ).resolves.toBe(DEFAULT_NPM_REGISTRY);
  });

  test("when npm is unavailable the default is still npmjs (no behaviour change)", async () => {
    // `defaultNpmConfigReader` resolves null on a missing/failing npm; simulate
    // exactly that so the "no registry configured" guarantee is asserted.
    const readConfig = reader({ "@tpsdev-ai:registry": null, registry: null });
    await expect(
      resolveNpmRegistry("@tpsdev-ai/flair", { env: {}, readConfig }),
    ).resolves.toBe(DEFAULT_NPM_REGISTRY);
  });
});
