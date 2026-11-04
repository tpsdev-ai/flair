/**
 * restore-soul-admission-2953.test.ts — archive admission refuses, before
 * `--replace` can delete its live copy, a row these named checks reject
 * (flair#2953).
 *
 * Three classes, each refused as `invalid-row` at the row's own field before
 * any request: a Soul row without a non-empty string `agentId`; a row id
 * containing `.` in any collection, which admission conservatively refuses
 * because a suffix such as `.json` or `.content` can be read as a content type
 * or an attribute selector; and a row that does not match the GraphQL schema
 * of its table (a required column absent, or a present non-null column holding
 * the wrong JS type).
 * The command cases run the real restore command with `fetch` as its only
 * write path; a refusal sends no request at all.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  parseRestoreArchive,
  RESTORE_TABLE_FIELDS,
  RESTORE_WRITE_SUPPLIED_FIELDS,
  type RestoreColumnType,
} from "../../src/lib/restore-archive.ts";

const root = join(import.meta.dir, "../..");
const commandPath = join(root, "src/commands/restore.ts");
const commanderPath = join(root, "node_modules/commander/index.js");

const AGENT = { id: "agent-a", name: "agent-a" };
const SOUL = { id: "soul-1", agentId: "agent-a", key: "role", value: "builder" };
const MEMORY = { id: "memory-1", agentId: "agent-a", content: "a note" };

interface Archive {
  agents: Array<Record<string, unknown>>;
  souls: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
}

function archiveText(archive: Partial<Archive> = {}): string {
  return `${JSON.stringify({ version: 1, agents: [AGENT], souls: [SOUL], memories: [MEMORY], ...archive })}\n`;
}

type Call = { method: string; path: string };

/** Run the restore command in a child process with `fetch` recording every call. */
async function restore(text: string): Promise<{ exitCode: number; stdout: string; stderr: string; calls: Call[] }> {
  const dir = tempDir("flair-restore-soul-admission-2953-");
  const archivePath = join(dir, "old-backup.json");
  const bytes = Buffer.from(text);
  writeFileSync(archivePath, bytes);
  const name = basename(archivePath);
  writeFileSync(`${archivePath}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
  const callsPath = join(dir, "calls.json");
  const driver = join(dir, "driver.ts");
  writeFileSync(driver, `
    import { Command } from ${JSON.stringify(commanderPath)};
    import { bindCli, register } from ${JSON.stringify(commandPath)};
    import { readFileSync, writeFileSync } from "node:fs";
    const callsPath = ${JSON.stringify(callsPath)};
    writeFileSync(callsPath, "[]");
    globalThis.fetch = async (url, options = {}) => {
      const calls = JSON.parse(readFileSync(callsPath, "utf8"));
      calls.push({ method: options.method ?? "GET", path: new URL(String(url)).pathname });
      writeFileSync(callsPath, JSON.stringify(calls));
      return new Response(null, { status: 204 });
    };
    bindCli({ resolveHttpPort: () => { throw new Error("unexpected port lookup"); } });
    const program = new Command();
    register(program);
    await program.parseAsync(["restore", ${JSON.stringify(archivePath)}, "--replace", "--url", "http://restore.invalid", "--admin-pass", "fixture"], { from: "user" });
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const child = Bun.spawn([process.execPath, driver], { env: { ...env, HOME: dir, USERPROFILE: dir }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr, calls: JSON.parse(readFileSync(callsPath, "utf8")) };
}

/** Assert one archive is refused at `location` before any request reaches the server. */
async function refusedBeforeAnyRequest(text: string, location: string, reason: RegExp): Promise<void> {
  const parsed = parseRestoreArchive(Buffer.from(text));
  expect(parsed).toMatchObject({ ok: false, code: "invalid-row", location });
  if (parsed.ok) throw new Error(`archive admission accepted a row it must refuse at ${location}`);
  expect(parsed.reason).toMatch(reason);

  const result = await restore(text);
  expect(result.exitCode).not.toBe(0);
  expect(result.calls).toEqual([]);
  expect(result.stdout).not.toContain("Restoring from");
  expect(result.stderr).toContain(`(invalid-row at ${location})`);
}

describe("archive admission refuses a Soul row without a non-empty string agentId (flair#2953)", () => {
  for (const [label, agentId] of [["missing", undefined], ["empty string", ""], ["non-string", 42]] as const) {
    const soul: Record<string, unknown> = { id: "soul-1", key: "role", value: "builder" };
    if (agentId !== undefined) soul.agentId = agentId;
    const text = archiveText({ souls: [soul] });

    test(`the real admission function refuses an agentId that is ${label}`, () => {
      const parsed = parseRestoreArchive(Buffer.from(text));
      expect(parsed).toMatchObject({ ok: false, code: "invalid-row", location: "/souls/0/agentId" });
      if (parsed.ok) throw new Error("archive admission accepted a Soul row without a non-empty string agentId");
      expect(parsed.reason).toContain("agentId");
    });

    test(`the restore command refuses an agentId that is ${label} before any request`, async () => {
      const result = await restore(text);
      expect(result.exitCode).not.toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.stdout).not.toContain("Restoring from");
      expect(result.stderr).toContain("(invalid-row at /souls/0/agentId)");
    });
  }
});

describe("archive admission refuses a row id containing a dot in every collection (flair#2953)", () => {
  const cases = [
    { collection: "agents", location: "/agents/0/id", row: { ...AGENT, id: "agent-a.json" } },
    { collection: "souls", location: "/souls/0/id", row: { ...SOUL, id: "soul-1.json" } },
    { collection: "memories", location: "/memories/0/id", row: { ...MEMORY, id: "memory-1.cbor" } },
  ] as const;

  for (const { collection, location, row } of cases) {
    test(`a row id with a dot in ${collection} is refused at ${location}`, async () => {
      await refusedBeforeAnyRequest(archiveText({ [collection]: [row] }), location, /contains "\."/);
    });
  }

  test("a dot in an id is refused, while a slash, query or fragment is not", () => {
    expect(parseRestoreArchive(Buffer.from(archiveText({ memories: [{ ...MEMORY, id: "a/b?c#d%" }] }))).ok).toBe(true);
  });
});

describe("archive admission refuses a row that does not match its table's schema (flair#2953)", () => {
  test("a Soul row with a non-string value is refused at /souls/0/value before any request", async () => {
    await refusedBeforeAnyRequest(
      archiveText({ souls: [{ ...SOUL, value: 42 }] }),
      "/souls/0/value",
      /value is not a string \(the schema declares String\)/,
    );
  });

  test("a Soul row with a non-string priority or metadata is refused", async () => {
    await refusedBeforeAnyRequest(
      archiveText({ souls: [{ ...SOUL, priority: 1 }] }),
      "/souls/0/priority",
      /priority is not a string \(the schema declares String\)/,
    );
    await refusedBeforeAnyRequest(
      archiveText({ souls: [{ ...SOUL, metadata: { source: "npm:@example/skills@1.0.0" } }] }),
      "/souls/0/metadata",
      /metadata is not a string \(the schema declares String\)/,
    );
  });

  test("a Soul row with no key or no value is refused", async () => {
    const { key: _key, ...noKey } = SOUL;
    await refusedBeforeAnyRequest(archiveText({ souls: [noKey] }), "/souls/0/key", /has no key \(the schema requires String\)/);
    const { value: _value, ...noValue } = SOUL;
    await refusedBeforeAnyRequest(archiveText({ souls: [noValue] }), "/souls/0/value", /has no value \(the schema requires String\)/);
  });

  test("a Memory row with a wrong-typed required field is refused", async () => {
    await refusedBeforeAnyRequest(
      archiveText({ memories: [{ ...MEMORY, content: 42 }] }),
      "/memories/0/content",
      /content is not a string \(the schema declares String\)/,
    );
    const { content: _content, ...noContent } = MEMORY;
    await refusedBeforeAnyRequest(archiveText({ memories: [noContent] }), "/memories/0/content", /has no content/);
  });

  test("a present optional column of the wrong type is refused; a null one reads as absent", async () => {
    await refusedBeforeAnyRequest(
      archiveText({ memories: [{ ...MEMORY, tags: "note" }] }),
      "/memories/0/tags",
      /tags is not an array of strings \(the schema declares String\[\]\)/,
    );
    await refusedBeforeAnyRequest(
      archiveText({ memories: [{ ...MEMORY, retrievalCount: 1.5 }] }),
      "/memories/0/retrievalCount",
      /retrievalCount is not an integer \(the schema declares Int\)/,
    );
    expect(parseRestoreArchive(Buffer.from(archiveText({ souls: [{ ...SOUL, priority: null }] }))).ok).toBe(true);
  });

  test("an Agent row with no name is refused", async () => {
    const { name: _name, ...noName } = AGENT;
    await refusedBeforeAnyRequest(archiveText({ agents: [noName] }), "/agents/0/name", /has no name \(the schema requires String\)/);
  });
});

/** Every column of `type <name>` in `schemaText`, with the JS value its type holds. */
function schemaColumnsFromText(schemaText: string, table: string, label: string): Array<[string, { type: RestoreColumnType; required: boolean }]> {
  const lines = schemaText.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^type ${table} @table`).test(line));
  expect(start).toBeGreaterThan(-1);
  const columns: Array<[string, { type: RestoreColumnType; required: boolean }]> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\}\s*$/.test(line)) break;
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(\[[A-Za-z]+\]|[A-Za-z]+)(!?)/.exec(line);
    if (!match) throw new Error(`${label}:${i + 1}: expected a field, got ${JSON.stringify(line)}`);
    const type = match[2].startsWith("[") ? `${match[2].slice(1, -1)}[]` : match[2];
    columns.push([match[1], { type: type as RestoreColumnType, required: match[3] === "!" }]);
  }
  return columns;
}

function schemaColumns(schemaPath: string, table: string): Array<[string, { type: RestoreColumnType; required: boolean }]> {
  return schemaColumnsFromText(readFileSync(join(root, schemaPath), "utf8"), table, schemaPath);
}

describe("the restore field table matches the GraphQL schema (flair#2953)", () => {
  const sources = [
    ["Agent", "schemas/agent.graphql"],
    ["Soul", "schemas/memory.graphql"],
    ["Memory", "schemas/memory.graphql"],
  ] as const;

  for (const [table, schemaPath] of sources) {
    test(`every ${table} column and its type matches the schema`, () => {
      const columns = schemaColumns(schemaPath, table);
      expect(columns.length).toBeGreaterThan(5);
      expect(Object.keys(RESTORE_TABLE_FIELDS[table])).toEqual(columns.map(([name]) => name));
      for (const [name, column] of columns) {
        expect({ column: name, ...RESTORE_TABLE_FIELDS[table][name] }).toEqual({ column: name, ...column });
      }
    });

    test(`each required ${table} column the write supplies is assigned by the resource${table === "Agent" ? " from the stored row (a row lacking it is refused)" : ""}`, () => {
      const resource = { Agent: "resources/Agent.ts", Soul: "resources/Soul.ts", Memory: "resources/Memory.ts" }[table];
      const source = readFileSync(join(root, resource), "utf8");
      for (const field of RESTORE_WRITE_SUPPLIED_FIELDS[table]) {
        expect(RESTORE_TABLE_FIELDS[table][field]?.required).toBe(true);
        expect(new RegExp(`content\\.${field}\\s*=`).test(source)).toBe(true);
      }
    });
  }

  test("a field indented with a tab or four spaces is a field, not a skipped line", () => {
    const schema = readFileSync(join(root, "schemas/memory.graphql"), "utf8");
    const fixture = schema
      .replace(/^  value: String!/m, "\tvalue: String!")
      .replace(/^  priority: String/m, "    priority: String");
    const names = schemaColumnsFromText(fixture, "Soul", "memory.graphql fixture").map(([name]) => name);
    expect(names).toContain("value");
    expect(names).toContain("priority");
  });

  test("an unparsed line inside a table block fails naming the line", () => {
    const fixture = "type Soul @table {\n  id: ID\n  this is not a field\n}\n";
    expect(() => schemaColumnsFromText(fixture, "Soul", "fixture.graphql")).toThrow(/fixture\.graphql:3:/);
  });
});
