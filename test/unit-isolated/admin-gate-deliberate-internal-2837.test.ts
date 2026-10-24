/**
 * flair#2837 — the admin-only gate (`allowAdmin`) on each class in ADMIN_GATED:
 * no context is refused, `internalContext()` and `adminContext(id)` are
 * admitted, and `agentContext(id)` is refused.
 *
 * The resource classes this file checks are listed literally below.
 * A guard parses each tracked resources/ TypeScript source with the TypeScript
 * parser and fails when a class it finds calling allowAdmin, or an allow*
 * method of one that calls it, is not listed here, or when it finds a reference to
 * allowAdmin it cannot attribute to a class member.
 *
 * Harper is mocked (a Resource base + a table-class proxy). The gate decision
 * itself is the real `allowAdmin`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, mock } from "bun:test";
import ts from "typescript";

class NoopBase {
  constructor(_id?: any, _ctx?: any) {}
  static async get() { return undefined; }
  static async *search() {}
}
const dbStub = new Proxy({}, { get: () => NoopBase });
mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: NoopBase,
  databases: { flair: dbStub },
}));

const { agentContext, adminContext, internalContext } = await import("../../resources/in-process.ts");

const RESOURCES_DIR = join(import.meta.dir, "..", "..", "resources");

/** class name → module that exports it → the allow* methods that call allowAdmin. */
const ADMIN_GATED: Array<{ cls: string; module: string; methods: string[] }> = [
  { cls: "Admin", module: "Admin.ts", methods: ["allowRead"] },
  { cls: "AdminConnectors", module: "AdminConnectors.ts", methods: ["allowRead"] },
  { cls: "AdminDashboard", module: "AdminDashboard.ts", methods: ["allowRead"] },
  { cls: "AdminIdp", module: "AdminIdp.ts", methods: ["allowRead"] },
  { cls: "AdminInstance", module: "AdminInstance.ts", methods: ["allowRead"] },
  { cls: "AdminMemory", module: "AdminMemory.ts", methods: ["allowRead"] },
  { cls: "AdminMemoryCandidates", module: "AdminMemoryCandidates.ts", methods: ["allowRead"] },
  { cls: "AdminPrincipals", module: "AdminPrincipals.ts", methods: ["allowRead"] },
  { cls: "Agent", module: "Agent.ts", methods: ["allowCreate", "allowDelete"] },
  { cls: "AgentKeyRegistration", module: "AgentKeyRegistration.ts", methods: ["allowRead"] },
  { cls: "AgentSeed", module: "AgentSeed.ts", methods: ["allowCreate"] },
  { cls: "FederationInstance", module: "Federation.ts", methods: ["allowRead"] },
  { cls: "FederationPeers", module: "Federation.ts", methods: ["allowRead"] },
  { cls: "FederationRetries", module: "Federation.ts", methods: ["allowRead"] },
  { cls: "FederationRetry", module: "FederationRetry.ts", methods: ["allowRead", "allowCreate", "allowUpdate", "allowDelete"] },
  { cls: "Instance", module: "Instance.ts", methods: ["allowCreate", "allowUpdate", "allowDelete"] },
  { cls: "MemoryDedupStats", module: "MemoryDedupStats.ts", methods: ["allowCreate"] },
  { cls: "MemoryReindex", module: "MemoryReindex.ts", methods: ["allowCreate"] },
  { cls: "OAuthClient", module: "OAuthClient.ts", methods: ["allowRead", "allowCreate", "allowUpdate", "allowDelete"] },
  { cls: "OrgEventMaintenance", module: "OrgEventMaintenance.ts", methods: ["allowCreate"] },
  { cls: "PairingToken", module: "PairingToken.ts", methods: ["allowRead", "allowCreate", "allowUpdate", "allowDelete"] },
  { cls: "Peer", module: "Peer.ts", methods: ["allowRead", "allowCreate", "allowUpdate", "allowDelete"] },
  { cls: "IdpConfig", module: "XAA.ts", methods: ["allowRead", "allowCreate", "allowUpdate", "allowDelete"] },
];

