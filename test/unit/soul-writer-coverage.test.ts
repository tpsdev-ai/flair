import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { rawTableWriteSites } from "../helpers/raw-table-writers";

const classified = new Map<string, string>();
const add = (file: string, sites: string[], reason: string) => {
  for (const site of sites) classified.set(`resources/${file}.ts:${site}`, reason);
};
add("Soul", ["alias-source:(databases as any).flair.Soul#1", "writer:super.post#1", "writer:super.put#1", "writer:super.patch#1", "writer:super.delete#1"], "Resource boundary: operator or deliberate internal authorization; content backstop on writes.");
add("AgentSeed", ["writer:(databases as any).flair.Soul.put#1"], "Provisioning: source authorization and whole-template content validation precede mutations.");
add("AgentSeed", ["writer:(databases as any).flair.Agent.put#1", "writer:(databases as any).flair.Memory.put#1"], "Other tables in the provisioning module, included by conservative sink enumeration.");
add("Federation", ["alias-source:(databases as any).flair.Soul#1", "writer:table.put#1"], "Explicit replication path: authenticated pinned instance keys and federation classification; preserve originating provenance.");
add("Federation", ["writer:(databases as any).flair.Instance.put#1", "writer:(databases as any).flair.Peer.put#1", "writer:(databases as any).flair.Peer.put#2", "writer:(databases as any).flair.Peer.put#3", "writer:(databases as any).flair.PairingToken.put#1", "writer:(databases as any).flair.SyncLog.put#1"], "Other tables in the federation module, included by conservative sink enumeration.");

test("every raw Soul capability and mutation sink has an explicit policy", () => {
  const sites = [...new Glob("resources/**/*.ts").scanSync(".")].flatMap(file => rawTableWriteSites(file, readFileSync(file, "utf8"), "Soul"));
  expect(sites.filter(site => !classified.has(site.key))).toEqual([]);
  expect([...classified.keys()].filter(key => !sites.some(site => site.key === key))).toEqual([]);
});

test("new direct, aliased, computed and helper mutation paths fail classification", () => {
  for (const source of [
    "databases.flair.Soul.put(row)",
    "const soul = databases.flair.Soul; soul.delete(id)",
    "patchRecord(databases.flair.Soul, id, data)",
    'const db = databases.flair; db["Soul"].patch(row)',
    "const { Soul: soul } = databases.flair; soul.update(id, row)",
    "const tables = { Soul: databases.flair.Soul }; tables[name].post(row)",
  ]) {
    const sites = rawTableWriteSites("resources/NewWriter.ts", source, "Soul");
    expect(sites.some(site => site.kind === "writer" && !classified.has(site.key))).toBe(true);
  }
  expect(rawTableWriteSites("example.ts", '// databases.flair.Soul.put(row)', "Soul")).toEqual([]);
});
