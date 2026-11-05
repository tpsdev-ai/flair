/**
 * owner-scoped-resource-inventory.test.ts — the structural reader behind the
 * owner-scoped write matrix's coverage self-check
 * (test/helpers/owner-scoped-resource-inventory.ts).
 *
 * These cases pin the `extends` forms the reader recognises (see the helper's
 * header for the exact list) and a form it does not. The matrix's primary
 * coverage gate does not depend on this reader: every OWNER_FIELDS table must
 * have a spec or a stated exception.
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { classesInSource, ownerScopedInventory, resourceClasses } from "../helpers/owner-scoped-resource-inventory";
import { OWNER_FIELDS } from "../../resources/record-owner-guard.js";

const tableOf = (src: string) => classesInSource("x.ts", src).map((c) => [c.className, c.table]);

describe("classesInSource recognises a flair-table base by structure", () => {
  const spellings: Array<[string, string]> = [
    ["cast receiver", "export class A extends (databases as any).flair.Memory {}"],
    ["plain receiver", "export class A extends databases.flair.Memory {}"],
    ["string element access", 'export class A extends databases.flair["Memory"] {}'],
    ["spacing and newlines", "export class A extends (\n  databases as any\n).flair\n  .Memory {}"],
    ["angle-bracket assertion", "export class A extends (<any>databases).flair.Memory {}"],
    ["non-null assertion", "export class A extends databases!.flair!.Memory {}"],
    ["deeper receiver", "export class A extends (harper.databases as any).flair.Memory {}"],
    ["same-file alias", "const Base = (databases as any).flair.Memory;\nexport class A extends Base {}"],
    ["transitive same-file alias", "const A0 = databases.flair.Memory;\nconst B0 = A0;\nexport class A extends B0 {}"],
  ];
  for (const [label, src] of spellings) {
    it(`reads the extended table from a ${label}`, () => {
      expect(tableOf(src)).toEqual([["A", "Memory"]]);
    });
  }

  it("does not read a table from a class that extends something else", () => {
    expect(tableOf("export class A extends Resource {}")).toEqual([["A", null]]);
    expect(tableOf("export class A extends other.Memory {}")).toEqual([["A", null]]);
    expect(tableOf("export class A {}")).toEqual([["A", null]]);
  });

  it("does not recognise a base it cannot see in the same file (an import), and survives an alias cycle", () => {
    expect(tableOf('import { Base } from "./base.js";\nexport class A extends Base {}')).toEqual([["A", null]]);
    expect(tableOf("const P = Q;\nconst Q = P;\nexport class A extends P {}")).toEqual([["A", null]]);
  });
});

describe("ownerScopedInventory", () => {
  it("lists tables served by a table-extending class, and owner-named classes that extend something else", () => {
    const classes = [
      ...classesInSource("Memory.ts", "export class Memory extends (databases as any).flair.Memory {}"),
      ...classesInSource("Odd.ts", 'export class Whatever extends databases.flair["Relationship"] {}'),
      ...classesInSource("ARP.ts", "export class AgentReadPosition extends Resource {}"),
      ...classesInSource("Peer.ts", "export class Peer extends databases.flair.Peer {}"),
    ];
    const inv = ownerScopedInventory(classes, ["Memory", "Relationship", "AgentReadPosition"]);
    expect(inv.tableExtending).toEqual(["Memory", "Relationship"]);
    expect(inv.customRoutes.map((c) => c.className)).toEqual(["AgentReadPosition"]);
  });

  it("finds at least the guarded tables of this repository's resources", () => {
    const inv = ownerScopedInventory(resourceClasses(join(import.meta.dir, "..", "..", "resources")), Object.keys(OWNER_FIELDS));
    for (const t of ["Memory", "Relationship", "OrgEvent", "Presence", "Credential"]) expect(inv.tableExtending).toContain(t);
  });
});