/** The gate call each resource makes: `allowAdmin((this as any).getContext?.())`. */
async function gate(cls: string, module: string, method: string, context: unknown): Promise<boolean> {
  const mod: any = await import(`../../resources/${module}`);
  const Cls = mod[cls];
  if (typeof Cls !== "function") throw new Error(`${module} does not export a class named ${cls}`);
  const instance: any = new Cls();
  instance.getContext = () => context;
  if (typeof instance[method] !== "function") throw new Error(`${cls}.${method} is not a method`);
  return await instance[method]();
}

describe("flair#2837 — allowAdmin on each class in ADMIN_GATED", () => {
  for (const { cls, module, methods } of ADMIN_GATED) {
    for (const method of methods) {
      it(`${cls}.${method}: no context is refused`, async () => {
        expect(await gate(cls, module, method, undefined)).toBe(false);
      }, 10_000);

      it(`${cls}.${method}: internalContext() is admitted`, async () => {
        expect(await gate(cls, module, method, internalContext())).toBe(true);
      }, 10_000);

      it(`${cls}.${method}: adminContext(id) is admitted`, async () => {
        expect(await gate(cls, module, method, adminContext("agent-a"))).toBe(true);
      }, 10_000);

      it(`${cls}.${method}: agentContext(id) (non-admin) is refused`, async () => {
        expect(await gate(cls, module, method, agentContext("agent-a"))).toBe(false);
      }, 10_000);
    }
  }
});

// ─── Enumeration guard ───────────────────────────────────────────────────────

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
};

/** `<expr>.allowAdmin` or `<expr>["allowAdmin"]`: a namespace or module-object member. */
const isAllowAdminMember = (node: ts.Expression): boolean =>
  (ts.isPropertyAccessExpression(node) && node.name.text === "allowAdmin") ||
  (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "allowAdmin");

/**
 * The allowAdmin calls the TypeScript parser finds in one source, as
 * `{ cls, member }`: through its own name, an import alias, a namespace or
 * module-object member, or a local alias initialised with one of those, however
 * it is formatted. Names are matched by name, not scope. Any other reference it
 * finds (a re-export, a value passed elsewhere, a call outside a class body)
 * throws.
 */
