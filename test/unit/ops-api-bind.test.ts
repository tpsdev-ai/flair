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

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import {
  resolveOpsBindHost,
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
