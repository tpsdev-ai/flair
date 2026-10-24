/**
 * flair#2837 — the admin-only gate admits an administrator credential, an admin
 * agent, or a DELIBERATE internal call. A missing context resolves to `internal`
 * by omission and is refused.
 *
 * Every resource class that gates on `allowAdmin` is enumerated LITERALLY below,
 * and a guard reads `git grep -l "allowAdmin("` in resources/ and fails when a
 * gated class is not named here — so adding an admin-gated resource without a
 * case fails this file.
 *
 * Harper is mocked (a Resource base + a table-class proxy) because these modules
 * extend Harper's runtime globals and cannot be imported outside a Harper
 * process. The gate decision itself is the real `allowAdmin`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, mock } from "bun:test";

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

/**
 * class name → module that exports it → the allow* methods that call allowAdmin.
 * Written by hand from the resource sources, never derived from this test's own
 * expectations of the gate.
 */
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

describe("flair#2837 — the admin gate admits only a deliberate internal call", () => {
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

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every class whose own body calls allowAdmin, parsed from the resource sources. */
function classesCallingAllowAdmin(): Set<string> {
  const files = execFileSync("git", ["grep", "-l", "allowAdmin(", "--", "resources"], {
    cwd: join(import.meta.dir, "..", ".."),
    encoding: "utf8",
    timeout: 10_000,
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  const found = new Set<string>();
  for (const file of files) {
    const src = stripComments(readFileSync(join(import.meta.dir, "..", "..", file), "utf8"));
    const headerRe = /\bclass\s+(\w+)[^{]*\{/g;
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(src))) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      if (src.slice(start, i).includes("allowAdmin(")) found.add(m[1]);
    }
  }
  return found;
}

describe("flair#2837 — every class that gates on allowAdmin has a case here", () => {
  const named = new Set(ADMIN_GATED.map((c) => c.cls));

  it("the guard sees the same set of gated classes as the literal list", () => {
    const found = classesCallingAllowAdmin();
    const missing = [...found].filter((c) => !named.has(c)).sort();
    const stale = [...named].filter((c) => !found.has(c)).sort();
    expect(missing, `admin-gated classes with no case: ${missing.join(", ")}`).toEqual([]);
    expect(stale, `listed classes that no longer gate on allowAdmin: ${stale.join(", ")}`).toEqual([]);
  }, 10_000);

  it("each listed class's gated methods are all in the case list", async () => {
    for (const { cls, module, methods } of ADMIN_GATED) {
      const mod: any = await import(`../../resources/${module}`);
      const proto = mod[cls]?.prototype ?? {};
      const present = Object.getOwnPropertyNames(proto)
        .filter((name) => /^allow(Read|Create|Update|Delete|Upsert|Connect)$/.test(name))
        .filter((name) => stripComments(Function.prototype.toString.call(proto[name])).includes("allowAdmin("))
        .sort();
      expect(present, `${cls}: gated methods on the prototype differ from the case list`).toEqual([...methods].sort());
    }
  }, 10_000);
});
