/**
 * Registry prompt templates. `{name}` is substituted once. `{{` / `}}` are
 * literal braces. Omitted inputType is passthrough — same contract as HFE.
 */
import { EmbeddingModelError } from "./errors.js";
import type { EmbeddingModelEntry } from "./models.js";

const TEMPLATE_TOKEN = /\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function renderEmbeddingTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return template.replace(TEMPLATE_TOKEN, (match, name: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (name == null || !Object.hasOwn(vars, name)) {
      throw new EmbeddingModelError(
        "engine",
        `[embeddings] template placeholder {${name ?? match}} has no value.`,
        "Pass the value on the embed call or add it to the registry template defaults.",
      );
    }
    return vars[name]!;
  });
}

export function applyEmbeddingTemplate(
  entry: EmbeddingModelEntry,
  text: string,
  inputType: string | undefined,
  task: string | undefined,
): string {
  if (inputType !== "document" && inputType !== "query") return text;
  const template = entry.templates[inputType];
  const vars: Record<string, string> = { ...(entry.templates.defaults ?? {}) };
  if (task !== undefined) vars.task = task;
  vars.text = text;
  return renderEmbeddingTemplate(template, vars);
}
