import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ADK_SOUL_REFUSE_KILL_DATE } from "../../resources/soul-adk-guard";

describe("generic Soul policy stays vendor-neutral", () => {
  test("soul-write-policy has no adk: string match of its own", () => {
    const source = readFileSync("resources/soul-write-policy.ts", "utf8");
    expect(source).not.toMatch(/adk:/i);
    expect(source).not.toMatch(/bodyCarriesAdkScope/);
    expect(source).toMatch(/refuseAdkSourcedSoulWrite/);
    expect(source).toMatch(/refuseLearnedSoulWrite/);
    expect(source).toMatch(/refuseSoulWriteContent/);
  });

  test("Soul and AgentSeed compose the dated bridge through the generic helper", () => {
    expect(readFileSync("resources/Soul.ts", "utf8")).toMatch(/refuseSoulWriteContent/);
    expect(readFileSync("resources/AgentSeed.ts", "utf8")).toMatch(/refuseSoulWriteContent/);
    expect(readFileSync("resources/Soul.ts", "utf8")).not.toMatch(/bodyCarriesAdkScope/);
  });

  test("the dated adk: bridge is still scheduled, not permanent", () => {
    expect(ADK_SOUL_REFUSE_KILL_DATE).toBe("2026-10-31");
  });
});