function allowAdminCallSites(file: string, source: string): Array<{ cls: string; member: string }> {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const unresolved = (node: ts.Node, what: string): never => {
    throw new Error(`unresolved allowAdmin reference (${what}): ${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
  };
  const names = new Set(["allowAdmin"]);
  const isReference = (node: ts.Expression) => (ts.isIdentifier(node) && names.has(node.text)) || isAllowAdminMember(node);
  for (let changed = true; changed;) {
    changed = false;
    const visit = (node: ts.Node): void => {
      const alias =
        (ts.isImportSpecifier(node) && !node.isTypeOnly && (node.propertyName ?? node.name).text === "allowAdmin") ||
        (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !!node.initializer && isReference(unwrap(node.initializer)));
      if (alias && !names.has((node as ts.ImportSpecifier | ts.VariableDeclaration).name.getText(ast))) {
        names.add((node as ts.ImportSpecifier | ts.VariableDeclaration).name.getText(ast));
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const sites: Array<{ cls: string; member: string }> = [];
  const visit = (node: ts.Node): void => {
    const isName = ts.isIdentifier(node) && names.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
    if (isName || (ts.isExpression(node) && isAllowAdminMember(node))) {
      const parent = node.parent;
      const declares = ts.isImportSpecifier(parent) ||
        ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node);
      let use: ts.Node = node;
      while (ts.isParenthesizedExpression(use.parent) || ts.isAsExpression(use.parent) || ts.isNonNullExpression(use.parent) ||
        ts.isTypeAssertionExpression(use.parent) || ts.isSatisfiesExpression(use.parent)) use = use.parent;
      const aliases = ts.isVariableDeclaration(use.parent) && use.parent.initializer === use;
      if (!declares && !aliases) {
        if (!(ts.isCallExpression(use.parent) && use.parent.expression === use)) unresolved(node, "not a call");
        let member: ts.Node = use.parent;
        while (member.parent && !ts.isClassLike(member.parent)) member = member.parent;
        const owner = member.parent;
        if (!owner || !ts.isClassLike(owner)) unresolved(node, "call outside a class body");
        const cls = (owner as ts.ClassLikeDeclaration).name?.text ??
          (ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name) ? owner.parent.name.text : unresolved(node, "anonymous class"));
        const name = (member as ts.ClassElement).name;
        sites.push({ cls, member: name && !ts.isComputedPropertyName(name) ? name.getText(ast) : unresolved(node, "computed member name") });
      }
      if (!isName) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return sites;
}

/** class name → the members allowAdminCallSites finds, over every tracked resources/ TypeScript source. */
function gatedMembersBySource(): Map<string, Set<string>> {
  const root = join(import.meta.dir, "..", "..");
  const files = execFileSync("git", ["ls-files", "-z", "--", "resources/*.ts"], { cwd: root, encoding: "utf8", timeout: 10_000 })
    .split("\0")
    .filter(Boolean);
  expect(files.length, "git ls-files found no resources/*.ts sources").toBeGreaterThan(0);
  const found = new Map<string, Set<string>>();
  for (const file of files) {
    for (const { cls, member } of allowAdminCallSites(file, readFileSync(join(root, file), "utf8"))) {
      if (!found.has(cls)) found.set(cls, new Set());
      found.get(cls)!.add(member);
    }
  }
  return found;
}

describe("flair#2837 — ADMIN_GATED matches the allowAdmin calls the parser finds", () => {
  const named = new Set(ADMIN_GATED.map((c) => c.cls));

  it("the scan finds a reformatted, an aliased and a namespace call, and refuses a reference it cannot follow", () => {
    const source = [
      'import { allowAdmin as gate } from "./agent-auth.js";',
      'import * as auth from "./agent-auth.js";',
      "const again = gate;",
      "export class A { allowRead() { return allowAdmin\n  (ctx); } }",
      "export class B { allowCreate() { return gate(ctx); } allowDelete() { return again(ctx); } }",
      "export class C { allowUpdate() { return (auth).allowAdmin(ctx); } }",
    ].join("\n");
    expect(allowAdminCallSites("resources/__synthetic__.ts", source)).toEqual([
      { cls: "A", member: "allowRead" },
      { cls: "B", member: "allowCreate" },
      { cls: "B", member: "allowDelete" },
      { cls: "C", member: "allowUpdate" },
    ]);
    expect(() => allowAdminCallSites("resources/__escape__.ts", 'export { allowAdmin as g } from "./agent-auth.js";')).toThrow(/unresolved/);
    expect(() => allowAdminCallSites("resources/__escape__.ts", "export const g = (c) => allowAdmin(c);")).toThrow(/unresolved/);
  });

  it("the guard sees the same set of gated classes as the literal list", () => {
    const found = gatedMembersBySource();
    const missing = [...found.keys()].filter((c) => !named.has(c)).sort();
    const stale = [...named].filter((c) => !found.has(c)).sort();
    expect(missing, `admin-gated classes with no case: ${missing.join(", ")}`).toEqual([]);
    expect(stale, `listed classes that no longer gate on allowAdmin: ${stale.join(", ")}`).toEqual([]);
  }, 10_000);

  it("each listed class's gated methods are all in the case list", () => {
    const found = gatedMembersBySource();
    for (const { cls, methods } of ADMIN_GATED) {
      const present = [...(found.get(cls) ?? [])].filter((name) => /^allow[A-Z]\w*$/.test(name)).sort();
      expect(present, `${cls}: the allow* methods that call allowAdmin differ from the case list`).toEqual([...methods].sort());
    }
  }, 10_000);
});
