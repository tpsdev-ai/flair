import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

const resourceDir = new URL("../../resources/", import.meta.url);
const classes = new Map<string, string>();
for (const file of readdirSync(resourceDir).filter(file => file.endsWith(".ts"))) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, resourceDir), "utf8"), ts.ScriptTarget.Latest, true);
  for (const node of source.statements) {
    if (!ts.isClassDeclaration(node) || !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (!node.name || node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) || node.members.some(member => member.name?.getText(source) === "path")) {
      throw new Error(`Route inventory must handle the default/static path in ${file}`);
    }
    const base = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    if (base) classes.set(node.name.text, base.getText(source));
  }
}

const names = new Set<string>();
for (const [name, base] of classes) {
  if (base === "Resource" || base.includes("databases") && base.includes(".flair.")) names.add(name);
}
let previousSize: number;
do {
  previousSize = names.size;
  for (const [name, base] of classes) if (names.has(base)) names.add(name);
} while (names.size !== previousSize);
for (const [name, base] of classes) {
  if (!names.has(name) && base !== "Error") throw new Error(`Route inventory must classify ${name} extends ${base}`);
}

const schemaDir = new URL("../../schemas/", import.meta.url);
for (const file of readdirSync(schemaDir).filter(file => file.endsWith(".graphql"))) {
  const schema = readFileSync(new URL(file, schemaDir), "utf8").replace(/#[^\n]*/g, "");
  for (const match of schema.matchAll(/\btype\s+(\w+)\s+([^{}]*)\{/g)) {
    if (match[2].includes("@table") && match[2].includes("@export")) names.add(match[1]);
  }
}

export const TPS_ED25519_ROUTES = [
  ...[...names].sort().map(name => ({ method: "GET", path: `/${name}` })),
  { method: "GET", path: "/health" },
  ...["FederationPair", "FederationSync", "OAuthAuthorize", "Presence", "A2AAdapter", "a2a"].map(name => ({ method: "POST", path: `/${name}` })),
];
