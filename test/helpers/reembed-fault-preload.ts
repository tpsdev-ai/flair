/**
 * reembed-fault-preload.ts — a `node --import` module for the reembed
 * integration tests: records every `fetch` the CLI child sends and can
 * substitute chosen answers, so a run against a real Harper can still exercise
 * a PATCH or readback failure.
 *
 * Every input is an env var, so one preload serves every case:
 *   - FLAIR_TEST_FETCH_LOG names a file; each call appends one JSON line
 *     `{ method, host, path, adminAuthorization }` (host is `hostname:port`).
 *   - FLAIR_TEST_FETCH_EVENTS names a file; each call appends one JSON line
 *     `{ seq, method, path, request, response }` with the response parsed.
 *   - FLAIR_TEST_PAIR_OS_READS_UNAVAILABLE=1 stubs the OS listener table to
 *     `unavailable` through `setInstancePairOsReadsForTests`.
 *   - FLAIR_TEST_REFUSE_PATCH_JSON maps a `/Memory/<id>` path to a status.
 *   - FLAIR_TEST_THROW_PATCH_JSON maps a `/Memory/<id>` path to a message; a
 *     PATCH to it throws an Error carrying that message.
 *   - FLAIR_TEST_REFUSE_GET_JSON maps a `/Memory/<id>` path to a status.
 *   - FLAIR_TEST_REFUSE_OPS_READBACK_JSON maps a Memory id to a status for a
 *     `search_by_id` answer.
 *   - FLAIR_TEST_REWRITE_OPS_READBACK_JSON maps a Memory id to a 2xx body.
 *   - FLAIR_TEST_REWRITE_GET_READBACK_JSON maps a Memory id to a 2xx body.
 *   - FLAIR_TEST_REWRITE_HTTP_INSTANCE_JSON answers every GET /Instance/ with
 *     this body.
 *
 * Nothing here is used outside tests.
 */
import { appendFileSync } from "node:fs";

function jsonMap(name: string): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const logPath = process.env.FLAIR_TEST_FETCH_LOG;
const eventsPath = process.env.FLAIR_TEST_FETCH_EVENTS;
const refusePatches = jsonMap("FLAIR_TEST_REFUSE_PATCH_JSON");
const throwPatches = jsonMap("FLAIR_TEST_THROW_PATCH_JSON");
const refuseGets = jsonMap("FLAIR_TEST_REFUSE_GET_JSON");
const refuseOpsReadbacks = jsonMap("FLAIR_TEST_REFUSE_OPS_READBACK_JSON");
const rewriteOpsReadbacks = jsonMap("FLAIR_TEST_REWRITE_OPS_READBACK_JSON");
const rewriteGetReadbacks = jsonMap("FLAIR_TEST_REWRITE_GET_READBACK_JSON");
const rewriteHttpInstance = process.env.FLAIR_TEST_REWRITE_HTTP_INSTANCE_JSON;

if (process.env.FLAIR_TEST_PAIR_OS_READS_UNAVAILABLE === "1") {
  const pair = await import(new URL("../../dist/lib/local-instance-pair.js", import.meta.url).href);
  pair.setInstancePairOsReadsForTests({
    listeners: () => ({ kind: "unavailable", reason: "stubbed unavailable by the test", remedy: "none" }),
  });
}

const realFetch = globalThis.fetch;
let seq = 0;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ method, host: `${url.hostname}:${url.port}`, path: url.pathname, adminAuthorization: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("Authorization")?.startsWith("Basic ") ?? false })}\n`);

  let body: { operation?: unknown; ids?: unknown } | undefined;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = undefined;
    }
  }

  const answer = async (): Promise<Response> => {
    const patchStatus = refusePatches[url.pathname];
    if (method === "PATCH" && throwPatches[url.pathname] !== undefined) {
      throw new Error(String(throwPatches[url.pathname]));
    }
    if (method === "PATCH" && patchStatus !== undefined) {
      return new Response(JSON.stringify({ error: "refused by the test" }), {
        status: Number(patchStatus), headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET" && url.pathname === "/Instance/" && rewriteHttpInstance !== undefined) {
      return new Response(String(rewriteHttpInstance), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const getStatus = refuseGets[url.pathname];
    if (method === "GET" && getStatus !== undefined) {
      return new Response(JSON.stringify({ error: "refused by the test" }), {
        status: Number(getStatus), headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && body?.operation === "search_by_id" && Array.isArray(body.ids)) {
      const ids = body.ids.map(String);
      const refused = ids.find((id) => refuseOpsReadbacks[id] !== undefined);
      if (refused !== undefined) {
        return new Response(JSON.stringify({ error: "refused by the test" }), {
          status: Number(refuseOpsReadbacks[refused]), headers: { "content-type": "application/json" },
        });
      }
      const rewritten = ids.find((id) => rewriteOpsReadbacks[id] !== undefined);
      if (rewritten !== undefined) {
        return new Response(String(rewriteOpsReadbacks[rewritten]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
    }
    if (method === "GET") {
      const rewritten = Object.keys(rewriteGetReadbacks).find((id) => url.pathname === `/Memory/${encodeURIComponent(id)}`);
      if (rewritten !== undefined) {
        return new Response(String(rewriteGetReadbacks[rewritten]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
    }
    return realFetch(input, init);
  };

  const response = await answer();
  if (eventsPath) {
    let responseBody: unknown = null;
    try {
      responseBody = JSON.parse(await response.clone().text());
    } catch {
      responseBody = null;
    }
    appendFileSync(eventsPath, `${JSON.stringify({ seq: ++seq, method, path: url.pathname, request: body ?? null, response: responseBody })}\n`);
  }
  return response;
}) as typeof fetch;
