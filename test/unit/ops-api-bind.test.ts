/**
 * ops-api-bind.test.ts — Unit tests for the Harper ops API bind-address logic
 * added by flair#670 (follow-up to #654's authorizeLocal fix).
 *
 * The Harper ops API used to bind all interfaces unconditionally. For
 * single-host installs that's more network surface than needed — an
 * accidentally-exposed :9925 (misconfigured firewall / container
 * networking) shouldn't be reachable off-box. `flair init` now defaults the
 * ops API to loopback + the domain socket, with an escape hatch
 * (`--ops-bind` / `FLAIR_OPS_BIND`) for deployments that genuinely need
 * remote ops access (multi-host / Fabric).
 *
 * Same house pattern as doctor-summary.test.ts / cli.test.ts's
 * resolveOpsPort block: the CLI action callbacks spawn real processes and
 * hit the filesystem/network, so the pure decision logic is extracted and
 * exported for direct testing — no real Harper instance involved.
 *
 *   - resolveOpsBindHost() — flag/env/default resolution
 *   - buildOperationsApiConfig() — the exact HARPER_SET_CONFIG shape written
 *   - detectOpsApiAllInterfacesBind() — the `flair doctor` finding's decision logic
 */

import { describe, test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveOpsBindHost,
  resolveOpsBindHostFrom,
  readOpsBindFromConfig,
  readOpsPortFromConfig,
  writeConfig,
  opsNetworkPortValue,
  buildDirectSpawnEnv,
  buildOperationsApiConfig,
  detectOpsApiAllInterfacesBind,
} from "../../src/cli.ts";

// ─── resolveOpsBindHost ─────────────────────────────────────────────────────

describe("resolveOpsBindHost", () => {
  let origEnv: string | undefined;

  beforeAll(() => {
    origEnv = process.env.FLAIR_OPS_BIND;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.FLAIR_OPS_BIND;
    else process.env.FLAIR_OPS_BIND = origEnv;
  });

  test("defaults to loopback (127.0.0.1) when nothing is set", () => {
    delete process.env.FLAIR_OPS_BIND;
    expect(resolveOpsBindHost({})).toBe("127.0.0.1");
  });

  test("uses explicit --ops-bind flag over everything", () => {
    process.env.FLAIR_OPS_BIND = "10.0.0.5";
    expect(resolveOpsBindHost({ opsBind: "0.0.0.0" })).toBe("0.0.0.0");
  });

  test("falls back to FLAIR_OPS_BIND env when no flag given", () => {
    delete process.env.FLAIR_OPS_BIND;
    process.env.FLAIR_OPS_BIND = "192.168.1.10";
    expect(resolveOpsBindHost({})).toBe("192.168.1.10");
  });

  test("blank/whitespace-only flag falls through to env/default rather than binding to nothing", () => {
    delete process.env.FLAIR_OPS_BIND;
    expect(resolveOpsBindHost({ opsBind: "   " })).toBe("127.0.0.1");
  });

  test("trims whitespace around an explicit flag value", () => {
    delete process.env.FLAIR_OPS_BIND;
    expect(resolveOpsBindHost({ opsBind: "  0.0.0.0  " })).toBe("0.0.0.0");
  });

  test("the escape hatch supports the literal all-interfaces address", () => {
    delete process.env.FLAIR_OPS_BIND;
    expect(resolveOpsBindHost({ opsBind: "0.0.0.0" })).toBe("0.0.0.0");
  });
});

// ─── buildOperationsApiConfig ───────────────────────────────────────────────

