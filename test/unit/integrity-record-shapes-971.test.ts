import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  canonicalJson,
  commitGeneration,
  generationPath,
  initializeIntegrityCustody,
  machineIdentity,
  openIntegrityState,
  signIntegrityRecord,
  tombstoneEnrollment,
  verifyIntegrityRecord,
  type CommitGenerationOptions,
  type IntegrityStateOptions,
} from "../../src/lib/integrity-state.ts";

expect(ts.version).toBe(JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")).devDependencies.typescript);

const sourcePath = join(import.meta.dirname, "../../src/lib/integrity-state.ts");
const program = ts.createProgram([sourcePath], {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(sourcePath);
if (!source) throw new Error(`missing source: ${sourcePath}`);

type RootKind = "registry" | "checkpoint" | "current";
type Field = {
  record: string;
  name: string;
  declaredType: string;
  optional: boolean;
  path: (string | number)[];
  wrong: unknown;
};
type RecordCase = { name: string; kind: RootKind; fields: Field[] };

function wrongValue(type: ts.Type, label: string): unknown {
  const members = (type.isUnion() ? type.types : [type]).filter((member) => !(member.flags & ts.TypeFlags.Undefined));
  if (members.length && members.every((member) => member.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Null))) return 42;
  if (members.length && members.every((member) => member.flags & ts.TypeFlags.NumberLike)) return "wrong";
  if (members.length && members.every((member) => member.flags & ts.TypeFlags.BooleanLike)) return "wrong";
  if (members.length === 1 && checker.isArrayType(members[0]!)) return {};
  if (members.length === 1 && members[0]!.flags & ts.TypeFlags.Object &&
      (members[0]!.getProperties().length || checker.getIndexInfosOfType(members[0]!).length)) return [];
  throw new Error(`no wrong-type mapping for ${label}: ${checker.typeToString(type)}`);
}

const cases: RecordCase[] = [];
function enumerate(type: ts.Type, path: (string | number)[], fields: Field[], ancestors: Set<ts.Type>): void {
  if (ancestors.has(type)) throw new Error(`recursive persisted type: ${checker.typeToString(type)}`);
  const next = new Set(ancestors).add(type);
  const record = type.aliasSymbol ? checker.typeToString(type) : type.getSymbol()?.name ?? checker.typeToString(type);
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? type.aliasSymbol?.declarations?.[0];
    if (!declaration) throw new Error(`missing declaration: ${record}.${property.name}`);
    const declared = checker.getTypeOfSymbolAtLocation(property, declaration);
    const fieldPath = [...path, property.name];
    fields.push({
      record, name: property.name, declaredType: checker.typeToString(declared),
      optional: Boolean(property.flags & ts.SymbolFlags.Optional), path: fieldPath,
      wrong: wrongValue(declared, `${record}.${property.name}`),
    });
    descend(declared, fieldPath, fields, next);
  }
  for (const index of checker.getIndexInfosOfType(type)) {
    if (!(index.keyType.flags & ts.TypeFlags.String)) throw new Error(`unmapped index key: ${record}`);
    const fieldPath = [...path, "mem-a"];
    fields.push({
      record, name: "[string]", declaredType: checker.typeToString(index.type), optional: true,
      path: fieldPath, wrong: wrongValue(index.type, `${record}[string]`),
    });
    descend(index.type, fieldPath, fields, next);
  }
}

function descend(type: ts.Type, path: (string | number)[], fields: Field[], ancestors: Set<ts.Type>): void {
  const members = (type.isUnion() ? type.types : [type]).filter((member) => !(member.flags & ts.TypeFlags.Undefined));
  if (members.length !== 1) return;
  const member = members[0]!;
  if (checker.isArrayType(member)) {
    const element = checker.getTypeArguments(member as ts.TypeReference)[0];
    if (!element) throw new Error(`missing array element: ${path.join(".")}`);
    if (element.flags & ts.TypeFlags.Unknown) return;
    descend(element, [...path, 0], fields, ancestors);
  } else if (member.flags & ts.TypeFlags.Object) {
    enumerate(member, path, fields, ancestors);
  }
}

for (const node of source.statements) {
  if (!ts.isFunctionDeclaration(node)) continue;
  const signature = checker.getSignatureFromDeclaration(node);
  const predicate = signature && checker.getTypePredicateOfSignature(signature);
  if (!predicate?.type) continue;
  const type = predicate.type;
  const kindProperty = type.getProperty("kind");
  if (!kindProperty) throw new Error(`unmapped validator predicate: ${checker.typeToString(type)}`);
  const kindType = checker.getTypeOfSymbolAtLocation(kindProperty, node);
  if (!kindType.isStringLiteral() || !["registry", "checkpoint", "current"].includes(kindType.value)) {
    throw new Error(`unmapped persisted root: ${checker.typeToString(type)}`);
  }
  const fields: Field[] = [];
  enumerate(type, [], fields, new Set());
  cases.push({ name: checker.typeToString(type), kind: kindType.value as RootKind, fields });
}
if (!cases.length) throw new Error("no persisted validator predicates discovered");
const custodyRecord = source.statements.find((node): node is ts.TypeAliasDeclaration =>
  ts.isTypeAliasDeclaration(node) && node.name.text === "CustodyRecord");
if (!custodyRecord) throw new Error("missing CustodyRecord");
const custodyType = checker.getTypeFromTypeNode(custodyRecord.type);
expect((custodyType.isUnion() ? custodyType.types : [custodyType]).map((type) => checker.typeToString(type)).sort())
  .toEqual(cases.map((record) => record.name).sort());

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flair-971-shapes-"));
  scratch.push(root);
  const operatorUid = process.getuid?.() ?? 0;
  const options: IntegrityStateOptions = {
    custodyDir: join(root, "custody"), operatorUid,
    serverUid: operatorUid === 0 ? 65534 : operatorUid + 1000,
    serverUidSource: "measured", machineId: machineIdentity(), newCustody: true,
  };
  const initialized = initializeIntegrityCustody(options);
  expect(initialized.ok).toBe(true);
  if (!initialized.ok) throw new Error(initialized.detail);
  const state = initialized.state;
  const checkpoint = {
    baseline: {
      scannedAt: "2026-11-04T00:00:00.000Z", scanStartedAt: "2026-11-04T00:00:00.000Z",
      scanEndedAt: "2026-11-04T00:00:01.000Z", clockSource: "test",
      byDurability: { permanent: 1, persistent: 0, standard: 0, ephemeral: 0 },
      ids: { "mem-a": "permanent" }, instanceTokens: { "mem-a": "tok-a" },
    },
    journal: [{ at: "2026-11-04T00:00:01.000Z", kind: "scan", detail: "complete" }],
    pendingEvents: [{ event: "scan" }],
  };
  expect(commitGeneration({ state, expectedGeneration: 0, checkpoint }).ok).toBe(true);
  options.newCustody = false;
  const paths = {
    registry: state.paths.registryPath, current: state.paths.currentPath,
    checkpoint: generationPath(state.paths.generationsDir, 1),
  };
  const records = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, JSON.parse(readFileSync(path, "utf8"))]));
  records.registry.entries.push({ ...records.registry.entries[0], enrollmentId: "other", tombstonedAt: "2026-11-04T00:00:02.000Z" });
  return { state, options, paths, records };
}

