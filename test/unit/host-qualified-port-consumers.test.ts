/**
 * host-qualified-port-consumers.test.ts — consumer side of the ops-bind port
 * slice: every URL builder that interpolates `HTTP_PORT` after a hostname must
 * stay correct when that value is **host-qualified** (`127.0.0.1:19926`,
 * `[::1]:19926`), not just bare (`19926`).
 *
 * Why this is the deliverable: the qualified form is what the ops-API bind
 * narrowing will start writing. Patching the emitters before the consumers
 * understand the qualified form would render `http://127.0.0.1:127.0.0.1:19926`
 * — rejected by `new URL()` — satisfying every bind check while making Flair
 * unreachable to its own features. These five consumers are that blast radius,
 * so they are pinned here first.
 *
 * Table-driven over all five consumers × {absent, bare, host-qualified,
 * IPv6-literal-qualified, out-of-range} — each on the default port and on a
 * non-default port. On the pre-change tree the qualified and out-of-range cases
 * are RED: interpolation produced `http://127.0.0.1:127.0.0.1:19926` (doubled
 * host) or `http://127.0.0.1:70000` (port above 65535), both rejected by
 * `new URL()`.
 *
 * The modules that pull `harper` at import time (AdminInstance, XAA,
 * embedding-stamp) are loaded with a `harper` mock — the same superset shape
 * test/unit/admin-instance-endpoints.test.ts uses — so the real resolvers are
 * exercised rather than a re-derivation of them.
 */
import { mock, describe, test, expect, afterEach } from "bun:test";

// AdminInstance imports resources/mcp-oauth.ts; keep its load-time registration
// out of the way (flag is off in the unit lane anyway).
process.env.FLAIR_MCP_NO_AUTOSTART = "1";

// A constructible stub for every `databases.flair.<table>` access AND for
// `Resource`: resources/XAA.ts does `class IdpConfig extends
// databases.flair.IdpConfig` at import time, so the mocked member has to be a
// real constructor, not a plain object.
const dbStub: any = new Proxy(function Noop() {}, {
  get: (_t, prop) => (prop === "then" ? undefined : dbStub),
  apply: () => undefined,
  construct: () => ({}),
});
mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: dbStub,
  databases: { flair: dbStub },
}));

const { DEFAULT_HTTP_PORT, localBaseUrl } = await import("../../resources/a2a-url.ts");
const { oauthPublicBaseUrl } = await import("../../resources/oauth-discovery.ts");
const { resolvePublicUrl } = await import("../../resources/AdminInstance.ts");
const { jwtBearerBaseUrl } = await import("../../resources/XAA.ts");
const { resolveSelfBaseUrl } = await import("../../resources/migrations/embedding-stamp.ts");

interface PortCase {
  label: string;
  httpPort: string | undefined;
  /** Host the consumer is expected to emit in the URL (all five use loopback). */
  host: string;
  /** Port the consumer is expected to emit in the URL. */
  port: string;
}

const CASES: PortCase[] = [
  // The four shapes on the default port.
  { label: "absent", httpPort: undefined, host: "127.0.0.1", port: String(DEFAULT_HTTP_PORT) },
  { label: "bare", httpPort: "19926", host: "127.0.0.1", port: "19926" },
  { label: "host-qualified", httpPort: "127.0.0.1:19926", host: "127.0.0.1", port: "19926" },
  { label: "ipv6-literal-qualified", httpPort: "[::1]:19926", host: "127.0.0.1", port: "19926" },
  // Non-default port: a parser that silently drops the host (or the whole
  // qualified value) falls back to DEFAULT_HTTP_PORT and passes the cases above
  // by coincidence — these catch that, and a wrong port, not just a bad URL.
  { label: "bare (non-default)", httpPort: "31415", host: "127.0.0.1", port: "31415" },
  { label: "host-qualified (non-default)", httpPort: "127.0.0.1:31415", host: "127.0.0.1", port: "31415" },
  { label: "ipv6-literal-qualified (non-default)", httpPort: "[::1]:31415", host: "127.0.0.1", port: "31415" },
  // Out-of-range: `harperPortValue` rejects these, so each consumer must fall
  // back to DEFAULT_HTTP_PORT. Before the bound, the consumer interpolated the
  // raw value and produced `http://127.0.0.1:70000`, which `new URL()` rejects
  // (it refuses a port above 65535) — a throwing URL, not a usable one. These
  // rows are RED on the pre-change tree for every consumer.
  { label: "out-of-range (65536)", httpPort: "65536", host: "127.0.0.1", port: String(DEFAULT_HTTP_PORT) },
  { label: "out-of-range (70000)", httpPort: "70000", host: "127.0.0.1", port: String(DEFAULT_HTTP_PORT) },
  { label: "host-qualified out-of-range", httpPort: "127.0.0.1:70000", host: "127.0.0.1", port: String(DEFAULT_HTTP_PORT) },
  // Boundary: the largest valid port must still round-trip (the bound rejects
  // 65536, not 65535).
  { label: "boundary (65535)", httpPort: "65535", host: "127.0.0.1", port: "65535" },
];

