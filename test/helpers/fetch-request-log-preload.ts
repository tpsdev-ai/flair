/**
 * fetch-request-log-preload.ts — a `bun --preload` or `node --import` module
 * that records every `fetch` the process sends.
 *
 * When FLAIR_TEST_FETCH_LOG names a file, each call appends one JSON line
 * `{ method, host, path }` (host is `hostname:port`; user info and the query are
 * not recorded) and then sends the request unchanged. A test reads the file to
 * assert which endpoints a CLI run addressed, including that it sent nothing.
 */
import { appendFileSync } from "node:fs";

const logPath = process.env.FLAIR_TEST_FETCH_LOG;

if (logPath) {
  const realFetch = globalThis.fetch;
  const logged = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host = "<unparseable>";
    let path = "";
    try {
      const u = new URL(raw);
      host = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
      path = u.pathname;
    } catch { /* recorded as unparseable */ }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    appendFileSync(logPath, `${JSON.stringify({ method, host, path })}\n`);
    return realFetch(input, init);
  }) as typeof fetch;
  globalThis.fetch = logged;
}
