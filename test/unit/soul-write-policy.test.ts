import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("generic Soul policy stays vendor-neutral", () => {
  test("soul-write-policy has no adk: string match of its own", () => {
    const source = readFileSync("resources/soul-write-policy.ts", "utf8");
    expect(source).not.toMatch(/adk:/i);
    expect(source).not.toMatch(/bodyCarriesAdkScope/);
    expect(source).not.toMatch(/refuseAdkSourcedSoulWrite/);
    expect(source).toMatch(/refuseSoulScopeFields/);
    expect(source).toMatch(/refuseLearnedSoulWrite/);
    expect(source).toMatch(/refuseSoulWriteContent/);
  });

  test("Soul and AgentSeed compose the generic content guards", () => {
    expect(readFileSync("resources/Soul.ts", "utf8")).toMatch(/refuseSoulWriteContent/);
    expect(readFileSync("resources/AgentSeed.ts", "utf8")).toMatch(/refuseSoulWriteContent/);
    expect(readFileSync("resources/Soul.ts", "utf8")).not.toMatch(/bodyCarriesAdkScope/);
    expect(readFileSync("resources/Soul.ts", "utf8")).not.toMatch(/soul-adk-guard/);
  });
});
