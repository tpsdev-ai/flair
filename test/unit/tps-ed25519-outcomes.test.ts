import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertTpsRouteOutcome } from "../helpers/tps-ed25519-outcomes.ts";
import { TPS_ED25519_ROUTES } from "../helpers/tps-ed25519-routes.ts";

const source = readFileSync(new URL("../integration/auth-middleware-e2e.test.ts", import.meta.url), "utf8");
const start = source.indexOf("      const valid = await send(false);");
const end = source.indexOf("    }, 30_000);", start);
const check = new Function("expect", "send", "method", "path", "agent", "assertTpsRouteOutcome",
  `return (async () => { ${source.slice(start, end)} })();`);

for (const { method, path } of TPS_ED25519_ROUTES) {
  for (const status of [401, 500]) {
    test(`${method} ${path}: matrix rejects status ${status}`, async () => {
      const send = async () => new Response('{"error":"unexpected"}', { status });
      await expect(check(expect, send, method, path, { id: "test-agent" }, assertTpsRouteOutcome)).rejects.toThrow();
    });
  }
}

test("GET /Presence: matrix rejects an error body with status 200", async () => {
  const send = async () => new Response('{"error":"unexpected"}', { status: 200 });
  await expect(check(expect, send, "GET", "/Presence", { id: "test-agent" }, assertTpsRouteOutcome)).rejects.toThrow();
});
