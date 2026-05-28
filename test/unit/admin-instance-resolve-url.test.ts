/**
 * admin-instance-resolve-url.test.ts — covers flair#404 (admin pane shows
 * 127.0.0.1 URLs on remote deployments).
 *
 * Tests the predicate logic of `resolvePublicUrl` from
 * resources/AdminInstance.ts. Simulator-pattern (per ops-ketv) — exercises
 * the decision branches without importing the real Resource class (which
 * pulls Harper at import time).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

// Reproduces the predicate at resources/AdminInstance.ts:36-72. Keep this
// in sync with the production function; K&S diff review should verify match.
type HeaderMap = Record<string, string>;
function resolvePublicUrl(
  envPublicUrl: string | undefined,
  headers: HeaderMap = {},
  httpPort: string = "19926",
): string {
  if (envPublicUrl) return envPublicUrl.replace(/\/$/, "");

  const getHeader = (name: string): string | undefined =>
    headers[name] ?? headers[name.toLowerCase()] ?? undefined;

  const fwdProto = getHeader("X-Forwarded-Proto");
  const fwdHost = getHeader("X-Forwarded-Host");
  const host = fwdHost ?? getHeader("Host");

  if (host && /^[\w.\-:]+$/.test(host)) {
    const scheme = fwdProto && (fwdProto === "http" || fwdProto === "https") ? fwdProto : "https";
    const effectiveScheme = fwdProto ? scheme : (host.includes(":") ? "http" : scheme);
    return `${effectiveScheme}://${host}`;
  }

  return `http://127.0.0.1:${httpPort}`;
}

describe("AdminInstance.resolvePublicUrl — flair#404", () => {
  test("FLAIR_PUBLIC_URL wins over everything else", () => {
    expect(resolvePublicUrl("https://my-flair.example.com", { Host: "wrong.example.com" }))
      .toBe("https://my-flair.example.com");
  });

  test("trailing slash on env var is stripped", () => {
    expect(resolvePublicUrl("https://my-flair.example.com/", {}))
      .toBe("https://my-flair.example.com");
  });

  test("falls back to localhost when no env var AND no headers", () => {
    expect(resolvePublicUrl(undefined, {})).toBe("http://127.0.0.1:19926");
  });

  test("HTTP_PORT override flows to localhost fallback", () => {
    expect(resolvePublicUrl(undefined, {}, "9926")).toBe("http://127.0.0.1:9926");
  });

  test("Host header drives derivation when no env var, no proxy headers", () => {
    // Bare host (no port) — assume https. Most cases: TLS-terminated direct.
    expect(resolvePublicUrl(undefined, { Host: "my-flair.example.com" }))
      .toBe("https://my-flair.example.com");
  });

  test("Host header with port → assume http (likely direct dev/test)", () => {
    expect(resolvePublicUrl(undefined, { Host: "192.168.1.10:19926" }))
      .toBe("http://192.168.1.10:19926");
  });

  test("X-Forwarded-Proto + X-Forwarded-Host (typical reverse-proxy setup)", () => {
    expect(resolvePublicUrl(undefined, {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "flair.example.com",
      "Host": "internal-host:19926", // proxy's internal hostname
    })).toBe("https://flair.example.com");
  });

  test("X-Forwarded-Proto alone (Host carries the public name)", () => {
    expect(resolvePublicUrl(undefined, {
      "X-Forwarded-Proto": "https",
      "Host": "flair.example.com",
    })).toBe("https://flair.example.com");
  });

  test("X-Forwarded-Proto=http honored (rare but valid)", () => {
    expect(resolvePublicUrl(undefined, {
      "X-Forwarded-Proto": "http",
      "Host": "flair.example.com",
    })).toBe("http://flair.example.com");
  });

  test("malicious Host with newline/CRLF rejected → localhost fallback", () => {
    // Header injection defence: regex /^[\w.\-:]+$/ rejects \r\n etc.
    expect(resolvePublicUrl(undefined, { Host: "evil.com\r\nSet-Cookie: x=1" }))
      .toBe("http://127.0.0.1:19926");
  });

  test("malicious Host with embedded spaces rejected", () => {
    expect(resolvePublicUrl(undefined, { Host: "evil.com /AdminMemory" }))
      .toBe("http://127.0.0.1:19926");
  });

  test("malicious X-Forwarded-Host rejected", () => {
    expect(resolvePublicUrl(undefined, {
      "X-Forwarded-Host": "evil.com\nLog: pwned",
      "Host": "fine.example.com",
    })).toBe("http://127.0.0.1:19926");
  });

  test("X-Forwarded-Proto with garbage value falls back to https default", () => {
    // Only "http" | "https" honored; anything else → default scheme path.
    expect(resolvePublicUrl(undefined, {
      "X-Forwarded-Proto": "javascript",
      "Host": "flair.example.com",
    })).toBe("https://flair.example.com");
  });
});
