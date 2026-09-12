import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_TOOL_DESCRIPTORS,
  STDIO_TOOL_DESCRIPTORS,
  SURFACE_EXEMPTIONS,
  TOOL_DESCRIPTORS,
  descriptorNames,
  isNativeTool,
  isStdioTool,
  toMcpToolDef,
  toStdioMcpToolDef,
} from "../src/index.ts";

const SRC = join(import.meta.dir, "..", "src", "index.ts");

describe("tool descriptors — transport-agnostic source (flair#1580)", () => {
  test("every name is unique", () => {
    const names = descriptorNames(TOOL_DESCRIPTORS);
    expect(new Set(names).size).toBe(names.length);
  });

  test("native and stdio lists are derived filters, not hand-copied", () => {
    expect(descriptorNames(NATIVE_TOOL_DESCRIPTORS)).toEqual(
      descriptorNames(TOOL_DESCRIPTORS.filter(isNativeTool)),
    );
    expect(descriptorNames(STDIO_TOOL_DESCRIPTORS)).toEqual(
      descriptorNames(TOOL_DESCRIPTORS.filter(isStdioTool)),
    );
  });

  test("adding a both-surface descriptor would appear on both lists", () => {
    const phantom = {
      name: "brand_new_tool",
      description: "phantom",
      inputSchema: { type: "object" as const, properties: {} },
      outputShape: "{ ok: true }",
    };
    const all = [...TOOL_DESCRIPTORS, phantom];
    expect(all.filter(isNativeTool).map((d) => d.name)).toContain("brand_new_tool");
    expect(all.filter(isStdioTool).map((d) => d.name)).toContain("brand_new_tool");
  });

  test("SURFACE_EXEMPTIONS is derived from one-sided flags", () => {
    expect(SURFACE_EXEMPTIONS.registryOnly).toEqual(["memory_basement", "memory_restore", "attention"]);
    expect(SURFACE_EXEMPTIONS.adapterOnly).toEqual(["relationship_store", "flair_catchup"]);
  });

  test("toMcpToolDef keeps name / description / inputSchema / annotations", () => {
    const search = NATIVE_TOOL_DESCRIPTORS.find((d) => d.name === "memory_search");
    expect(search).toBeDefined();
    const def = toMcpToolDef(search!);
    expect(def.name).toBe("memory_search");
    expect(def.description).toBe(search!.description);
    expect(def.inputSchema).toEqual(search!.inputSchema);
    expect(def.annotations).toEqual({ readOnlyHint: true });
  });

  test("skill_get has no includeEmbedding on either surface (flair#1579 / flair#1593)", () => {
    const d = STDIO_TOOL_DESCRIPTORS.find((t) => t.name === "skill_get");
    expect(d).toBeDefined();
    const stdio = toStdioMcpToolDef(d!);
    const native = toMcpToolDef(d!);
    expect((native.inputSchema as { properties: object }).properties).not.toHaveProperty("includeEmbedding");
    expect((stdio.inputSchema as { properties: object }).properties).not.toHaveProperty("includeEmbedding");
  });

  test("stdio omits native-only params FlairClient never forwards", () => {
    const cases: Array<{ name: string; omitted: readonly string[] }> = [
      { name: "memory_search", omitted: ["includeTrust", "abstain", "includeArchived"] },
      { name: "memory_get", omitted: ["includeTrust", "includeEmbedding"] },
      {
        name: "bootstrap",
        omitted: ["entities", "includeTrust", "abstain", "includeContext", "maxEvents", "includeEventDetail"],
      },
    ];
    for (const { name, omitted } of cases) {
      const d = STDIO_TOOL_DESCRIPTORS.find((t) => t.name === name);
      expect(d, name).toBeDefined();
      const stdioProps = (toStdioMcpToolDef(d!).inputSchema as { properties: object }).properties;
      const nativeProps = (toMcpToolDef(d!).inputSchema as { properties: object }).properties;
      for (const key of omitted) {
        expect(nativeProps, `${name} native keeps ${key}`).toHaveProperty(key);
        expect(stdioProps, `${name} stdio drops ${key}`).not.toHaveProperty(key);
      }
    }
  });

  test("stdio memory_update keeps usedMemoryIds; native does not advertise it", () => {
    const d = STDIO_TOOL_DESCRIPTORS.find((t) => t.name === "memory_update");
    expect(d).toBeDefined();
    const stdio = toStdioMcpToolDef(d!);
    const native = toMcpToolDef(d!);
    expect((native.inputSchema as { properties: object }).properties).not.toHaveProperty("usedMemoryIds");
    expect((stdio.inputSchema as { properties: object }).properties).toHaveProperty("usedMemoryIds");
  });

  test("source file imports nothing — no Harper, no FlairClient, no Zod", () => {
    const src = readFileSync(SRC, "utf-8");
    const imports = [...src.matchAll(/^import\s+/gm)];
    expect(imports, "descriptor module must have zero imports").toHaveLength(0);
    expect(src).not.toMatch(/from\s+["']harper["']/);
    expect(src).not.toMatch(/from\s+["']@tpsdev-ai\/flair-client["']/);
    expect(src).not.toMatch(/from\s+["']zod["']/);
  });

  test("package.json has zero runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.name).toBe("@tpsdev-ai/flair-tool-descriptors");
  });
});
