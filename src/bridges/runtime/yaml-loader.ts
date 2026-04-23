/**
 * YAML bridge descriptor loader.
 *
 * Reads a `.flair-bridge/<name>.yaml` (or `~/.flair/bridges/<name>.yaml`),
 * parses it with js-yaml, and normalizes it into a typed
 * `YamlBridgeDescriptor`. Validation is strict for required fields
 * (`name`, `kind`, at least one of `import`/`export`), lenient elsewhere —
 * unknown fields are preserved but ignored; the spec is allowed to grow.
 *
 * Errors are always `BridgeRuntimeError` with LLM-readable `{field, expected, got, hint}`.
 */

import { promises as fsp } from "node:fs";
import yaml from "js-yaml";
import type {
  YamlBridgeDescriptor,
  YamlSourceTarget,
  YamlFormat,
} from "../types.js";
import { BridgeRuntimeError } from "../types.js";

const VALID_FORMATS: readonly YamlFormat[] = [
  "jsonl",
  "json",
  "yaml",
  "markdown-frontmatter",
];

function failLoad(path: string, field: string, expected: string, got: unknown, hint: string): never {
  throw new BridgeRuntimeError({
    bridge: "(unknown)",
    op: "import",
    path,
    field,
    expected,
    got: typeof got === "string" ? got : JSON.stringify(got),
    hint,
  });
}

function fail(bridge: string, path: string, field: string, expected: string, got: unknown, hint: string): never {
  throw new BridgeRuntimeError({
    bridge,
    op: "import",
    path,
    field,
    expected,
    got: typeof got === "string" ? got : JSON.stringify(got),
    hint,
  });
}

function normalizeSourceTarget(
  bridge: string,
  path: string,
  fieldBase: string,
  raw: unknown,
): YamlSourceTarget {
  if (typeof raw !== "object" || raw === null) {
    fail(bridge, path, fieldBase, "object", raw,
      `each entry under ${fieldBase} must be an object with 'path', 'format', and 'map'`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.path !== "string" || !obj.path) {
    fail(bridge, path, `${fieldBase}.path`, "non-empty string", obj.path,
      `${fieldBase}.path must be a non-empty string`);
  }
  if (typeof obj.format !== "string") {
    fail(bridge, path, `${fieldBase}.format`, "string", obj.format,
      `${fieldBase}.format must be one of: ${VALID_FORMATS.join(", ")}`);
  }
  if (!VALID_FORMATS.includes(obj.format as YamlFormat)) {
    fail(bridge, path, `${fieldBase}.format`, VALID_FORMATS.join(" | "), obj.format,
      `unsupported format "${obj.format}"; supported: ${VALID_FORMATS.join(", ")}`);
  }
  if (typeof obj.map !== "object" || obj.map === null || Array.isArray(obj.map)) {
    fail(bridge, path, `${fieldBase}.map`, "object", obj.map,
      `${fieldBase}.map must be an object of BridgeMemory-field → mapping expression`);
  }
  const mapIn = obj.map as Record<string, unknown>;
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(mapIn)) {
    if (typeof v !== "string") {
      fail(bridge, path, `${fieldBase}.map.${k}`, "string expression", v,
        `map entries must be strings; got ${typeof v} for ${k}`);
    }
    map[k] = v;
  }

  const out: YamlSourceTarget = {
    path: obj.path as string,
    format: obj.format as YamlFormat,
    map,
  };
  if (typeof obj.when === "string") out.when = obj.when;
  return out;
}

export async function loadYamlDescriptor(yamlPath: string): Promise<YamlBridgeDescriptor> {
  let raw: string;
  try {
    raw = await fsp.readFile(yamlPath, "utf-8");
  } catch (err: any) {
    failLoad(yamlPath, "(file)", "readable file", err?.code ?? "ENOENT",
      `could not read YAML file: ${err?.message ?? err}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err: any) {
    failLoad(yamlPath, "(yaml)", "valid YAML", err?.name ?? "parse error",
      `YAML parse failed: ${err?.message ?? err}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    failLoad(yamlPath, "(root)", "mapping", parsed,
      "descriptor must be a YAML mapping at the top level");
  }
  const d = parsed as Record<string, unknown>;

  if (typeof d.name !== "string" || !d.name) {
    failLoad(yamlPath, "name", "non-empty string", d.name,
      "descriptor must have a top-level 'name' string");
  }
  const bridge = d.name as string;

  if (d.kind !== "file") {
    fail(bridge, yamlPath, "kind", "'file'", d.kind,
      "YAML descriptors have kind: file. API plugins use a TypeScript code plugin — see docs/bridges.md §6");
  }

  const versionRaw = d.version;
  const version = typeof versionRaw === "number" ? versionRaw : versionRaw === undefined ? 1 : NaN;
  if (!Number.isFinite(version)) {
    fail(bridge, yamlPath, "version", "number", versionRaw,
      "version must be a number; defaulting to 1 if omitted is supported");
  }

  const descriptor: YamlBridgeDescriptor = {
    name: bridge,
    version,
    kind: "file",
  };
  if (typeof d.description === "string") descriptor.description = d.description;

  if (d.detect && typeof d.detect === "object") {
    const det = d.detect as Record<string, unknown>;
    const detect: NonNullable<YamlBridgeDescriptor["detect"]> = {};
    if (Array.isArray(det.anyExists)) {
      detect.anyExists = det.anyExists.filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(det.allExist)) {
      detect.allExist = det.allExist.filter((x): x is string => typeof x === "string");
    }
    descriptor.detect = detect;
  }

  if (d.import && typeof d.import === "object") {
    const imp = d.import as Record<string, unknown>;
    if (!Array.isArray(imp.sources) || imp.sources.length === 0) {
      fail(bridge, yamlPath, "import.sources", "non-empty array", imp.sources,
        "import must have a 'sources' array with at least one entry");
    }
    descriptor.import = {
      sources: imp.sources.map((s, i) =>
        normalizeSourceTarget(bridge, yamlPath, `import.sources[${i}]`, s),
      ),
    };
  }

  if (d.export && typeof d.export === "object") {
    const exp = d.export as Record<string, unknown>;
    if (!Array.isArray(exp.targets) || exp.targets.length === 0) {
      fail(bridge, yamlPath, "export.targets", "non-empty array", exp.targets,
        "export must have a 'targets' array with at least one entry");
    }
    descriptor.export = {
      targets: exp.targets.map((t, i) =>
        normalizeSourceTarget(bridge, yamlPath, `export.targets[${i}]`, t),
      ),
    };
  }

  if (!descriptor.import && !descriptor.export) {
    fail(bridge, yamlPath, "(root)", "import or export block", "neither",
      "descriptor must define at least one of `import` or `export`");
  }

  return descriptor;
}
