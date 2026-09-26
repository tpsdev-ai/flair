/**
 * pyproject-version.mjs — read (and rewrite) the `version` declared in a
 * `pyproject.toml`'s `[project]` table (flair#1671 / slice 3 of #1928).
 *
 * A bare "the first `version =` in the file" regex is wrong: a `[tool.x]` table
 * can carry its own `version = "…"` ABOVE `[project]`, and the auto-tagger would
 * then tag (and the PyPI workflow would only later refuse) the wrong version.
 * This reads the `[project]` table specifically, line by line, tracking the
 * current table header. A file with no `[project].version` reads as `null` — a
 * caller must treat that as a mismatch, never as "no opinion".
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
 * The `version = "<v>"` of the `[project]` table, or null when the text is
 * absent or carries no `[project].version`.
 */
export function projectVersionFromPyproject(text) {
  if (text === null || text === undefined) return null;
  let inProject = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = stripComment(raw);
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inProject = header[1].trim() === "project";
      continue;
    }
    if (!inProject) continue;
    const m = line.match(/^\s*version\s*=\s*"([^"]*)"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Rewrite the `[project]` `version = "…"` to `version`, returning the new text,
 * or null when the table carries no version line to rewrite.
 */
export function replaceProjectVersion(text, version) {
  const lines = String(text).split(/\r?\n/);
  let inProject = false;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inProject = header[1].trim() === "project";
      continue;
    }
    if (!inProject || replaced) continue;
    const m = lines[i].match(/^(\s*version\s*=\s*")([^"]*)(")/);
    if (m) {
      lines[i] = `${m[1]}${version}${m[3]}${lines[i].slice(m[0].length)}`;
      replaced = true;
    }
  }
  return replaced ? lines.join("\n") : null;
}
