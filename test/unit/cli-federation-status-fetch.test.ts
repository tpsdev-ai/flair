/**
 * cli-federation-status-fetch.test.ts — flair#1108
 *
 * `flair federation status` used to print a bare "fetch failed" when the
 * probe URL was wrong. The helpers below are the contract: the failure
 * message names the URL that was attempted and the setting that controls
 * it. The action callback itself calls api() + process.exit, so (same
 * convention as cli-rem-rapid.test.ts) the helpers are what we unit-test.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  describeFederationStatusFetchFailed,
  federationStatusUrlSetting,
  isFederationStatusAuthFailure,
  rewriteFederationStatusFetchFailed,
} from "../../src/cli.ts";

describe("describeFederationStatusFetchFailed", () => {
  test("names the probed URL and the setting that controls it", () => {
    const msg = describeFederationStatusFetchFailed(
      "http://127.0.0.1:9926",
      "FLAIR_URL or --port",
    );
    expect(msg).toContain("http://127.0.0.1:9926");
    expect(msg).toContain("FLAIR_URL");
    expect(msg).toBe("fetch failed against http://127.0.0.1:9926 (set FLAIR_URL or --port)");
  });

  test("names --target when that is the setting that produced the URL", () => {
    const msg = describeFederationStatusFetchFailed(
      "https://hub.example:8443",
      "--target",
    );
    expect(msg).toContain("https://hub.example:8443");
    expect(msg).toContain("--target");
  });
});

describe("federationStatusUrlSetting", () => {
  let origUrl: string | undefined;
  let origTarget: string | undefined;

  beforeEach(() => {
    origUrl = process.env.FLAIR_URL;
    origTarget = process.env.FLAIR_TARGET;
    delete process.env.FLAIR_URL;
    delete process.env.FLAIR_TARGET;
  });

  afterEach(() => {
    if (origUrl === undefined) delete process.env.FLAIR_URL;
    else process.env.FLAIR_URL = origUrl;
    if (origTarget === undefined) delete process.env.FLAIR_TARGET;
    else process.env.FLAIR_TARGET = origTarget;
  });

  test("default (no flag, no env) names FLAIR_URL or --port", () => {
    expect(federationStatusUrlSetting({})).toBe("FLAIR_URL or --port");
  });

  test("--target wins over env", () => {
    process.env.FLAIR_URL = "http://env-url";
    process.env.FLAIR_TARGET = "http://env-target";
    expect(federationStatusUrlSetting({ target: "http://flag-target", port: 19926 })).toBe("--target");
  });

  test("FLAIR_TARGET wins over FLAIR_URL", () => {
    process.env.FLAIR_TARGET = "http://env-target";
    process.env.FLAIR_URL = "http://env-url";
    expect(federationStatusUrlSetting({})).toBe("FLAIR_TARGET");
  });

  test("FLAIR_URL is named when it produced the URL", () => {
    process.env.FLAIR_URL = "http://127.0.0.1:19926";
    expect(federationStatusUrlSetting({})).toBe("FLAIR_URL");
  });

  test("--port is named when it produced the URL", () => {
    expect(federationStatusUrlSetting({ port: 19926 })).toBe("--port");
  });
});

describe("rewriteFederationStatusFetchFailed", () => {
  test("rewrites a TypeError('fetch failed') to name URL and setting", () => {
    const rewritten = rewriteFederationStatusFetchFailed(
      new TypeError("fetch failed"),
      "http://127.0.0.1:9926",
      "FLAIR_URL or --port",
    );
    expect(rewritten).toBeInstanceOf(Error);
    const msg = (rewritten as Error).message;
    expect(msg).toContain("http://127.0.0.1:9926");
    expect(msg).toContain("FLAIR_URL");
  });

  test("rewrites Bun's Unable-to-connect error the same way", () => {
    const rewritten = rewriteFederationStatusFetchFailed(
      new Error("Unable to connect. Is the computer able to access the url?"),
      "http://127.0.0.1:59999",
      "--target",
    );
    const msg = (rewritten as Error).message;
    expect(msg).toContain("http://127.0.0.1:59999");
    expect(msg).toContain("--target");
  });

  test("leaves a non-fetch error (auth, HTTP) unchanged", () => {
    const err = new Error("missing_or_invalid_authorization");
    expect(rewriteFederationStatusFetchFailed(err, "http://x", "FLAIR_URL")).toBe(err);
  });
});

describe("isFederationStatusAuthFailure", () => {
  test("a rewritten fetch-failed against a whole-token 401 URL is not auth", () => {
    // `--port 401`, not 4010: the digit-boundary regex already rejects 4010,
    // so that fixture would still pass if the connect-failure guard were
    // removed. :401 is a whole token — without the guard this is auth-shaped.
    const rewritten = rewriteFederationStatusFetchFailed(
      new TypeError("fetch failed"),
      "http://127.0.0.1:401",
      "--port",
    );
    const msg = (rewritten as Error).message;
    expect(msg).toContain("http://127.0.0.1:401");
    expect(msg).toMatch(/(?:^|\D)401(?:\D|$)/);
    expect(isFederationStatusAuthFailure(rewritten)).toBe(false);
  });

  test("status 401 / missing_or_invalid_authorization stay auth-shaped", () => {
    const withStatus = new Error("HTTP 401");
    (withStatus as { status?: number }).status = 401;
    expect(isFederationStatusAuthFailure(withStatus)).toBe(true);
    expect(isFederationStatusAuthFailure(new Error("missing_or_invalid_authorization"))).toBe(true);
  });
});
