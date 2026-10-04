import { beforeAll, expect, test } from "bun:test";
import { ensureCliBuild } from "../helpers/build-cli-once.ts";
import { HTTP_PORT, OPS_PORT, runPlain } from "../helpers/init-plain-attribution-fixture.ts";

beforeAll(() => ensureCliBuild(), 120_000);

for (const port of [HTTP_PORT, OPS_PORT]) {
  test(`a live child with a real decoy on port ${port} refuses credentials to the decoy`, () => {
    const { result, events, actions } = runPlain("real-decoy", port);
    expect(result.error).toBeUndefined();
    expect(actions).toEqual(["install", "run"]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${port}`);
    expect(result.stderr).toContain("not attributed");
    expect(events.some(e => e.kind === "child-alive")).toBe(true);
    expect(events.some(e => e.kind === "auth" && e.url?.includes(`:${port}/`))).toBe(false);
  }, 30_000);
}
