/**
 * pyproject-version.mjs — fail-closed reading of the `version` declared in a
 * `pyproject.toml`'s `[project]` table, via the SAME reader the PyPI publish
 * workflow uses: Python's `tomllib` (flair#1671 / slice 3 of #1928; round 4
 * replaces the hand-written JS parser with tomllib).
 *
 * WHY TOMLLIB. Three rounds of hand-written TOML parsing each shipped a new hole
 * (a multi-line string or array containing a `version =` line, a quoted key, an
 * inline table). The reader is now the reference implementation, not an
 * approximation of it: `.github/workflows/adk-flair-publish.yml` decides with
 * `python3 -c "import tomllib; …['project']['version']"`, so the tagger reads the
 * version the EXACT same way. The file content goes to `python3` on stdin, the
 * result comes back as JSON.
 *
 * The JSON result is ONE of:
 *   { "version": "<string>" }   `project.version` is a string
 *   { "none": "dynamic" }       `"version"` is in `project.dynamic`
 *   { "none": "absent" }        `[project]` or its `version` is missing
 *   { "unsupported": "<reason>" } EVERYTHING else — a TOML parse error, python3
 *                               missing, or python < 3.11 (no tomllib). Fail
 *                               closed: never guess.
 *
 * Exported as ONE helper, imported by BOTH `scripts/release-auto-tag.mjs` and
 * `scripts/check-version-sync.mjs`, so the tagger and the version gate read the
 * same value.
 */

import { spawnSync } from "node:child_process";

/**
 * The python program run for every read. It imports `tomllib` INSIDE the try so
 * a python without it (or an import error) is reported as `unsupported` rather
 * than a traceback. Input on stdin is a JSON object: `{ text, compare? }`. With
 * `compare`, both documents are parsed and their deep-equality (with
 * `project.version` removed from each) is reported.
 */
const PY = `
import sys, json, copy

def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()

def fail(msg):
    out({"unsupported": msg})
    sys.exit(0)

try:
    import tomllib
except Exception as e:  # pragma: no cover - exercised by the no-tomllib test
    fail("python3 has no tomllib (need >= 3.11): %s" % e)

try:
    req = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
except Exception as e:
    fail("could not read the request: %s" % e)

def parse(text):
    try:
        return tomllib.loads(text)
    except Exception as e:
        return ("__parse_error__", str(e))

doc = parse(req.get("text", ""))
if isinstance(doc, tuple):
    fail("TOML parse error: %s" % doc[1])

if "compare" in req:
    other = parse(req.get("compare", ""))
    if isinstance(other, tuple):
        out({"equal": False, "version": None})
        sys.exit(0)
    a = copy.deepcopy(doc)
    b = copy.deepcopy(other)
    if isinstance(a.get("project"), dict):
        a["project"].pop("version", None)
    if isinstance(b.get("project"), dict):
        b["project"].pop("version", None)
    ver = None
    if isinstance(other.get("project"), dict) and isinstance(other["project"].get("version"), str):
        ver = other["project"]["version"]
    out({"equal": a == b, "version": ver})
    sys.exit(0)

proj = doc.get("project")
if "project" not in doc:
    out({"none": "absent"})
    sys.exit(0)
if not isinstance(proj, dict):
    out({"unsupported": "[project] is not a table (%s)" % type(proj).__name__})
    sys.exit(0)

# DYNAMIC BEFORE STATIC (round 5, item 1): if version is dynamic, the project's
# version is NONE — a stray version line must NOT authorize a tag.
dyn = proj.get("dynamic")
if isinstance(dyn, list) and "version" in dyn:
    out({"none": "dynamic"})
    sys.exit(0)

if "version" in proj:
    v = proj["version"]
    if isinstance(v, str):
        out({"version": v})
    else:
        out({"unsupported": "project.version is not a string (%s)" % type(v).__name__})
    sys.exit(0)

out({"none": "absent"})
`;

/** Default wall-clock ceiling for the python child. */
export const PYTHON_TIMEOUT_MS = 10_000;

/** The python program's response shape for the READ path (exactly one string key). */
function isReadResponse(o) {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return false;
  const keys = Object.keys(o);
  if (keys.length !== 1) return false;
  const key = keys[0];
  return (key === "version" || key === "none" || key === "unsupported") && typeof o[key] === "string";
}

/** The python program's response shape for the COMPARE path. */
function isCompareResponse(o) {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return false;
  const keys = Object.keys(o);
  return keys.every((k) => k === "equal" || k === "version") && typeof o.equal === "boolean" &&
    (o.version === null || typeof o.version === "string");
}

/**
 * Run the python reader over `payload` — a `{text}` or `{text, compare}` object.
 * FAIL CLOSED on every subprocess outcome (round 5, item 2): a timeout, a
 * non-zero exit, a zero exit with STDERR noise, unparseable JSON, or a JSON
 * response whose SHAPE is not the expected object are all `unsupported` — never a
 * throw, never a guess. `opts.pythonBin` / `opts.timeoutMs` are the test seams.
 */
