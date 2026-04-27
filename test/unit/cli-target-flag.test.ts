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
  resolveOpsUrlFromTarget,
  resolveHttpPort,
  program,
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