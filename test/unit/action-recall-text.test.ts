import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dir, "../..", path), "utf8");
test("action-recall text states the client update, authentication and publication boundaries", () => {
  const docs = read("docs/claude-code.md");
  expect(docs).not.toContain("[]` or removing the key disables recall");
  expect(docs).toContain("Set `triggers: []` through `client.memory.update`");
  expect(docs).toContain("version-matched built hook to pass a local cache probe");
  const refresh = read("packages/flair-mcp/src/action-recall-refresh.ts");
  expect(refresh).not.toContain("a resolved Ed25519 key");
  expect(refresh).toContain("Basic fallback is disabled");
  expect(refresh).toContain("unsigned request is refused by the server");
  expect(read("packages/flair-mcp/src/session-start-hook.ts")).not.toContain("Bounded internally (3 s)");
  expect(read("packages/flair-mcp/src/action-recall-cache.ts")).not.toContain("installer/env-resolved");
  const tests = read("packages/flair-mcp/test/action-recall-refresh.test.ts");
  expect(tests).not.toContain("the signed read");
  expect(tests).toContain("request order");
});