function runPython(payload, opts = {}) {
  const res = spawnSync(opts.pythonBin ?? "python3", ["-c", PY], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? PYTHON_TIMEOUT_MS,
  });
  // A timeout kills the child; Node reports ETIMEDOUT / a SIGTERM signal.
  if (res.error) {
    if (res.error.code === "ETIMEDOUT" || res.signal === "SIGTERM") return { unsupported: "timeout" };
    return { unsupported: `python3 could not run: ${res.error.message}` };
  }
  if (res.status !== 0) {
    return { unsupported: `python3 exited ${res.status}: ${String(res.stderr ?? "").trim()}` };
  }
  // A zero exit with stderr noise is NOT trustworthy: some other python wrote to
  // the fd (e.g. a sitecustomize warning); refuse rather than read stdout.
  const stderr = String(res.stderr ?? "").trim();
  if (stderr !== "") return { unsupported: `stderr: ${stderr.split(/\r?\n/)[0]}` };
  let parsed;
  try {
    parsed = JSON.parse(String(res.stdout ?? "").trim());
  } catch {
    return { unsupported: "python3 produced no JSON" };
  }
  const ok = "compare" in payload ? isCompareResponse(parsed) : isReadResponse(parsed);
  if (!ok) return { unsupported: "bad response" };
  return parsed;
}

/**
 * Read the `[project]` version. Returns one of:
 *   { kind: "version", version, lineIndex }   `project.version` is a string
 *   { kind: "none", reason }                  "dynamic" (a dynamic version) or
 *                                             "absent" (no `[project].version`)
 *   { kind: "unsupported", line, reason }     a form tomllib does not accept, no
 *                                             python3/tomllib, or a parse error
 *
 * `lineIndex` is best-effort (the located assignment line, or -1); it exists only
 * for the writer's line-level rewrite.
 */
export function readProjectVersion(text, opts) {
  if (text === null || text === undefined) return { kind: "none", reason: "absent" };
  const src = String(text);
  const r = runPython({ text: src }, opts);
  if (typeof r.version === "string") {
    return { kind: "version", version: r.version, lineIndex: locateVersionLine(src) };
  }
  if (typeof r.none === "string") {
    return { kind: "none", reason: r.none === "dynamic" ? "dynamic" : "absent" };
  }
  return { kind: "unsupported", line: "", reason: String(r.unsupported ?? "unsupported") };
}

/**
 * The line index of the bare `version = "…"` assignment inside `[project]`, or
 * -1. Used ONLY to locate the text to rewrite; the acceptance decision is
 * tomllib's, and the writer re-verifies with tomllib afterwards.
 */
function locateVersionLine(src) {
  const lines = src.split(/\r\n|\n/);
  let section = "top";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[\[.*\]\]\s*$/.test(line) || /^\s*\[.*\]\s*$/.test(line)) {
      const m = line.match(/^\s*\[\s*([^\[\]]*?)\s*\]\s*$/);
      section = m ? m[1].trim() : "";
      continue;
    }
    if (section !== "project") continue;
    if (/^\s*version\s*=\s*"[^"]*"\s*(#.*)?$/.test(line)) return i;
  }
  return -1;
}

/**
 * The `[project]` version as a string, or null when the file is absent, dynamic,
 * or carries a form tomllib does not accept. Callers that must distinguish these
 * should use `readProjectVersion`.
 */
export function projectVersionFromPyproject(text, opts) {
  const r = readProjectVersion(text, opts);
  return r.kind === "version" ? r.version : null;
}

/**
 * Rewrite ONLY the matched version span, returning the new text — or null when the
 * file carries no rewriteable `[project]` version (absent, dynamic, an unsupported
 * form, or no bare `version = "…"` line to locate).
 *
 * The edit replaces the version VALUE in the ORIGINAL text (never a split/join over
 * the whole file), so every other byte is preserved — including a MIXED CRLF/LF
 * file's other line endings (round 5, item 3). It is VERIFIED with tomllib: the old
 * and new documents are both parsed, and the rewrite is refused (null, nothing
 * written) unless the new document's `project.version` equals `version` AND the two
 * parsed documents are otherwise DEEP-EQUAL (only `project.version` changed). A
 * version-shaped line the locator accepts but tomllib reads as something else —
 * e.g. inside a multi-line string — is a refusal, never a corrupted file.
 */
export function replaceProjectVersion(text, version, opts) {
  if (text === null || text === undefined) return null;
  const src = String(text);
  const r = readProjectVersion(src, opts);
  if (r.kind !== "version") return null;
  const idx = locateVersionLine(src);
  if (idx < 0) return null;
  // The char offset of the located line's start (offsets after each `\n`; a
  // CRLF ends with `\n`, so the offset is the same as `split(/\r?\n/)`).
  let lineStart = 0;
  for (let n = 0; n < idx; n++) {
    const nl = src.indexOf("\n", lineStart);
    if (nl === -1) return null;
    lineStart = nl + 1;
  }
  const nl = src.indexOf("\n", lineStart);
  const lineEnd = nl === -1 ? src.length : nl;
  const line = src.slice(lineStart, lineEnd);
  const m = line.match(/^(\s*version\s*=\s*")([^"]*)(")/);
  if (!m) return null;
  // Replace ONLY the matched version span in the ORIGINAL text — every other byte
  // (including a MIXED CRLF/LF file's other line endings) is left untouched.
  const valueStart = lineStart + m[1].length;
  const valueEnd = valueStart + m[2].length;
  const next = src.slice(0, valueStart) + version + src.slice(valueEnd);
  const check = runPython({ text: src, compare: next }, opts);
  if (check.equal !== true || check.version !== version) return null;
  return next;
}
