/**
 * JSON Schema → Zod raw shape for MCP SDK `server.tool()` (flair#1580).
 *
 * Lives in the adapter, not the descriptor module: Zod is an SDK concern.
 * Number/boolean use `z.coerce` so MCP clients that send stringified scalars
 * keep working (the previous hand-wired Zod schemas did the same).
 */

import { z, type ZodTypeAny } from "zod";
import type { JsonSchemaObject, JsonSchemaProperty } from "@tpsdev-ai/flair-tool-descriptors";

export function jsonSchemaToZodShape(schema: JsonSchemaObject): Record<string, ZodTypeAny> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let t = propToZod(prop);
    if (prop.description) t = t.describe(prop.description);
    if (!required.has(key)) t = t.optional();
    if (prop.default !== undefined) t = t.default(prop.default);
    shape[key] = t;
  }
  return shape;
}

function propToZod(prop: JsonSchemaProperty): ZodTypeAny {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const [first, ...rest] = prop.enum;
    return z.enum([first, ...rest] as [string, ...string[]]);
  }
  switch (prop.type) {
    case "string":
      return z.string();
    case "number":
      return z.coerce.number();
    case "boolean":
      return z.coerce.boolean();
    case "array":
      if (prop.items?.type === "string") return z.array(z.string());
      throw new Error(`unsupported array items: ${JSON.stringify(prop.items)}`);
    default:
      throw new Error(`unsupported json schema type: ${JSON.stringify(prop.type)}`);
  }
}
