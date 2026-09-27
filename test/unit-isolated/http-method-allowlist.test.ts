/**
 * The auth middleware accepts only the HTTP methods Flair's clients use (GET,
 * HEAD, OPTIONS, POST, PUT, PATCH, DELETE) and answers 405 for any other,
 * before its public-path passthrough and before any auth branch. Isolated
 * because it installs its own harper mock and captures the middleware.
 */
import { describe, it, expect, mock } from "bun:test";

let captured: any = null;

mock.module("harper", () => ({
  databases: {
    flair: {
      Agent: { get: async () => null, search: async function* () {} },
    },
  },
  server: {
    getUser: async () => null,
    http: (fn: any) => { captured = fn; },
  },
  Resource: class {},
}));

await import("../../resources/auth-middleware.ts");
const mw = captured;

function request(method: string, path: string, headers: Record<string, string> = {}) {
  const h = new Headers({ host: "localhost", ...headers });
  return {
    method,
    url: `http://localhost${path}`,
    headers: h,
    user: undefined as any,
  };
}

let passed = 0;
const next = () => { passed++; return new Response("ok", { status: 200 }); };

const ADMIN_BASIC = { authorization: "Basic YWRtaW46cGFzcw==" };
const superUser = { username: "admin", role: { permission: { super_user: true } } };

describe("HTTP method allowlist", () => {
  it("captures the middleware", () => {
    expect(typeof mw).toBe("function");
  });

  for (const method of ["QUERY", "query", "SEARCH", "PROPFIND", "TRACE", "CONNECT", ""]) {
    it(`refuses ${JSON.stringify(method)} with 405 on a table, a public path and an admin request, before any other branch`, async () => {
      for (const [path, headers, user] of [
        ["/Credential/", {}, undefined],
        ["/Memory/", {}, undefined],
        ["/health", {}, undefined],
        ["/Presence", {}, undefined],
        ["/Asset/", ADMIN_BASIC, superUser],
      ] as const) {
        const before = passed;
        const req = request(method, path, headers as any);
        (req as any).user = user;
        const res = await mw(req, next);
        expect(res).toBeInstanceOf(Response);
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE");
        expect((await res.json()).error).toBe("method_not_allowed");
        expect(passed).toBe(before);
        expect((req as any).tpsAgent).toBeUndefined();
      }
    });
  }

  for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "get", "Delete"]) {
    it(`lets ${method} through to the next branch (the public /health passthrough)`, async () => {
      const before = passed;
      const res = await mw(request(method, "/health"), next);
      expect(res.status).toBe(200);
      expect(passed).toBe(before + 1);
    });
  }
});
