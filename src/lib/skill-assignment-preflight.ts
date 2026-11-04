/**
 * skill-assignment-preflight.ts — the CLI-side copy of the server's
 * `refuseSkillAssignmentWrite` (resources/skill-provenance.ts) used by
 * `flair restore --replace` to decide an archived Soul row before any delete.
 *
 * A copy, not an import: `src/` must not import `resources/` (those imports do
 * not survive npm packaging). test/unit/skill-assignment-preflight.test.ts
 * pins this copy to the server module over a shared fixture table.
 */
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_ASSIGNMENT_KEY = "skill-assignment";

export type SkillRegistrationOk = { ok: true };
export type SkillRegistrationRefused = {
  ok: false;
  error: "skill_source_not_durable";
  path: string;
  message: string;
};
export type SkillRegistrationResult = SkillRegistrationOk | SkillRegistrationRefused;

export type SkillAssignmentInput = {
  key?: unknown;
  value?: unknown;
  priority?: unknown;
  metadata?: unknown;
};

export function parseSkillMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  if (typeof metadata === "string" && metadata.length > 0) {
    try {
      const parsed = JSON.parse(metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* opaque / corrupt blob — no source */
    }
  }
  return {};
}

export function skillSourceOf(record: { metadata?: unknown }): string | undefined {
  const src = parseSkillMetadata(record.metadata).source;
  return typeof src === "string" && src.trim().length > 0 ? src.trim() : undefined;
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function isWindowsDrivePath(source: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(source);
}

/**
 * If `source` names a filesystem path (absolute, relative, or `file:` URL),
 * return that path. Scheme-bearing identifiers (`npm:`, `https:`, …) are
 * not filesystem paths. A bare name is not a path.
 */
export function filesystemPathFromSkillSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("file:")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      const rest = trimmed.replace(/^file:\/\//, "").replace(/^file:/, "");
      return rest.length > 0 ? rest : null;
    }
  }

  if (SCHEME.test(trimmed) && !isWindowsDrivePath(trimmed)) return null;

  if (isAbsolute(trimmed) || trimmed.startsWith(".") || /[\\/]/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function tempRoots(): string[] {
  const roots = new Set<string>();
  const add = (p: string | undefined) => {
    if (!p || typeof p !== "string" || p.length === 0) return;
    try {
      roots.add(resolve(p));
    } catch {
      /* ignore unresolvable */
    }
  };
  add(tmpdir());
  add("/tmp");
  add("/private/tmp");
  add("/var/tmp");
  add(process.env.TMPDIR);
  add(process.env.TMP);
  add(process.env.TEMP);
  return [...roots];
}

export function isNonDurableFilesystemPath(fsPath: string): boolean {
  let resolved: string;
  try {
    resolved = resolve(fsPath);
  } catch {
    return true;
  }
  for (const root of tempRoots()) {
    if (resolved === root || resolved.startsWith(root + sep)) return true;
  }
  return false;
}

export function isDurableSkillSource(source: string): boolean {
  const fsPath = filesystemPathFromSkillSource(source);
  if (fsPath == null) return true;
  return !isNonDurableFilesystemPath(fsPath);
}

export function registerSkillAssignment(input: SkillAssignmentInput): SkillRegistrationResult {
  const key = typeof input.key === "string" ? input.key : SKILL_ASSIGNMENT_KEY;
  if (key !== SKILL_ASSIGNMENT_KEY) return { ok: true };
  const source = skillSourceOf(input);
  if (!source) return { ok: true };
  if (isDurableSkillSource(source)) return { ok: true };
  return {
    ok: false,
    error: "skill_source_not_durable",
    path: source,
    message: `skill source is not durable: ${source}`,
  };
}

function assignmentKey(content: any, existing?: any): string | undefined {
  const key = content?.key ?? existing?.key;
  return typeof key === "string" ? key : undefined;
}

/** Soul post/put/patch gate. `existing` supplies omitted fields on PATCH. */
export function refuseSkillAssignmentWrite(content: any, existing?: any): Response | null {
  if (assignmentKey(content, existing) !== SKILL_ASSIGNMENT_KEY) return null;
  const metadata = content?.metadata !== undefined ? content.metadata : existing?.metadata;
  // flair#2141 S1: `metadata.optOut`, when present, is a boolean.
  const parsed = parseSkillMetadata(metadata);
  if (Object.hasOwn(parsed, "optOut") && typeof parsed.optOut !== "boolean") {
    return new Response(
      JSON.stringify({ error: "skill_opt_out_not_boolean", message: "metadata.optOut must be true or false" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const result = registerSkillAssignment({
    key: SKILL_ASSIGNMENT_KEY,
    value: content?.value ?? existing?.value,
    priority: content?.priority ?? existing?.priority,
    metadata,
  });
  if (result.ok) return null;
  return new Response(
    JSON.stringify({
      error: result.error,
      path: result.path,
      message: result.message,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}
