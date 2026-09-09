import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADAPTER_TOOL_NAMES,
  STDIO_ADAPTER_EXEMPTIONS,
  adapterRegistryParity,
  parseAdapterToolNames,
} from "../src/adapter-surface.ts";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");

describe("adapter-surface declaration", () => {
  test("parseAdapterToolNames reads every server.tool(...) in index.ts", () => {
    const names = parseAdapterToolNames(readFileSync(INDEX, "utf-8")).sort();
    expect(names).toEqual([...ADAPTER_TOOL_NAMES].sort());
  });

  test("skill_* are declared — the names the 0.52.0 probe found missing", () => {
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
    // attention is registry-only exempted. If the adapter later wires it,
    // the exemption is no longer a one-sided difference and must be removed.
    const adapterHasAttention = adapterRegistryParity(
      ["attention", "memory_search"],
      ["attention", "memory_search"],
    );
    expect(adapterHasAttention.staleExemptions).toContain("attention");
    expect(STDIO_ADAPTER_EXEMPTIONS.registryOnly).toContain("attention");
  });
});