function replaceField(record: Record<string, unknown>, path: (string | number)[], wrong: unknown, remove: boolean): void {
  let parent: any = record;
  for (const part of path.slice(0, -1)) {
    if (!Object.hasOwn(parent, part)) throw new Error(`missing valid fixture: ${path.join(".")}`);
    parent = parent[part];
  }
  const key = path.at(-1)!;
  if (!Object.hasOwn(parent, key)) throw new Error(`missing valid fixture: ${path.join(".")}`);
  if (remove) delete parent[key];
  else parent[key] = wrong;
}

for (const recordCase of cases) {
  describe(`declaration-driven ${recordCase.name}`, () => {
    for (const field of recordCase.fields) {
      const entry = field.record === "IntegrityEnrollmentEntry";
      for (const status of entry ? ["active", "tombstoned"] : [null]) {
        for (const remove of field.optional ? [false] : [false, true]) {
          const label = `${field.record}.${field.name}: ${field.declaredType} (${field.optional ? "optional" : "required"})`;
          it(`${label}${status ? ` [${status}]` : ""} refuses ${remove ? "missing" : "wrong type"}${field.name === "hmac" ? " after signing" : ""}`, () => {
            const { state, options, paths, records } = fixture();
            if (entry) records.registry.entries[1].status = status;
            const path = entry ? ["entries", 1, ...field.path.slice(2)] : field.path;
            const valid = signIntegrityRecord(records[recordCase.kind], state.key);
            writeFileSync(paths[recordCase.kind], `${canonicalJson(valid)}\n`);
            expect(openIntegrityState(options).ok, `${label}: valid control`).toBe(true);
            const mutated = structuredClone(valid);
            if (field.name !== "hmac") replaceField(mutated, path, field.wrong, remove);
            const signed = signIntegrityRecord(mutated, state.key);
            expect(verifyIntegrityRecord(signed, state.key), `${label}: signature`).toBe(true);
            if (field.name === "hmac") replaceField(signed, path, field.wrong, remove);
            writeFileSync(paths[recordCase.kind], `${canonicalJson(signed)}\n`);
            const opened = openIntegrityState(options);
            expect(opened.ok, `${label}: open`).toBe(false);
            if (!opened.ok) expect(opened.detail, `${label}: shape refusal`).toContain("not a valid v3");
            const before = Object.values(paths).map((path) => readFileSync(path, "utf8"));
            if (recordCase.kind === "registry" || recordCase.kind === "current") {
              const committed = commitGeneration({ state, expectedGeneration: 1, checkpoint: records.checkpoint });
              expect(committed.ok, `${label}: commit reads`).toBe(false);
              if (!committed.ok) expect(committed.detail).toContain("not a valid v3");
              if (recordCase.kind === "registry") {
                const tombstoned = tombstoneEnrollment({ ...options, expectedSequence: state.registry.sequence });
                expect(tombstoned.ok, `${label}: registry write reads`).toBe(false);
                if (!tombstoned.ok) expect(tombstoned.detail).toContain("not a valid v3");
              }
            } else if (["baseline", "journal", "pendingEvents"].includes(String(path[0]))) {
              writeFileSync(paths.checkpoint, `${canonicalJson(valid)}\n`);
              const committed = commitGeneration({ state, expectedGeneration: 1, checkpoint: signed as unknown as CommitGenerationOptions["checkpoint"] });
              expect(committed.ok, `${label}: checkpoint write`).toBe(false);
              if (!committed.ok) expect(committed.detail).toContain("cannot prepare the checkpoint");
              writeFileSync(paths.checkpoint, `${canonicalJson(signed)}\n`);
            }
            expect(Object.values(paths).map((path) => readFileSync(path, "utf8")), `${label}: retained records`).toEqual(before);
            writeFileSync(paths[recordCase.kind], `${canonicalJson(valid)}\n`);
            expect(commitGeneration({ state, expectedGeneration: 1, checkpoint: records.checkpoint }).ok, `${label}: valid commit control`).toBe(true);
            if (recordCase.kind === "registry") {
              expect(tombstoneEnrollment({ ...options, expectedSequence: state.registry.sequence }).ok, `${label}: valid registry write control`).toBe(true);
            }
          }, 20_000);
        }
      }
    }
  });
}
