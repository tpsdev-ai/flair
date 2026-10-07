import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

let home = "";
let target: string;
let link: string;
let errors: ReturnType<typeof spyOn>;
const savedEnv = { ...process.env };
const emptyTable = { search: async function* () {}, get: async () => null };
mock.module("node:os", () => ({ ...os, homedir: () => home }));
mock.module("harper", () => {
  const noop = () => {};
  return new Proxy({
    Resource: class {}, databases: { flair: { Memory: emptyTable, Relationship: emptyTable } },
    server: { getUser: async () => null },
    logger: { info: noop, warn: noop, error: noop, debug: noop, trace: noop },
  }, { get: (t: any, p: string) => p in t ? t[p] : noop });
});
mock.module("../../resources/embeddings-provider.js", () => ({
  getMode: () => "local", getModelId: () => "hash-512d", getEmbedding: async () => null,
  getStatus: () => ({}), buildEmbedOptions: () => ({}), EMBEDDING_ENGINE: "gguf",
}));

let boot: typeof import("../../resources/migration-boot.ts");
let progress: typeof import("../../resources/migrations/progress.ts");
let HealthDetail: typeof import("../../resources/health.ts").HealthDetail;
let fetchAndRenderMigrations: typeof import("../../src/commands/doctor.ts").fetchAndRenderMigrations;

beforeEach(async () => {
  const root = tempDir("flair-2277-surfaces-");
  home = join(root, "home");
  mkdirSync(home);
  target = join(root, "real-data");
  link = join(root, "configured-data");
  mkdirSync(target);
  symlinkSync(target, link);
  process.env.FLAIR_MIGRATION_DATA_DIR = link;
  process.env.ROOTPATH = link;
  delete process.env.HDB_ROOT;
  errors = spyOn(console, "error").mockImplementation(() => {});
  progress = await import("../../resources/migrations/progress.ts");
  boot = await import("../../resources/migration-boot.ts");
  ({ HealthDetail } = await import("../../resources/health.ts"));
  ({ fetchAndRenderMigrations } = await import("../../src/commands/doctor.ts"));
  await new Promise((resolve) => setImmediate(resolve));
  boot._resetMigrationBootForTests();
  progress._resetProgressForTests();
  errors.mockClear();
});

afterEach(() => {
  boot?._resetMigrationBootForTests();
  progress?._resetProgressForTests();
  mock.restore();
  for (const key of ["FLAIR_MIGRATION_DATA_DIR", "ROOTPATH", "HDB_ROOT"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function runBoot(): Promise<void> {
  boot.scheduleMigrationBoot();
  const deadline = Date.now() + 2000;
  while (progress.getCycleStatus().phase !== "done" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(progress.getCycleStatus().phase).toBe("done");
}

async function detail(isAdmin: boolean): Promise<any> {
  const resource: any = new HealthDetail();
  resource.getContext = () => ({ request: { tpsAgent: "reader", tpsAgentIsAdmin: isAdmin } });
  expect(await resource.allowRead()).toBe(true);
  return resource.get();
}

test("boot logs both paths when no candidate is usable", async () => {
  await runBoot();
  const log = errors.mock.calls.flat().join("\n");
  expect(log).toContain("[flair-migrations] no writable migration data directory");
  expect(log).toContain(link);
  expect(log).toContain(target);
  expect(log).toContain("stop Flair");
  expect(existsSync(join(target, ".migrations"))).toBe(false);
});

test("HealthDetail retains admin diagnostics and redacts non-admin fields and warnings", async () => {
  await runBoot();
  const statePath = join(target, ".migrations", "state.json");
  progress.noteStateWriteAttempt(statePath);
  progress.noteStateWriteFailure({ migrationId: "embedding-stamp", at: new Date().toISOString(), message: `${link}: ${target}` });
  const admin = await detail(true);
  expect(admin.migrations.stateFile.path).toBe(statePath);
  expect(admin.migrations.stateFile.lastWriteError.message).toBe(`${link}: ${target}`);
  expect(admin.migrations.lastCycleError).toContain(link);
  expect(admin.migrations.lastCycleError).toContain(target);
  expect(admin.migrations.migrations.length).toBeGreaterThan(0);
  for (const m of admin.migrations.migrations) {
    expect(m.reason).toContain(link);
    expect(m.reason).toContain(target);
    expect(admin.warnings.some((w: any) => w.message.includes(m.reason))).toBe(true);
  }
  const reader = await detail(false);
  expect(reader.migrations.stateFile.path).toBe("[redacted]");
  expect(reader.migrations.stateFile.lastWriteError.message).toBeUndefined();
  expect(reader.migrations.lastCycleError).toContain("redacted");
  for (const m of reader.migrations.migrations) expect(m.reason).toContain("redacted");
  expect(reader.warnings.some((w: any) => w.message.includes("redacted"))).toBe(true);
  expect(JSON.stringify(reader)).not.toContain(link);
  expect(JSON.stringify(reader)).not.toContain(target);
});

test("doctor fetches and renders the HealthDetail refusal", async () => {
  await runBoot();
  const response = await detail(true);
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response));
  const lines = spyOn(console, "log").mockImplementation(() => {});
  const issues = await fetchAndRenderMigrations("http://fixture/HealthDetail", { Authorization: "fixture" }, "  ");
  expect(fetcher.mock.calls[0][0]).toBe("http://fixture/HealthDetail");
  expect(issues).toBe(response.migrations.migrations.length + 1);
  const rendered = lines.mock.calls.flat().map(String);
  expect(rendered.find((l) => l.includes("Last migration cycle did not complete:"))).toContain(response.migrations.lastCycleError);
  for (const m of response.migrations.migrations) {
    expect(rendered.find((l) => l.includes(`${m.id}: failed`))).toContain(m.reason);
  }
});

test("a usable fallback runs without a symlink refusal on the boot and health surfaces", async () => {
  process.env.ROOTPATH = target;
  await runBoot();
  expect(errors.mock.calls.flat().join("\n")).not.toContain("symbolic link");
  const response = await detail(true);
  expect(response.migrations.lastCycleError).toBeNull();
  expect(JSON.stringify(response.migrations)).not.toContain("symbolic link");
  expect(existsSync(join(target, ".migrations"))).toBe(true);
});
