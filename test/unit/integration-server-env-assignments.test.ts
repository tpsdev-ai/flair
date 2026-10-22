// test/integration suites should declare server-read FLAIR_* variables through
// startHarper's serverEnv. A bare assignment on the test process instead only
// reaches the spawned Harper by inheritance and can leak into later tests, so it
// is allowed only where listed: per (file, variable) with its reader, or, for a
// site whose key the scan cannot read, per site with what it writes.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const INTEGRATION_DIR = join(REPO_ROOT, "test", "integration");

const ALLOWED: ReadonlyArray<{ file: string; variable: string; reason: string }> = [
  {
    file: "test/integration/feed-ephemeral-expiry-e2e.test.ts",
    variable: "FLAIR_EPHEMERAL_TTL_HOURS",
    reason: "the in-process stampEphemeralExpiry() call reads it; the spawned Harper gets it through serverEnv",
  },
  {
    file: "test/integration/cursor-wake-cli-launch-receipt-1940.test.ts",
    variable: "FLAIR_AGENT_ID",
    reason: "the in-process cursor-wake CLI configuration reader reads it",
  },
  {
    file: "test/integration/cursor-wake-cli-launch-receipt-1940.test.ts",
    variable: "FLAIR_URL",
    reason: "the in-process cursor-wake CLI configuration reader reads it",
  },
  {
    file: "test/integration/cursor-wake-cli-launch-receipt-1940.test.ts",
    variable: "FLAIR_KEY_PATH",
    reason: "the in-process cursor-wake CLI configuration reader reads it",
  },
  {
    file: "test/integration/write-reply-redaction-2537.test.ts",
    variable: "FLAIR_URL",
    reason: "the in-process pi-flair client reads it",
  },
  {
    file: "test/integration/write-reply-redaction-2537.test.ts",
    variable: "FLAIR_AGENT_ID",
    reason: "the in-process pi-flair client reads it",
  },
  {
    file: "test/integration/write-reply-redaction-2537.test.ts",
    variable: "FLAIR_KEY_PATH",
    reason: "the in-process pi-flair client reads it",
  },
];

// Sites whose key the scan cannot read, per (file, site text) with the number
// of such sites in that file and what they write.
const UNSCANNABLE_ALLOWED: ReadonlyArray<{ file: string; text: string; sites: number; reason: string }> = [
  {
    file: "test/integration/cursor-wake-cli-launch-receipt-1940.test.ts",
    text: "process.env[key]",
    sites: 2,
    reason: "setCliEnv deletes the CURSOR_* variables it lists, and its restore deletes each key missing from its saved copy of process.env",
  },
  {
    file: "test/integration/cursor-wake-cli-launch-receipt-1940.test.ts",
    text: "Object.assign(process.env, saved)",
    sites: 1,
    reason: "setCliEnv's restore writes back its saved copy of process.env",
  },
  {
    file: "test/integration/write-reply-redaction-2537.test.ts",
    text: "process.env[k]",
    sites: 2,
    reason: "piStore's restore writes back or deletes its saved FLAIR_URL, FLAIR_AGENT_ID and FLAIR_KEY_PATH",
  },
  {
    file: "test/integration/federation-presence-reoffer-2666.test.ts",
    text: "process.env[PRESENCE_SEND_FLAG_ENV]",
    sites: 2,
    reason: "sets FLAIR_FEDERATION_PRESENCE_SEND, which the in-process runFederationSyncOnce() call reads, and deletes it in afterAll",
  },
  {
    file: "test/integration/federation-presence-send-2578.test.ts",
    text: "process.env[PRESENCE_SEND_FLAG_ENV]",
    sites: 2,
    reason: "sets FLAIR_FEDERATION_PRESENCE_SEND, which the in-process runFederationSyncOnce() call reads, and deletes it in afterAll",
  },
];

type Source = { file: string; text: string };
type Write = { file: string; variable: string; line: number };
type Unscannable = { file: string; text: string; line: number };

function integrationFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...integrationFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found.sort();
}

