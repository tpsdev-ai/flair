import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("harper-native rewrite shape", () => {
  test("config wires schema and resources", () => {
    const cfg = readFileSync("config.yaml", "utf-8");
    expect(cfg).toContain("graphqlSchema:");
    expect(cfg).toContain("files: schemas/*.graphql");
    expect(cfg).toContain("jsResource:");
    expect(cfg).toContain("files: resources/*.ts");
  });

  test("auth middleware uses runFirst", () => {
    const src = readFileSync("resources/auth-middleware.ts", "utf-8");
    expect(src).toContain("server.http");
    expect(src).toContain("runFirst: true");
    expect(src).toContain("TPS-Ed25519");
  });

  test("memory durability delete guard exists", () => {
    const src = readFileSync("resources/Memory.ts", "utf-8");
    expect(src).toContain("permanent_memory_cannot_be_deleted");
    expect(src).toContain("ephemeral");
  });
});
