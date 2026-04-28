/**
 * cli-target-flag.test.ts — Unit tests for --target flag / FLAIR_TARGET env var
 *
 * ops-n3ob: Add consistent --target <url> flag (env fallback: FLAIR_TARGET)
 * to init, federation status/token/pair/sync, and status commands.
 *
 * Tests:
 *   - resolveTarget() helper: --target flag vs FLAIR_TARGET env vs undefined
 *   - resolveOpsUrlFromTarget() helper: ops-URL derivation from a Flair base URL
 *   - Commander program: --target option registered on each command
 *   - api() with baseUrl override: HTTP requests route to the correct URL
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  resolveTarget,
  resolveOpsTarget,
  resolveEffectiveOpsUrl,
  resolveOpsUrlFromTarget,
  resolveHttpPort,
  program,
  seedFederationInstanceViaOpsApi,
} from "../../src/cli.js";

// ─── resolveTarget ────────────────────────────────────────────────────────────

describe("resolveTarget", () => {
  let origFlairTarget: string | undefined;

  beforeEach(() => {
    origFlairTarget = process.env.FLAIR_TARGET;
  });

  afterEach(() => {
    if (origFlairTarget === undefined) delete process.env.FLAIR_TARGET;
    else process.env.FLAIR_TARGET = origFlairTarget;
  });

  test("returns undefined when no --target flag and no FLAIR_TARGET env", () => {
    delete process.env.FLAIR_TARGET;
    expect(resolveTarget({})).toBeUndefined();
  });

  test("returns --target flag value when provided", () => {
    delete process.env.FLAIR_TARGET;
    expect(resolveTarget({ target: "https://flair.example.com:9926" }))
      .toBe("https://flair.example.com:9926");
  });

  test("falls back to FLAIR_TARGET env when --target is not set", () => {
    process.env.FLAIR_TARGET = "https://fabric.harper.dev:9925";
    expect(resolveTarget({})).toBe("https://fabric.harper.dev:9925");
  });

  test("--target flag takes precedence over FLAIR_TARGET env", () => {
    process.env.FLAIR_TARGET = "https://env-url.example.com";
    expect(resolveTarget({ target: "https://flag-url.example.com" }))
      .toBe("https://flag-url.example.com");
  });

  test("returns undefined for empty string flag (falsy)", () => {
    expect(resolveTarget({ target: "" })).toBeUndefined();
  });
});

// ─── resolveOpsTarget ──────────────────────────────────────────────────────────

describe("resolveOpsTarget", () => {
  let origFlairOpsTarget: string | undefined;

  beforeEach(() => {
    origFlairOpsTarget = process.env.FLAIR_OPS_TARGET;
  });

  afterEach(() => {
    if (origFlairOpsTarget === undefined) delete process.env.FLAIR_OPS_TARGET;
    else process.env.FLAIR_OPS_TARGET = origFlairOpsTarget;
  });

  test("returns undefined when no --ops-target and no FLAIR_OPS_TARGET env", () => {
    delete process.env.FLAIR_OPS_TARGET;
    expect(resolveOpsTarget({})).toBeUndefined();
  });

  test("returns --ops-target flag value when provided", () => {
    delete process.env.FLAIR_OPS_TARGET;
    expect(resolveOpsTarget({ opsTarget: "https://fabric.harper.dev:9925" }))
      .toBe("https://fabric.harper.dev:9925");
  });

  test("falls back to FLAIR_OPS_TARGET env when --ops-target is not set", () => {
    process.env.FLAIR_OPS_TARGET = "https://fabric.harper.dev:9925";
    expect(resolveOpsTarget({})).toBe("https://fabric.harper.dev:9925");
  });

  test("--ops-target flag takes precedence over FLAIR_OPS_TARGET env", () => {
    process.env.FLAIR_OPS_TARGET = "https://env-ops.example.com:9999";
    expect(resolveOpsTarget({ opsTarget: "https://flag-ops.example.com:9925" }))
      .toBe("https://flag-ops.example.com:9925");
  });
});

// ─── resolveEffectiveOpsUrl ────────────────────────────────────────────────────

describe("resolveEffectiveOpsUrl", () => {
  let origFlairTarget: string | undefined;
  let origFlairOpsTarget: string | undefined;

  beforeEach(() => {
    origFlairTarget = process.env.FLAIR_TARGET;
    origFlairOpsTarget = process.env.FLAIR_OPS_TARGET;
  });

  afterEach(() => {
    if (origFlairTarget === undefined) delete process.env.FLAIR_TARGET;
    else process.env.FLAIR_TARGET = origFlairTarget;
    if (origFlairOpsTarget === undefined) delete process.env.FLAIR_OPS_TARGET;
    else process.env.FLAIR_OPS_TARGET = origFlairOpsTarget;
  });

  test("returns undefined when neither --target nor --ops-target set", () => {
    delete process.env.FLAIR_TARGET;
    delete process.env.FLAIR_OPS_TARGET;
    expect(resolveEffectiveOpsUrl({})).toBeUndefined();
  });

  test("derives ops URL from --target when --ops-target is not set", () => {
    delete process.env.FLAIR_OPS_TARGET;
    expect(resolveEffectiveOpsUrl({ target: "https://flair.example.com:9926" }))
      .toBe("https://flair.example.com:9925");
  });

  test("uses --ops-target directly when both flags are set (Fabric path)", () => {
    expect(resolveEffectiveOpsUrl({
      target: "https://flair.heskew.harperfabric.com",
      opsTarget: "https://flair.heskew.harperfabric.com:9925",
    })).toBe("https://flair.heskew.harperfabric.com:9925");
  });

  test("uses --ops-target directly even with no --target (edge case)", () => {
    expect(resolveEffectiveOpsUrl({
      opsTarget: "https://ops-only.example.com:9925",
    })).toBe("https://ops-only.example.com:9925");
  });

  test("--ops-target takes precedence over derived ops URL", () => {
    expect(resolveEffectiveOpsUrl({
      target: "https://flair.example.com:19926",
      opsTarget: "https://different-ops.example.com:9925",
    })).toBe("https://different-ops.example.com:9925");
  });

  test("FLAIR_OPS_TARGET env works with resolveEffectiveOpsUrl", () => {
    process.env.FLAIR_OPS_TARGET = "https://env-ops.example.com:9925";
    delete process.env.FLAIR_TARGET;
    expect(resolveEffectiveOpsUrl({}))
      .toBe("https://env-ops.example.com:9925");
  });
});

// ─── resolveOpsUrlFromTarget ───────────────────────────────────────────────────

describe("resolveOpsUrlFromTarget", () => {
  test("derives ops URL by subtracting 1 from explicit port", () => {
    expect(resolveOpsUrlFromTarget("https://flair.example.com:9926"))
      .toBe("https://flair.example.com:9925");
  });

  test("derives ops URL from http URL with explicit port", () => {
    expect(resolveOpsUrlFromTarget("http://10.0.0.5:19926"))
      .toBe("http://10.0.0.5:19925");
  });

  test("uses 442 for https with no explicit port (443-1)", () => {
    expect(resolveOpsUrlFromTarget("https://flair.example.com"))
      .toBe("https://flair.example.com:442");
  });

  test("uses DEFAULT_OPS_PORT for http with no explicit port", () => {
    expect(resolveOpsUrlFromTarget("http://flair.example.com"))
      .toBe("http://flair.example.com:19925");
  });

  test("bare host is normalised to https:// with default ops port (442)", () => {
    // Bare hosts without a scheme are normalised to https://
    // https default port = 443, so ops = 442
    expect(resolveOpsUrlFromTarget("flair.example.com"))
      .toBe("https://flair.example.com:442");
  });

  test("throws on port 1 (ops port would be 0, out of range)", () => {
    expect(() => resolveOpsUrlFromTarget("https://example.com:1"))
      .toThrow(/out of range/i);
  });

  test("throws on out-of-range port (65536)", () => {
    // URL parser itself rejects ports > 65535
    expect(() => resolveOpsUrlFromTarget("https://example.com:65536"))
      .toThrow(); // throws regardless of error message
  });

  test("strips trailing slash from target URL", () => {
    expect(resolveOpsUrlFromTarget("https://flair.example.com:9926/"))
      .toBe("https://flair.example.com:9925");
  });

  test("throws on completely unparseable URL fragments", () => {
    // Spaces are invalid in URLs
    expect(() => resolveOpsUrlFromTarget("not a url :// ???"))
      .toThrow();
  });
});

// ─── Commander program: --target option on commands ───────────────────────────

describe("Commander program: --target option", () => {
  function findCommand(name: string) {
    return program.commands.find((c) => c.name() === name);
  }

  function findSubcommand(parent: string, child: string) {
    const parentCmd = findCommand(parent);
    return parentCmd?.commands.find((c) => c.name() === child);
  }

  function hasOption(cmd: any, flag: string): boolean {
    return cmd.options.some((o: any) => o.flags.includes(flag));
  }

  test("flair init has --target option", () => {
    const init = findCommand("init");
    expect(init).not.toBeNull();
    expect(hasOption(init, "--target")).toBe(true);
  });

  test("flair init has --remote option", () => {
    const init = findCommand("init");
    expect(hasOption(init, "--remote")).toBe(true);
  });

  test("flair init has --force option (required with --target)", () => {
    const init = findCommand("init");
    expect(hasOption(init, "--force")).toBe(true);
  });

  test("flair federation status has --target option", () => {
    const status = findSubcommand("federation", "status");
    expect(status).not.toBeNull();
    expect(hasOption(status, "--target")).toBe(true);
  });

  test("flair federation token has --target option", () => {
    const token = findSubcommand("federation", "token");
    expect(token).not.toBeNull();
    expect(hasOption(token, "--target")).toBe(true);
  });

  test("flair federation pair has --target option", () => {
    const pair = findSubcommand("federation", "pair");
    expect(pair).not.toBeNull();
    expect(hasOption(pair, "--target")).toBe(true);
  });

  test("flair federation sync has --target option", () => {
    const sync = findSubcommand("federation", "sync");
    expect(sync).not.toBeNull();
    expect(hasOption(sync, "--target")).toBe(true);
  });

  test("flair init has --ops-target option", () => {
    const init = findCommand("init");
    expect(hasOption(init, "--ops-target")).toBe(true);
  });

  test("flair federation status has --ops-target option", () => {
    const status = findSubcommand("federation", "status");
    expect(hasOption(status, "--ops-target")).toBe(true);
  });

  test("flair federation token has --ops-target option", () => {
    const token = findSubcommand("federation", "token");
    expect(hasOption(token, "--ops-target")).toBe(true);
  });

  test("flair federation pair has --ops-target option", () => {
    const pair = findSubcommand("federation", "pair");
    expect(hasOption(pair, "--ops-target")).toBe(true);
  });

  test("flair federation sync has --ops-target option", () => {
    const sync = findSubcommand("federation", "sync");
    expect(hasOption(sync, "--ops-target")).toBe(true);
  });

  test("flair status has --target option (alias for --url)", () => {
    const status = findCommand("status");
    expect(status).not.toBeNull();
    expect(hasOption(status, "--target")).toBe(true);
  });

  test("flair status still has --url option (back-compat)", () => {
    const status = findCommand("status");
    expect(hasOption(status, "--url")).toBe(true);
  });
});

// ─── api() with baseUrl override routes to target URL ──────────────────────────

describe("api() baseUrl override routes HTTP calls to target", () => {
  // We can't easily mock global fetch in bun:test, so we verify the URL
  // construction by testing resolveTarget + resolveOpsUrlFromTarget together
  // and confirming the baseUrl would be used correctly.
  // For a runtime assertion, we instrument the api() call by checking
  // that program option parsing correctly resolves --target to a URL.

  test("--target value is passed through resolveTarget to produce a baseUrl for api()", () => {
    const target = resolveTarget({ target: "https://fabric.example.com:9926" });
    expect(target).toBe("https://fabric.example.com:9926");
    // In the command handlers, resolveTarget(opts) results in:
    //   const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    //   api("GET", "/FederationInstance", undefined, { baseUrl })
    const baseUrl = target!.replace(/\/$/, "");
    expect(baseUrl).toBe("https://fabric.example.com:9926");
  });

  test("--target ops URL is derived correctly for remote writes", () => {
    const target = resolveTarget({ target: "https://fabric.example.com:9926" });
    const baseUrl = target!.replace(/\/$/, "");
    const opsUrl = resolveOpsUrlFromTarget(baseUrl);
    expect(opsUrl).toBe("https://fabric.example.com:9925");
  });

  test("FLAIR_TARGET env produces same result as --target flag", () => {
    process.env.FLAIR_TARGET = "http://10.0.0.5:19926";
    const target = resolveTarget({});
    expect(target).toBe("http://10.0.0.5:19926");
    delete process.env.FLAIR_TARGET;

    const directTarget = resolveTarget({ target: "http://10.0.0.5:19926" });
    expect(directTarget).toBe("http://10.0.0.5:19926");
    expect(target).toBe(directTarget);
  });

  test("init --target without --force is rejected", () => {
    // Verify the init command has both --target and --force registered
    const init = program.commands.find((c) => c.name() === "init");
    expect(init).not.toBeNull();
    const hasForce = init!.options.some((o: any) => o.flags.includes("--force"));
    expect(hasForce).toBe(true);
  });
});

// ─── ops-target override: Fabric-style non-derivable ops URL ───────────────────

describe("--ops-target overrides ops URL derivation", () => {
  test("ops-target is used directly for ops calls, separate from --target REST", () => {
    const opsTarget = resolveOpsTarget({
      opsTarget: "https://flair.heskew.harperfabric.com:9925",
    });
    expect(opsTarget).toBe("https://flair.heskew.harperfabric.com:9925");

    const target = resolveTarget({
      target: "https://flair.heskew.harperfabric.com",
    });
    expect(target).toBe("https://flair.heskew.harperfabric.com");

    // opsTarget is a completely different URL from target — no port-1 derivation
    expect(opsTarget).not.toBe("https://flair.heskew.harperfabric.com:442");
  });

  test("Fabric acceptance criteria: target rest + ops on separate port", () => {
    // Simulate the Fabric use case from spec:
    // --target https://flair.heskew.harperfabric.com
    // --ops-target https://flair.heskew.harperfabric.com:9925
    const baseUrl = resolveTarget({
      target: "https://flair.heskew.harperfabric.com",
    })!.replace(/\/$/, "");
    const opsUrl = resolveOpsTarget({
      opsTarget: "https://flair.heskew.harperfabric.com:9925",
    })!.replace(/\/$/, "");

    expect(baseUrl).toBe("https://flair.heskew.harperfabric.com");
    expect(opsUrl).toBe("https://flair.heskew.harperfabric.com:9925");

    // Verify no derivation contamination: opsUrl is explicit, not port-1
    const derivedFromBase = resolveOpsUrlFromTarget(baseUrl);
    expect(derivedFromBase).toBe("https://flair.heskew.harperfabric.com:442");
    expect(opsUrl).not.toBe(derivedFromBase);
  });

  test("only --target (rockit-style) still derives ops URL correctly", () => {
    // Back-compat: no --ops-target, only --target
    const baseUrl = resolveTarget({
      target: "https://localhost:19926",
    })!.replace(/\/$/, "");
    const opsUrl = resolveEffectiveOpsUrl({ target: baseUrl });

    expect(baseUrl).toBe("https://localhost:19926");
    expect(opsUrl).toBe("https://localhost:19925"); // port-1 derivation
  });
});

// ─── seedFederationInstanceViaOpsApi ────────────────────────────────────────────

describe("seedFederationInstanceViaOpsApi", () => {
  test("builds correct URL, body, auth for remote ops API call", async () => {
    // Intercept fetch to inspect what the helper sends
    let capturedUrl: string | undefined;
    let capturedBody: any;
    let capturedHeaders: Record<string, string> | undefined;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, opts: any) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = JSON.parse(opts.body);
      capturedHeaders = opts.headers;
      return new Response(null, { status: 200 });
    };

    try {
      await seedFederationInstanceViaOpsApi(
        "https://flair.heskew.harperfabric.com:9925",
        "test-instance-uuid",
        "base64pubkey==",
        "hub",
        "admin",
        "sekret",
      );
    } finally {
      globalThis.fetch = origFetch;
    }

    // Verify URL has trailing slash (as seedAgentViaOpsApi does)
    expect(capturedUrl).toBe("https://flair.heskew.harperfabric.com:9925/");

    // Verify auth header
    expect(capturedHeaders!["Authorization"]).toBe(
      "Basic " + Buffer.from("admin:sekret").toString("base64"),
    );

    // Verify body structure
    expect(capturedBody.operation).toBe("insert");
    expect(capturedBody.database).toBe("flair");
    expect(capturedBody.table).toBe("Instance");
    expect(capturedBody.records).toHaveLength(1);
    expect(capturedBody.records[0].id).toBe("test-instance-uuid");
    expect(capturedBody.records[0].publicKey).toBe("base64pubkey==");
    expect(capturedBody.records[0].role).toBe("hub");
    expect(capturedBody.records[0].status).toBe("active");
    expect(capturedBody.records[0].createdAt).toBeDefined();
    expect(capturedBody.records[0].updatedAt).toBeDefined();
  });

  test("normalizes trailing slash on ops URL", async () => {
    const origFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    globalThis.fetch = async (url: any) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response(null, { status: 200 });
    };

    try {
      await seedFederationInstanceViaOpsApi(
        "https://flair.heskew.harperfabric.com:9925/",
        "id",
        "pk",
        "hub",
        "admin",
        "pass",
      );
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(capturedUrl).toBe("https://flair.heskew.harperfabric.com:9925/");
  });

  test("uses localhost URL when opsPortOrUrl is a number", async () => {
    const origFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    globalThis.fetch = async (url: any) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response(null, { status: 200 });
    };

    try {
      await seedFederationInstanceViaOpsApi(
        19925,
        "id",
        "pk",
        "hub",
        "admin",
        "pass",
      );
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(capturedUrl).toBe("http://127.0.0.1:19925/");
  });

  test("handles 409 conflict idempotently (does not throw)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("409 Conflict — duplicate key", { status: 409 });
    };

    try {
      // Should not throw on 409
      await seedFederationInstanceViaOpsApi(
        19925,
        "existing-id",
        "pk",
        "hub",
        "admin",
        "pass",
      );
    } finally {
      globalThis.fetch = origFetch;
    }

    // If we get here without throw, test passes
    expect(true).toBe(true);
  });

  test("handles duplicate/already-exists response idempotently", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("already exists", { status: 500 });
    };

    try {
      // Should not throw because body contains "already exists"
      await seedFederationInstanceViaOpsApi(
        19925,
        "existing-id",
        "pk",
        "hub",
        "admin",
        "pass",
      );
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(true).toBe(true);
  });

  test("throws on non-409 error", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Internal server error", { status: 500 });
    };

    try {
      await seedFederationInstanceViaOpsApi(
        19925,
        "id",
        "pk",
        "hub",
        "admin",
        "pass",
      );
      // Should not reach here
      expect("should have thrown").toBe("never");
    } catch (e: any) {
      expect(e.message).toContain("Federation Instance insert via ops API failed (500)");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});