describe("buildOperationsApiConfig", () => {
  test("single-host default: loopback-prefixed host:port string", () => {
    const cfg = buildOperationsApiConfig(19925, "/data/operations-server", "127.0.0.1");
    expect(cfg.network.port).toBe("127.0.0.1:19925");
  });

  test("escape hatch: the given bind host is used verbatim", () => {
    const cfg = buildOperationsApiConfig(19925, "/data/operations-server", "0.0.0.0");
    expect(cfg.network.port).toBe("0.0.0.0:19925");
  });

  test("domain socket is nested under network (matches Harper's config-root.schema.json path operationsApi.network.domainSocket, not a sibling of network)", () => {
    const cfg = buildOperationsApiConfig(19925, "/data/operations-server", "127.0.0.1");
    expect(cfg.network.domainSocket).toBe("/data/operations-server");
    expect((cfg as any).domainSocket).toBeUndefined();
  });

  test("cors stays enabled (unchanged posture)", () => {
    const cfg = buildOperationsApiConfig(19925, "/data/operations-server", "127.0.0.1");
    expect(cfg.network.cors).toBe(true);
  });

  test("is deterministic for the same inputs (idempotent re-init writes the same block)", () => {
    const a = buildOperationsApiConfig(19925, "/data/operations-server", "127.0.0.1");
    const b = buildOperationsApiConfig(19925, "/data/operations-server", "127.0.0.1");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ─── detectOpsApiAllInterfacesBind ──────────────────────────────────────────

describe("detectOpsApiAllInterfacesBind", () => {
  test("a bare numeric port means all-interfaces (Harper's pre-#670 default)", () => {
    const r = detectOpsApiAllInterfacesBind(19925);
    expect(r.allInterfaces).toBe(true);
    expect(r.boundHost).toBeNull();
  });

  test("a bare numeric-string port also means all-interfaces", () => {
    const r = detectOpsApiAllInterfacesBind("19925");
    expect(r.allInterfaces).toBe(true);
  });

  test("a loopback host:port string is NOT flagged", () => {
    const r = detectOpsApiAllInterfacesBind("127.0.0.1:19925");
    expect(r.allInterfaces).toBe(false);
    expect(r.boundHost).toBe("127.0.0.1");
  });

  test("an explicit 0.0.0.0:port (deliberate escape hatch) is NOT flagged as a problem — it's a documented opt-in, not an accident", () => {
    const r = detectOpsApiAllInterfacesBind("0.0.0.0:19925");
    expect(r.allInterfaces).toBe(false);
    expect(r.boundHost).toBe("0.0.0.0");
  });

  test("an IPv6 host:port with brackets strips the brackets", () => {
    const r = detectOpsApiAllInterfacesBind("[::1]:19925");
    expect(r.boundHost).toBe("::1");
  });

  test("missing/undefined port value is not a finding (nothing to report)", () => {
    expect(detectOpsApiAllInterfacesBind(undefined).allInterfaces).toBe(false);
    expect(detectOpsApiAllInterfacesBind(null).allInterfaces).toBe(false);
  });
});

// ─── flair#863 ──────────────────────────────────────────────────────────────
//
// `--ops-bind` was accepted and had no observable effect, and `doctor`'s
// printed remedy (`flair init && flair restart`) could not clear its own
// finding. Root cause: flair seeded a BARE `OPERATIONSAPI_NETWORK_PORT` into
// Harper's environment alongside the host-qualified HARPER_SET_CONFIG. Harper
// records the pre-SET_CONFIG value of every key SET_CONFIG force-sets and
// RESTORES it on the next boot that omits HARPER_SET_CONFIG — and the direct
// (non-launchd) spawn behind `flair restart` / `flair upgrade` omitted both
// the variable and the SET_CONFIG block, so every restart reverted
// `operationsApi.network.port` to the bare number and re-bound the ops API to
// all interfaces, permanently.
//
// The guards below pin the two halves of the fix: every spawn carries the
// host-qualified value, and the operator's choice is persisted so the spawns
// that have no `--ops-bind` flag of their own can re-assert it.

describe("opsNetworkPortValue (flair#863)", () => {
  test("renders the host-qualified form Harper needs to narrow the bind", () => {
    expect(opsNetworkPortValue("127.0.0.1", 19925)).toBe("127.0.0.1:19925");
  });

  test("what flair emits is never classified as all-interfaces by doctor's own detector", () => {
    // Ties the writer and the reader together: if the host is ever dropped
    // from the emitted value, doctor's finding fires on flair's own output.
    expect(detectOpsApiAllInterfacesBind(opsNetworkPortValue("127.0.0.1", 19925)).allInterfaces).toBe(false);
    expect(detectOpsApiAllInterfacesBind(opsNetworkPortValue("0.0.0.0", 19925)).boundHost).toBe("0.0.0.0");
  });

  test("HARPER_SET_CONFIG and the OPERATIONSAPI_NETWORK_PORT env var cannot disagree", () => {
    // The original defect in one assertion: the config block said
    // "127.0.0.1:19925" while the env var said "19925".
    const cfg = buildOperationsApiConfig(19925, "/data/operations-server", "127.0.0.1");
    const env = buildDirectSpawnEnv({
      dataDir: "/data", modelsDir: "/models", httpPort: 19926,
      opsPort: 19925, opsBindHost: "127.0.0.1", adminUser: "admin",
    });
    expect(env.OPERATIONSAPI_NETWORK_PORT).toBe(cfg.network.port);
  });
});

describe("buildDirectSpawnEnv (flair#863)", () => {
  const base = {
    dataDir: "/data", modelsDir: "/models", httpPort: 19926,
    opsPort: 19925, opsBindHost: "127.0.0.1", adminUser: "admin",
  };

  test("carries a host-qualified OPERATIONSAPI_NETWORK_PORT, never a bare port", () => {
    // THE regression guard. A bare port here is what Harper latches as the
    // restore-to original, which is how the bind silently re-widened.
    const env = buildDirectSpawnEnv(base);
    expect(env.OPERATIONSAPI_NETWORK_PORT).toBe("127.0.0.1:19925");
    expect(env.OPERATIONSAPI_NETWORK_PORT).toContain(":");
    expect(env.OPERATIONSAPI_NETWORK_PORT).not.toBe("19925");
  });

  test("the widening escape hatch reaches the spawn verbatim", () => {
    const env = buildDirectSpawnEnv({ ...base, opsBindHost: "0.0.0.0" });
    expect(env.OPERATIONSAPI_NETWORK_PORT).toBe("0.0.0.0:19925");
  });

  test("omits HDB_ADMIN_PASSWORD when no password is in hand (an empty string strips auth on an existing install)", () => {
    expect(buildDirectSpawnEnv(base).HDB_ADMIN_PASSWORD).toBeUndefined();
    expect(buildDirectSpawnEnv({ ...base, adminPass: "" }).HDB_ADMIN_PASSWORD).toBeUndefined();
    expect(buildDirectSpawnEnv({ ...base, adminPass: "x" }).HDB_ADMIN_PASSWORD).toBe("x");
  });

  test("still carries the rest of the direct-spawn contract", () => {
    const env = buildDirectSpawnEnv(base);
    expect(env.ROOTPATH).toBe("/data");
    expect(env.FLAIR_MODELS_DIR).toBe("/models");
    expect(env.HTTP_PORT).toBe("19926");
    expect(env.HDB_ADMIN_USERNAME).toBe("admin");
    expect(env.LOCAL_STUDIO).toBe("false");
  });
});

describe("ops-bind persistence in ~/.flair/config.yaml (flair#863)", () => {
  const dir = mkdtempSync(join(tmpdir(), "flair-opsbind-cfg-"));
  const cfg = join(dir, "config.yaml");

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writeConfig persists port, opsPort and opsBind", () => {
    writeConfig(19926, 19925, "127.0.0.1", cfg);
    expect(readOpsBindFromConfig(cfg)).toBe("127.0.0.1");
    expect(readOpsPortFromConfig(cfg)).toBe(19925);
    expect(readFileSync(cfg, "utf-8")).toContain("port: 19926");
  });

  test("a later writeConfig that only knows the HTTP port preserves opsBind and opsPort", () => {
    // `flair doctor --fix` rewrites this file when it corrects a drifted HTTP
    // port. Dropping opsBind there would silently revert the operator's
    // choice on the next restart — the same class of bug as the original.
    writeConfig(19926, 19925, "0.0.0.0", cfg);
    writeConfig(29999, undefined, undefined, cfg);
    expect(readOpsBindFromConfig(cfg)).toBe("0.0.0.0");
    expect(readOpsPortFromConfig(cfg)).toBe(19925);
  });

  test("reads a quoted value and ignores a key that merely ends in opsBind", () => {
    writeFileSync(cfg, '# Flair configuration\nport: 19926\nnotOpsBind: 9.9.9.9\nopsBind: "10.0.0.7"\n');
    expect(readOpsBindFromConfig(cfg)).toBe("10.0.0.7");
  });

  test("absent file / absent key resolve to null (no bind persisted)", () => {
    writeFileSync(cfg, "# Flair configuration\nport: 19926\n");
    expect(readOpsBindFromConfig(cfg)).toBeNull();
    expect(readOpsBindFromConfig(join(dir, "nope.yaml"))).toBeNull();
  });
});

describe("resolveOpsBindHostFrom precedence (flair#863)", () => {
  test("flag wins over env and persisted config", () => {
    expect(resolveOpsBindHostFrom("10.0.0.1", "10.0.0.2", "10.0.0.3")).toBe("10.0.0.1");
  });

  test("env wins over persisted config", () => {
    expect(resolveOpsBindHostFrom(undefined, "10.0.0.2", "10.0.0.3")).toBe("10.0.0.2");
  });

  test("persisted config wins over the built-in default — this is what makes --ops-bind survive a restart", () => {
    expect(resolveOpsBindHostFrom(undefined, undefined, "0.0.0.0")).toBe("0.0.0.0");
  });

  test("nothing set anywhere: loopback-only single-host default", () => {
    expect(resolveOpsBindHostFrom(undefined, undefined, null)).toBe("127.0.0.1");
  });

  test("blank/whitespace values at any rung fall through instead of blanking the host", () => {
    expect(resolveOpsBindHostFrom("  ", "", "  ")).toBe("127.0.0.1");
    expect(resolveOpsBindHostFrom("  ", "", " 10.0.0.3 ")).toBe("10.0.0.3");
  });
});
