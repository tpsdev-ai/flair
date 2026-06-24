// a2a-url.test.ts — flair#507
//
// The A2A agent-card `url` and the streaming catch-up self-fetch previously
// hardcoded port 9926. But a default local install listens on
// DEFAULT_HTTP_PORT (19926), so discovery advertised a DEAD port — a remote
// A2A peer following the agent card couldn't reach the instance.
//
// These tests exercise the REAL resolution helpers (imported, not reproduced)
// so the predicate can't silently drift from production.

import { describe, test, expect } from "bun:test";
import {
  DEFAULT_HTTP_PORT,
  localBaseUrl,
  resolvePublicBaseUrl,
} from "../../resources/a2a-url";

describe("DEFAULT_HTTP_PORT", () => {
  test("matches the CLI's default HTTP port (19926), not the legacy 9926", () => {
    expect(DEFAULT_HTTP_PORT).toBe(19926);
  });
});

describe("localBaseUrl (loopback self-call target)", () => {
  test("falls back to DEFAULT_HTTP_PORT when HTTP_PORT is unset", () => {
    expect(localBaseUrl({} as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:19926");
  });

  test("never advertises the dead legacy 9926 by default (flair#507)", () => {
    expect(localBaseUrl({} as NodeJS.ProcessEnv)).not.toContain(":9926");
  });

  test("uses the real listening port from HTTP_PORT when set", () => {
    expect(localBaseUrl({ HTTP_PORT: "9926" } as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:9926");
    expect(localBaseUrl({ HTTP_PORT: "31415" } as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:31415");
  });
});

describe("resolvePublicBaseUrl (agent-card url)", () => {
  test("FLAIR_PUBLIC_URL wins and is trailing-slash trimmed", () => {
    expect(
      resolvePublicBaseUrl(undefined, { FLAIR_PUBLIC_URL: "https://flair.example.com/" } as NodeJS.ProcessEnv),
    ).toBe("https://flair.example.com");
  });

  test("no env, no headers → local fallback on the REAL HTTP_PORT, not 9926", () => {
    const out = resolvePublicBaseUrl(undefined, { HTTP_PORT: "19926" } as NodeJS.ProcessEnv);
    expect(out).toBe("http://127.0.0.1:19926");
    expect(out).not.toContain(":9926");
  });

  test("no env, no headers, no HTTP_PORT → DEFAULT_HTTP_PORT (19926)", () => {
    expect(resolvePublicBaseUrl(undefined, {} as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:19926");
  });

  test("derives from a Host header with a port (Map-style headers)", () => {
    const headers = new Map<string, string>([["host", "192.168.1.10:19926"]]);
    const req = { headers: { get: (n: string) => headers.get(n.toLowerCase()) } };
    expect(resolvePublicBaseUrl(req, {} as NodeJS.ProcessEnv)).toBe("http://192.168.1.10:19926");
  });

  test("derives from a Host header (asObject-style headers)", () => {
    const req = { headers: { asObject: { Host: "192.168.1.10:19926" } } };
    expect(resolvePublicBaseUrl(req, {} as NodeJS.ProcessEnv)).toBe("http://192.168.1.10:19926");
  });

  test("honors X-Forwarded-Proto/Host from a reverse proxy", () => {
    const req = {
      headers: {
        asObject: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "flair.example.com",
          Host: "internal-host:19926",
        },
      },
    };
    expect(resolvePublicBaseUrl(req, {} as NodeJS.ProcessEnv)).toBe("https://flair.example.com");
  });

  test("bare host (no port, no proxy header) assumes https", () => {
    const req = { headers: { asObject: { Host: "flair.example.com" } } };
    expect(resolvePublicBaseUrl(req, {} as NodeJS.ProcessEnv)).toBe("https://flair.example.com");
  });
});
