/**
 * pyproject-version.mjs — WHITELISTED, fail-closed reading of the `version`
 * declared in a `pyproject.toml`'s `[project]` table (flair#1671 / slice 3 of
 * #1928; round 3 hardens it).
 *
 * Only ONE form is read: a BARE, unquoted `version = "<x>"` line inside the
 * `[project]` table. Anything else — a quoted key (`"version" = …`), a dotted key
 * (`project.version = …`), an inline `project = { … }`, or a `version`-shaped
 * line the reader does not implement — returns a distinguishable UNSUPPORTED
 * result so the tagger REFUSES (`adk-pyproject-unsupported`) rather than guessing.
 * A `[[array-of-tables]]` header ends the table exactly like `[table]`, so a
 * `version =` line after `[project.urls]` or `[[tool.demo]]` is NOT read. If
 * `[project]` declares `dynamic = [ ... "version" ... ]`, the project version is
 * NONE — a file that defers its version to a build backend must not be tagged
 * from a stray `version` line.
 *
 * Exported as ONE helper, imported by BOTH `scripts/release-auto-tag.mjs` and
 * `scripts/check-version-sync.mjs`, so the tagger and the version gate read the
 * same value.
 */

/** Strip a TOML line comment (a `#` starts one outside a string for our shapes). */
function stripComment(line) {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * Read the `[project]` version. Returns one of:
 *   { kind: "version", version, lineIndex }   the whitelisted bare `version = "…"`
 *                                              line (0-based index into the lines)
 *   { kind: "none", reason }                  "dynamic" (a dynamic version) or
 *                                              "absent" (no `[project].version`)
 *   { kind: "unsupported", line, reason }     a form the reader does not implement
 */
export function readProjectVersion(text) {
  if (text === null || text === undefined) return { kind: "none", reason: "absent" };
  const lines = String(text).split(/\r?\n/);
  let section = "top"; // "top" before any header, else the current table name
  let sawProjectTable = false;
  let version = null;
  let versionLine = -1;
  let dynamicVersion = false;
  let unsupported = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    // ANY header — `[table]` or `[[array-of-tables]]` — ENDS the current table.
    if (/^\s*\[/.test(line) && /\]\s*$/.test(line)) {
      const single = line.match(/^\s*\[\s*([^\[\]]*?)\s*\]\s*$/);
      const array = line.match(/^\s*\[\[\s*([^\[\]]*?)\s*\]\]\s*$/);
      if (array) {
        section = array[1].trim(); // an array-of-tables is not a plain [project]
      } else if (single) {
        section = single[1].trim();
        if (section === "project") sawProjectTable = true;
      } else {
        section = "";
      }
      continue;
    }
    if (unsupported) continue;
    // A top-level inline `project = { … }` or a dotted `project.x = …` key.
    if (section === "top" && /^\s*project\s*=\s*\{/.test(line)) {
      unsupported = { line: raw.trim(), reason: "an inline `project` table is not supported" };
      continue;
    }
    if (section === "top" && /^\s*project\s*\./.test(line)) {
      unsupported = { line: raw.trim(), reason: "a dotted `project.*` key is not supported" };
      continue;
    }
    if (section !== "project") continue;
    // A quoted key anywhere inside [project].
    if (/^\s*"[^"]*"\s*=/.test(line)) {
      unsupported = { line: raw.trim(), reason: "a quoted key is not supported" };
      continue;
    }
    // A dotted key inside [project].
    if (/^\s*[\w-]+\s*\.\s*[\w-]+\s*=/.test(line)) {
      unsupported = { line: raw.trim(), reason: "a dotted key is not supported" };
      continue;
    }
    const dm = line.match(/^\s*dynamic\s*=\s*\[([^\]]*)\]/);
    if (dm) {
      if (/(^|[\s,"'])version([\s,"']|$)/.test(dm[1])) dynamicVersion = true;
      continue;
    }
    if (/^\s*version\s*=/.test(line)) {
      const vm = raw.match(/^\s*version\s*=\s*"([^"]*)"\s*$/);
      if (vm) {
        version = vm[1];
        versionLine = i;
      } else {
        unsupported = { line: raw.trim(), reason: "an unsupported `version` assignment form" };
      }
      continue;
    }
  }
  if (unsupported) return { kind: "unsupported", line: unsupported.line, reason: unsupported.reason };
  if (dynamicVersion) return { kind: "none", reason: "dynamic" };
  if (version !== null) return { kind: "version", version, lineIndex: versionLine };
  return { kind: "none", reason: sawProjectTable ? "absent" : "absent" };
}

/**
 * The whitelisted `[project]` version as a string, or null when the file is
 * absent, dynamic, or carries a form the reader does not implement. Callers that
 * must distinguish these should use `readProjectVersion`.
 */
export function projectVersionFromPyproject(text) {
  const r = readProjectVersion(text);
  return r.kind === "version" ? r.version : null;
}

/**
 * Rewrite ONLY the line the reader ACCEPTED, returning the new text — or null
 * when the file carries no whitelisted `[project]` version to rewrite (absent,
 * dynamic, or an unsupported form).
 */
export function replaceProjectVersion(text, version) {
  const r = readProjectVersion(text);
  if (r.kind !== "version") return null;
  const lines = String(text).split(/\r?\n/);
  lines[r.lineIndex] = lines[r.lineIndex].replace(
    /^(\s*version\s*=\s*")([^"]*)(")/,
    (_, a, _b, c) => `${a}${version}${c}`,
  );
  return lines.join("\n");
}
