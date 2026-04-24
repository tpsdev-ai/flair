import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDescriptor } from "../../src/bridges/runtime/load-bridge";
import { BridgeRuntimeError } from "../../src/bridges/types";
import type { DiscoveredBridge } from "../../src/bridges/types";

function tmp(): string {
  const d = join(tmpdir(), `flair-load-descriptor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("loadDescriptor: by source", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("source=builtin returns the registered descriptor", async () => {
    const d: DiscoveredBridge = {
      name: "agentic-stack",
      kind: "file",
      source: "builtin",
      path: "(builtin:agentic-stack)",
    };
    const desc = await loadDescriptor(d);
    expect(desc.name).toBe("agentic-stack");
  });

  test("source=builtin with unknown name throws (registry drift)", async () => {
    const d: DiscoveredBridge = {
      name: "ghost-bridge",
      kind: "file",
      source: "builtin",
      path: "(builtin:ghost-bridge)",
    };
    let thrown: any = null;
    try { await loadDescriptor(d); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
    expect(thrown.detail.hint).toMatch(/registry/);
  });

  test("source=project-yaml parses the YAML file at .path", async () => {
    const yamlPath = join(dir, "x.yaml");
    writeFileSync(yamlPath, `name: y\nversion: 1\nkind: file\nimport:\n  sources:\n    - {path: a, format: json, map: {content: "$.c"}}\n`);
    const d: DiscoveredBridge = {
      name: "y",
      kind: "file",
      source: "project-yaml",
      path: yamlPath,
    };
    const desc = await loadDescriptor(d);
    expect(desc.name).toBe("y");
    expect(desc.import?.sources).toHaveLength(1);
  });

  test("source=user-yaml also goes through the YAML loader", async () => {
    const yamlPath = join(dir, "u.yaml");
    writeFileSync(yamlPath, `name: u\nkind: file\nimport:\n  sources:\n    - {path: a, format: json, map: {content: "$.c"}}\n`);
    const d: DiscoveredBridge = {
      name: "u",
      kind: "file",
      source: "user-yaml",
      path: yamlPath,
    };
    const desc = await loadDescriptor(d);
    expect(desc.name).toBe("u");
  });

  test("source=npm-package on the YAML-only shim throws clearly (use loadBridge() for code plugins)", async () => {
    // As of slice 3c, npm code plugins are supported via loadBridge's "code"
    // branch. The legacy loadDescriptor shim is YAML-only and will throw
    // either the allow-list error (if callers hit it without the allow)
    // or the dispatch error ("this code path expected a YAML descriptor").
    // Either surfaces the wrong-path condition — what matters is we don't
    // silently succeed.
    const d: DiscoveredBridge = {
      name: "mem0",
      kind: "api",
      source: "npm-package",
      path: "/somewhere/node_modules/flair-bridge-mem0",
    };
    let thrown: any = null;
    try { await loadDescriptor(d); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BridgeRuntimeError);
  });
});
