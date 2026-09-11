import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STDIO_TOOL_DESCRIPTORS,
  descriptorNames,
} from "@tpsdev-ai/flair-tool-descriptors";
import {
  ADAPTER_TOOL_NAMES,
  STDIO_ADAPTER_EXEMPTIONS,
  adapterRegistryParity,
  derivedDescriptorParity,
  parseAdapterToolNames,
} from "../src/adapter-surface.ts";
import { stdioHandlerNames } from "../src/adapter-tools.ts";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const ADAPTER_TOOLS = join(import.meta.dir, "..", "src", "adapter-tools.ts");

describe("adapter-surface derivation (flair#1580)", () => {
  test("ADAPTER_TOOL_NAMES is derived from STDIO_TOOL_DESCRIPTORS", () => {
    expect([...ADAPTER_TOOL_NAMES].sort()).toEqual(descriptorNames(STDIO_TOOL_DESCRIPTORS).sort());
  });

  test("bound handlers equal the stdio descriptor set (structural, not hand-sync)", () => {
    const parity = derivedDescriptorParity(stdioHandlerNames(), ADAPTER_TOOL_NAMES);
    expect(parity.missingHandlers).toEqual([]);
    expect(parity.extraHandlers).toEqual([]);
  });

  test("index.ts has no leftover server.tool(\"name\" hand-wires", () => {
    const names = parseAdapterToolNames(readFileSync(INDEX, "utf-8"));
    expect(names).toEqual([]);
  });

  test("adapter-tools.ts registers via d.name, not string literals", () => {
    const src = readFileSync(ADAPTER_TOOLS, "utf-8");
    expect(parseAdapterToolNames(src)).toEqual([]);
    expect(src).toContain("for (const d of STDIO_TOOL_DESCRIPTORS)");
    expect(src).toContain("server.tool(d.name");
  });

  test("skill_* are on the derived stdio set — the names the 0.52.0 probe found missing", () => {
    expect(ADAPTER_TOOL_NAMES).toContain("skill_store");
    expect(ADAPTER_TOOL_NAMES).toContain("skill_search");
    expect(ADAPTER_TOOL_NAMES).toContain("skill_get");
  });

  test("parity fails on silent registry drift (the class, not just the three tools)", () => {
    const drifted = adapterRegistryParity(
      ["memory_search", "skill_store", "brand_new_tool"],
      ADAPTER_TOOL_NAMES,
    );
    expect(drifted.missingFromAdapter).toContain("brand_new_tool");
  });

  test("a stale exemption fails rather than hiding future drift", () => {
    const adapterHasAttention = adapterRegistryParity(
      ["attention", "memory_search"],
      ["attention", "memory_search"],
    );
    expect(adapterHasAttention.staleExemptions).toContain("attention");
    expect(STDIO_ADAPTER_EXEMPTIONS.registryOnly).toContain("attention");
  });
});
