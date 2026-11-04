/**
 * agent-home-target-2474.test.ts — flair#2474, the port pairing
 * `flair agent stamp-home` and `flair principal add` resolve through.
 *
 * Each command reads through an ops API and writes through the HTTP port.
 * `decideAgentHomeTarget` checks the configured pair, without verifying live
 * instance identity; `resolveAgentHomeTarget` feeds it from Harper's config in a data
 * directory (and, for the default install only, the per-user config).
 *
 * The cases here pin:
 *   - a ONE-SIDED target (one port named) is refused by name when the config
 *     records no complete pair to take the other port from;
 *   - with a complete configured pair, a one-sided target that matches its side
 *     takes the other port from that pair, and one that does not is refused;
 *   - two named ports are handled as before: refused when exactly one matches the
 *     configured pair, used as given when neither does or when the config records
 *     no complete pair.
 *
 * The file-reading cases use a NON-default data directory, so neither the
 * developer's nor the runner's `~/.flair` is read. `FLAIR_URL` and
 * `FLAIR_OPS_PORT` are cleared around each of them and restored afterwards.
 * The real two-Harper seam is test/integration/agent-stamp-home-target-2474.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AMBIGUOUS_INSTANCE_TARGET_ERROR,
  decideAgentHomeTarget,
  resolveAgentHomeTarget,
  type AgentHomeTargetInputs,
} from "../../src/cli.js";

/** A deriveOps that fails the test if the rule consults the ordinary ladder. */
const noDerive = (): number => {
  throw new Error("deriveOps was consulted");
};

function decide(partial: Partial<AgentHomeTargetInputs>): { httpPort: number; opsPort: number } {
  return decideAgentHomeTarget({
    httpPort: 7926,
    httpNamed: false,
    namedOps: null,
    configuredHttp: null,
    configuredOps: null,
    deriveOps: noDerive,
    ...partial,
  });
}

describe("decideAgentHomeTarget — a one-sided target with an incomplete configured pair is refused", () => {
  test("config records only the HTTP port; an ops port named alone is refused by name", () => {
    expect(() => decide({ httpPort: 7926, configuredHttp: 7926, namedOps: 8925 })).toThrow(AMBIGUOUS_INSTANCE_TARGET_ERROR);
  });

  test("config records only the ops port; an HTTP port named alone is refused by name", () => {
    expect(() => decide({ httpPort: 8926, httpNamed: true, configuredOps: 7925 })).toThrow(AMBIGUOUS_INSTANCE_TARGET_ERROR);
  });

  test("config records neither port; either port named alone is refused by name", () => {
    expect(() => decide({ httpPort: 8926, httpNamed: true })).toThrow(AMBIGUOUS_INSTANCE_TARGET_ERROR);
    expect(() => decide({ namedOps: 8925 })).toThrow(AMBIGUOUS_INSTANCE_TARGET_ERROR);
  });

  test("the refusal names the configured sides it found", () => {
    expect(() => decide({ httpPort: 7926, configuredHttp: 7926, namedOps: 8925 })).toThrow(/HTTP 7926, ops none/);
  });
});

describe("decideAgentHomeTarget — a complete configured pair", () => {
  test("an ops port named alone that matches the pair takes the pair's HTTP port", () => {
    expect(decide({ httpPort: 7926, configuredHttp: 7926, configuredOps: 7925, namedOps: 7925 })).toEqual({ httpPort: 7926, opsPort: 7925 });
  });

  test("an HTTP port named alone that matches the pair takes the pair's ops port, not the ordinary ladder's", () => {
    expect(decide({ httpPort: 7926, httpNamed: true, configuredHttp: 7926, configuredOps: 7925 })).toEqual({ httpPort: 7926, opsPort: 7925 });
  });

  test("nothing named takes the pair", () => {
    expect(decide({ httpPort: 7926, configuredHttp: 7926, configuredOps: 7925 })).toEqual({ httpPort: 7926, opsPort: 7925 });
  });

  test("an HTTP port named alone that disagrees with the pair is refused (the derived ops port is the pair's)", () => {
    expect(() => decide({ httpPort: 8926, httpNamed: true, configuredHttp: 7926, configuredOps: 7925 })).toThrow("conflicts with the configured pair");
  });

  test("an ops port named alone that disagrees with the pair is refused", () => {
    expect(() => decide({ httpPort: 7926, configuredHttp: 7926, configuredOps: 7925, namedOps: 8925 })).toThrow(AMBIGUOUS_INSTANCE_TARGET_ERROR);
  });
});