/** The five consumers. Each reads `process.env` (via `env`) except localBaseUrl,
 *  which takes the env map explicitly; `build` is called after the case's
 *  process.env is staged. */
const CONSUMERS: Array<{ name: string; build: (env: NodeJS.ProcessEnv) => string }> = [
  { name: "resources/oauth-discovery.ts oauthPublicBaseUrl", build: () => oauthPublicBaseUrl() },
  { name: "resources/AdminInstance.ts resolvePublicUrl", build: () => resolvePublicUrl() },
  { name: "resources/XAA.ts jwtBearerBaseUrl", build: () => jwtBearerBaseUrl() },
  { name: "resources/migrations/embedding-stamp.ts resolveSelfBaseUrl", build: () => resolveSelfBaseUrl() },
  { name: "resources/a2a-url.ts localBaseUrl", build: (env) => localBaseUrl(env) },
];

const SAVED_HTTP_PORT = process.env.HTTP_PORT;
const SAVED_PUBLIC_URL = process.env.FLAIR_PUBLIC_URL;

afterEach(() => {
  if (SAVED_HTTP_PORT === undefined) delete process.env.HTTP_PORT;
  else process.env.HTTP_PORT = SAVED_HTTP_PORT;
  if (SAVED_PUBLIC_URL === undefined) delete process.env.FLAIR_PUBLIC_URL;
  else process.env.FLAIR_PUBLIC_URL = SAVED_PUBLIC_URL;
});

function stageEnv(c: PortCase): void {
  if (c.httpPort === undefined) delete process.env.HTTP_PORT;
  else process.env.HTTP_PORT = c.httpPort;
  // The loopback-fallback branch is under test; FLAIR_PUBLIC_URL would short-circuit it.
  delete process.env.FLAIR_PUBLIC_URL;
}

for (const c of CASES) {
  describe(`HTTP_PORT ${c.label}`, () => {
    for (const consumer of CONSUMERS) {
      test(`${consumer.name} produces a valid URL on port ${c.port}`, () => {
        stageEnv(c);
        // Throws (RED) on the pre-change tree for the qualified and out-of-range
        // rows: a qualified value yielded `http://127.0.0.1:127.0.0.1:19926` and
        // an out-of-range value yielded `http://127.0.0.1:70000` — both rejected
        // by `new URL()`.
        const u = new URL(consumer.build(process.env));
        expect(u.hostname).toBe(c.host);
        expect(u.port).toBe(c.port);
      });
    }
  });
}

// ─── embedding-stamp's credentialed self-call target must stay loopback ──────

describe("resources/migrations/embedding-stamp.ts — loopback self-call target", () => {
  // `regenViaHttpPut` sends `Authorization: Basic admin:<password>` to this
  // URL, so it must never be FLAIR_PUBLIC_URL (a remote / reverse-proxied
  // origin). Regression test for the credential leak: RED on the pre-change
  // tree, where resolveSelfBaseUrl returned FLAIR_PUBLIC_URL.
  test("stays loopback even when FLAIR_PUBLIC_URL is set", () => {
    const url = resolveSelfBaseUrl({ FLAIR_PUBLIC_URL: "https://flair.example.com" } as NodeJS.ProcessEnv);
    expect(url).toBe(`http://127.0.0.1:${DEFAULT_HTTP_PORT}`);
    expect(url).not.toContain("flair.example.com");
  });

  test("stays loopback (on the real port) when FLAIR_PUBLIC_URL and HTTP_PORT are both set", () => {
    expect(
      resolveSelfBaseUrl({
        FLAIR_PUBLIC_URL: "https://flair.example.com",
        HTTP_PORT: "31415",
      } as NodeJS.ProcessEnv),
    ).toBe("http://127.0.0.1:31415");
  });

  test("falls back to DEFAULT_HTTP_PORT (19926), not the legacy early-install 9926", () => {
    const url = resolveSelfBaseUrl({} as NodeJS.ProcessEnv);
    expect(url).toBe(`http://127.0.0.1:${DEFAULT_HTTP_PORT}`);
    expect(url).not.toContain(":9926");
  });
});