const integrationSources = (): Source[] =>
  integrationFiles(INTEGRATION_DIR).map((path) => ({ file: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") }));

const isWrapper = (node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.TypeAssertion | ts.NonNullExpression | ts.SatisfiesExpression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
  ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node);

const unwrap = (node: ts.Expression): ts.Expression => {
  while (isWrapper(node)) node = node.expression;
  return node;
};

const isMember = (node: ts.Expression, object: string, member: string): boolean => {
  const inner = unwrap(node);
  return ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression) &&
    inner.expression.text === object && inner.name.text === member;
};

const literalKey = (node: ts.Expression): string | undefined => {
  const inner = unwrap(node);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
};

// A write is the target of `=` or a compound assignment, or the operand of `delete`.
function isWriteTarget(node: ts.Expression): boolean {
  let outer: ts.Node = node;
  while (isWrapper(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  if (ts.isDeleteExpression(parent)) return true;
  const operator = ts.isBinaryExpression(parent) && parent.left === outer ? parent.operatorToken.kind : undefined;
  return operator !== undefined && operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
}

// Parses each source and returns its writes to process.env.FLAIR_*: `=`, a
// compound assignment or `delete` on process.env.NAME or process.env["NAME"]
// (string literal or no-substitution template key), and each property name of an
// object literal passed to Object.assign(process.env, ...). A bracket key on
// process.env that is not such a literal, and an Object.assign source that is
// not an object literal or holds a spread or a non-literal computed key, are
// returned as unscannable.
function scan(sources: Source[]): { writes: Write[]; unscannable: Unscannable[] } {
  const writes: Write[] = [];
  const unscannable: Unscannable[] = [];
  for (const { file, text } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const line = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const write = (variable: string, node: ts.Node): void => {
      if (variable.startsWith("FLAIR_")) writes.push({ file, variable, line: line(node) });
    };
    const cannotRead = (node: ts.Node): void => {
      unscannable.push({ file, text: node.getText(source).replace(/\s+/g, " "), line: line(node) });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isMember(node.expression, "process", "env")) {
        if (isWriteTarget(node)) write(node.name.text, node);
      } else if (ts.isElementAccessExpression(node) && isMember(node.expression, "process", "env")) {
        const name = literalKey(node.argumentExpression);
        if (name === undefined) cannotRead(node);
        else if (isWriteTarget(node)) write(name, node);
      } else if (ts.isCallExpression(node) && isMember(node.expression, "Object", "assign") &&
                 node.arguments[0] !== undefined && isMember(node.arguments[0], "process", "env")) {
        for (const argument of node.arguments.slice(1)) {
          const object = unwrap(argument);
          if (!ts.isObjectLiteralExpression(object)) {
            cannotRead(node);
            continue;
          }
          for (const property of object.properties) {
            const name = ts.isSpreadAssignment(property) ? undefined
              : ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name) ? property.name.text
              : ts.isComputedPropertyName(property.name) ? literalKey(property.name.expression)
              : undefined;
            if (name === undefined) cannotRead(property);
            else write(name, property);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { writes, unscannable };
}

const key = (entry: { file: string; variable: string }): string => `${entry.file}\u0000${entry.variable}`;

const unexpectedWrites = (writes: Write[]): string[] => {
  const allowed = new Set(ALLOWED.map(key));
  return writes.filter((entry) => !allowed.has(key(entry))).map((entry) => `${entry.file}:${entry.line} ${entry.variable}`);
};

const staleEntries = (writes: Write[]): string[] => {
  const current = new Set(writes.map(key));
  return ALLOWED.filter((entry) => entry.reason.trim().length === 0 || !current.has(key(entry))).map(
    (entry) => `${entry.file}: ${entry.variable}`,
  );
};

const unscannableMismatches = (unscannable: Unscannable[]): string[] => {
  const siteKey = (entry: { file: string; text: string }): string => `${entry.file}\u0000${entry.text}`;
  const found = new Map<string, Unscannable[]>();
  for (const entry of unscannable) found.set(siteKey(entry), [...(found.get(siteKey(entry)) ?? []), entry]);
  const listed = new Map(UNSCANNABLE_ALLOWED.map((entry) => [siteKey(entry), entry]));
  const mismatches: string[] = [];
  for (const [site, entries] of found) {
    const entry = listed.get(site);
    if (!entry || entry.sites !== entries.length || entry.reason.trim().length === 0) {
      mismatches.push(...entries.map((hit) => `${hit.file}:${hit.line} ${hit.text} (listed sites: ${entry?.sites ?? 0})`));
    }
  }
  for (const [site, entry] of listed) {
    if (!found.has(site)) mismatches.push(`${entry.file}: ${entry.text} (listed sites: ${entry.sites}, found: 0)`);
  }
  return mismatches;
};

test("test/integration has no =, compound assignment or delete on process.env.FLAIR_* (dot or literal bracket key), and no FLAIR_* key in an object literal passed to Object.assign(process.env, ...), outside the allowlist", () => {
  expect(unexpectedWrites(scan(integrationSources()).writes)).toEqual([]);
});

test("test/integration's non-literal bracket keys on process.env and Object.assign(process.env, ...) sources the scan cannot read match the listed sites and counts", () => {
  expect(unscannableMismatches(scan(integrationSources()).unscannable)).toEqual([]);
});

test("every allowlist entry matches a write the scan finds and carries a reason", () => {
  expect(staleEntries(scan(integrationSources()).writes)).toEqual([]);
});

describe("scan fixtures (in-memory sources)", () => {
  const FIXTURE = "test/integration/fixture.test.ts";
  const writesIn = (text: string): string[] => scan([{ file: FIXTURE, text }]).writes.map((entry) => `${entry.line} ${entry.variable}`);
  const unscannableIn = (text: string): string[] => scan([{ file: FIXTURE, text }]).unscannable.map((entry) => `${entry.line} ${entry.text}`);

  test("a dot assignment with a line break before its = counts", () => {
    expect(writesIn('process.env.FLAIR_X\n  = "1";')).toEqual(["1 FLAIR_X"]);
  });

  test("a bracket assignment with a string literal or no-substitution template key counts", () => {
    expect(writesIn('process.env["FLAIR_X"] = "1";\nprocess.env[`FLAIR_Y`] = "1";')).toEqual(["1 FLAIR_X", "2 FLAIR_Y"]);
  });

  test("a compound assignment counts", () => {
    expect(writesIn('process.env.FLAIR_X += "1";\nprocess.env["FLAIR_Y"] ??= "1";')).toEqual(["1 FLAIR_X", "2 FLAIR_Y"]);
  });

  test("a delete counts", () => {
    expect(writesIn('delete process.env.FLAIR_X;\ndelete process.env["FLAIR_Y"];')).toEqual(["1 FLAIR_X", "2 FLAIR_Y"]);
  });

  test("a FLAIR_* key of an object literal passed to Object.assign(process.env, ...) counts", () => {
    expect(writesIn('Object.assign(process.env, {\n  FLAIR_X: "1",\n  "FLAIR_Y": "1",\n  OTHER: "1",\n});')).toEqual(["2 FLAIR_X", "3 FLAIR_Y"]);
  });

  test("a read, a comment, and string or template text spelling a write do not count", () => {
    const text = [
      "const a = process.env.FLAIR_X;",
      'if (process.env["FLAIR_X"] === "1") {}',
      '// process.env.FLAIR_X = "1";',
      '/* process.env.FLAIR_X = "1"; */',
      'const b = "process.env.FLAIR_X = 1";',
      "const c = `process.env.FLAIR_X = ${a}`;",
    ].join("\n");
    expect(writesIn(text)).toEqual([]);
    expect(unscannableIn(text)).toEqual([]);
  });

  test("a non-literal bracket key, and an Object.assign source the scan cannot read, are unscannable", () => {
    const text = [
      'process.env[name] = "1";',
      "const v = process.env[name];",
      "Object.assign(process.env, saved);",
      "Object.assign(process.env, { ...saved });",
      'Object.assign(process.env, { [name]: "1" });',
    ].join("\n");
    expect(unscannableIn(text)).toEqual([
      "1 process.env[name]",
      "2 process.env[name]",
      "3 Object.assign(process.env, saved)",
      "4 ...saved",
      '5 [name]: "1"',
    ]);
    expect(unscannableMismatches(scan([{ file: FIXTURE, text }]).unscannable)).toContain(
      `${FIXTURE}:1 process.env[name] (listed sites: 0)`,
    );
  });

  test("commenting out an allowlisted file's writes makes the stale check fail", () => {
    const target = "test/integration/feed-ephemeral-expiry-e2e.test.ts";
    const sources = integrationSources();
    const lines = new Set(scan(sources).writes.filter((entry) => entry.file === target).map((entry) => entry.line));
    expect(lines.size).toBeGreaterThan(0);
    const commented = sources.map((source) => source.file !== target ? source : {
      file: source.file,
      text: source.text.split("\n").map((text, index) => (lines.has(index + 1) ? `// ${text}` : text)).join("\n"),
    });
    const { writes } = scan(commented);
    expect(staleEntries(writes)).toEqual([`${target}: FLAIR_EPHEMERAL_TTL_HOURS`]);
    expect(unexpectedWrites(writes)).toEqual([]);
  });
});