describe("decideAgentHomeTarget — two named ports (behaviour unchanged by the one-sided rule)", () => {
  test("a named pair where exactly one port matches the configured pair is refused, either way round", () => {
    expect(() => decide({ httpPort: 7926, httpNamed: true, namedOps: 8925, configuredHttp: 7926, configuredOps: 7925 })).toThrow("conflicts with the configured pair");
    expect(() => decide({ httpPort: 8926, httpNamed: true, namedOps: 7925, configuredHttp: 7926, configuredOps: 7925 })).toThrow("conflicts with the configured pair");
  });

  test("a named pair that matches neither side of the configured pair is used as given", () => {
    expect(decide({ httpPort: 8926, httpNamed: true, namedOps: 8925, configuredHttp: 7926, configuredOps: 7925 })).toEqual({ httpPort: 8926, opsPort: 8925 });
  });

  test("a named pair equal to the configured pair is used", () => {
    expect(decide({ httpPort: 7926, httpNamed: true, namedOps: 7925, configuredHttp: 7926, configuredOps: 7925 })).toEqual({ httpPort: 7926, opsPort: 7925 });
  });

  test("with an incomplete configured pair, a named pair is used as given", () => {
    expect(decide({ httpPort: 8926, httpNamed: true, namedOps: 8925, configuredHttp: 7926 })).toEqual({ httpPort: 8926, opsPort: 8925 });
    expect(decide({ httpPort: 8926, httpNamed: true, namedOps: 8925 })).toEqual({ httpPort: 8926, opsPort: 8925 });
  });

  test("with an incomplete configured pair and nothing named, the ops port comes from the ordinary ladder", () => {
    expect(decide({ httpPort: 7926, configuredHttp: 7926, deriveOps: () => 7925 })).toEqual({ httpPort: 7926, opsPort: 7925 });
  });
});

describe("resolveAgentHomeTarget — reading Harper's config in a data directory", () => {
  let dataDir: string;
  let saved: { FLAIR_URL?: string; FLAIR_OPS_PORT?: string };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "flair-2474-target-"));
    saved = { FLAIR_URL: process.env.FLAIR_URL, FLAIR_OPS_PORT: process.env.FLAIR_OPS_PORT };
    delete process.env.FLAIR_URL;
    delete process.env.FLAIR_OPS_PORT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a config read failure reports an unresolved pair", () => {
    mkdirSync(join(dataDir, "harper-config.yaml"));
    expect(() => resolveAgentHomeTarget({ dataDir, port: "7926" })).toThrow("no complete port pair could be resolved from config");
  });

  test("Harper's config records only the HTTP port: --ops-port alone is refused by name", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), "http:\n  port: 7926\n");
    expect(() => resolveAgentHomeTarget({ dataDir, opsPort: "8925" })).toThrow(AMBIGUOUS_INSTANCE_TARGET_ERROR);
  });

  test("Harper's config records only the ops port: --port alone is refused by name", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), "operationsApi:\n  network:\n    port: 7925\n");
    expect(() => resolveAgentHomeTarget({ dataDir, port: "8926" })).toThrow(AMBIGUOUS_INSTANCE_TARGET_ERROR);
  });

  test("FLAIR_OPS_PORT counts as a named ops port: alone, with only the HTTP port configured, it is refused", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), "http:\n  port: 7926\n");
    process.env.FLAIR_OPS_PORT = "8925";
    expect(() => resolveAgentHomeTarget({ dataDir })).toThrow(AMBIGUOUS_INSTANCE_TARGET_ERROR);
  });

  test("a complete configured pair: --ops-port alone that matches it is accepted with the pair's HTTP port", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), "http:\n  port: 7926\noperationsApi:\n  network:\n    port: 7925\n");
    expect(resolveAgentHomeTarget({ dataDir, opsPort: "7925" })).toEqual({ httpPort: 7926, opsPort: 7925 });
  });

  test("a complete configured pair: --port alone that matches it takes the pair's ops port", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), "http:\n  port: 7926\noperationsApi:\n  network:\n    port: 7925\n");
    expect(resolveAgentHomeTarget({ dataDir, port: "7926" })).toEqual({ httpPort: 7926, opsPort: 7925 });
  });

  test("an explicit pair for both ports is unchanged: used as given when it matches neither configured side", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), "http:\n  port: 7926\noperationsApi:\n  network:\n    port: 7925\n");
    expect(resolveAgentHomeTarget({ dataDir, port: "8926", opsPort: "8925" })).toEqual({ httpPort: 8926, opsPort: 8925 });
    expect(() => resolveAgentHomeTarget({ dataDir, port: "7926", opsPort: "8925" })).toThrow(AMBIGUOUS_INSTANCE_TARGET_ERROR);
  });

  test("an explicit pair for both ports with only the HTTP port configured is used as given", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), "http:\n  port: 7926\n");
    expect(resolveAgentHomeTarget({ dataDir, port: "8926", opsPort: "8925" })).toEqual({ httpPort: 8926, opsPort: 8925 });
  });
});
