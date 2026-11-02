/**
 * #2864 — FlairChatMemory through a real host @langchain/classic and @langchain/core.
 *
 * FlairChatMemory imports BufferWindowMemory from @langchain/classic/memory, so
 * the host must provide a @langchain/classic whose own @langchain/core peer the
 * host's core satisfies. This packs the built node and installs both packages
 * into a scratch prefix, without --legacy-peer-deps, at the declared floor and
 * at a current release. The pack and isolated-install harness follows
 * host-parser.test.ts (pack at lines 180-208, install at 214-228, host env at
 * 79-90); this file reuses that harness and changes the installed versions and
 * the node it drives.
 *
 * The driver constructs the node's memory through supplyData and runs the two
 * calls n8n makes on a Memory port: n8n's saveToMemory calls
 * memory.saveContext({ input }, { output }) and its loadMemory calls
 * memory.loadMemoryVariables({}) (n8n's
 * packages/@n8n/nodes-langchain/utils/agent-execution/memoryManagement.ts:243-250
 * and :297-307). The Flair endpoint is a local HTTP stub.
 *
 * Pairs: floor @langchain/classic 1.0.0 with @langchain/core 1.0.0, and current
 * @langchain/classic 1.0.55 (published 2026-10-22, the newest release at least
 * seven days old on 2026-11-02) with @langchain/core 1.3.0 (published
 * 2026-10-22, likewise). Each classic release's @langchain/core peer range is
 * what the pair satisfies: 1.0.0 wants ^1.0.0, 1.0.55 wants ^1.3.0.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_DIR = join(import.meta.dir, "..");
const WORKSPACE_ROOT = join(PACKAGE_DIR, "..", "..");
const CLIENT_DIR = join(WORKSPACE_ROOT, "packages", "flair-client");
const N8N_WORKFLOW_VERSION = "1.119.0";

interface VersionPair {
  classic: string;
  core: string;
}

const PAIRS: VersionPair[] = [
  { classic: "1.0.0", core: "1.0.0" },
  { classic: "1.0.55", core: "1.3.0" },
];

// Same child bounds as host-parser.test.ts. The floor install measured 12 s on
// 2026-11-02; 60 s is five times that.
const BUILD_TIMEOUT_MS = 20_000;
const INIT_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 60_000;
const INVOKE_TIMEOUT_MS = 30_000;
// This file's setup hook runs the build, two packs, and two init + install
// children: 20 + 2 x 20 + 2 x (10 + 60) = 200 s.
const SETUP_TIMEOUT_MS = 240_000;
setDefaultTimeout(SETUP_TIMEOUT_MS);

let scratch = "";
let clientTarball = "";
let nodeTarball = "";
const hostPrefixes = new Map<string, string>();

/** Remove inherited npm state; mirror host-parser.test.ts:79-90. */
function hostEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^npm_config_/i.test(name)) delete env[name];
  }
  env.HOME = join(scratch, "home");
  env.npm_config_cache = join(scratch, "npm-cache");
  env.npm_config_userconfig = join(scratch, "npmrc");
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  return { ...env, ...overrides };
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv = hostEnv(),
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    // SIGKILL, not the default SIGTERM: spawnSync waits for the child to exit.
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd} (status ${result.status}): ` +
        `${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/**
 * The driver runs inside the host prefix so its requires resolve the host's
 * tree. It records the Flair requests the memory makes: two PUTs for
 * saveContext (one human, one AI message) and one GET for
 * loadMemoryVariables.
 */
const DRIVER = [
  'const http = require("node:http");',
  'const classicVersion = require("@langchain/classic/package.json").version;',
  'const coreVersion = require("@langchain/core/package.json").version;',
  'const { FlairChatMemory } = require("@tpsdev-ai/n8n-nodes-flair/dist/nodes/FlairChatMemory/FlairChatMemory.node.js");',
  "",
  "const rows = [];",
  "const hits = [];",
  "const server = http.createServer((req, res) => {",
  '  let body = "";',
  '  req.on("data", (chunk) => (body += chunk));',
  '  req.on("end", () => {',
  "    hits.push({",
  "      method: req.method,",
  "      url: req.url,",
  '      auth: req.headers.authorization ? "present" : "absent",',
  "      body,",
  "    });",
  '    if (req.method === "PUT" && req.url.startsWith("/Memory/")) {',
  "      const record = JSON.parse(body);",
  "      rows.push(record);",
  '      res.writeHead(200, { "content-type": "application/json" });',
  '      res.end(JSON.stringify({ ...record, written: true }));',
  "      return;",
  "    }",
  '    if (req.method === "GET" && req.url.startsWith("/Memory")) {',
  '      res.writeHead(200, { "content-type": "application/json" });',
  "      res.end(JSON.stringify(rows));",
  "      return;",
  "    }",
  '    res.writeHead(404, { "content-type": "application/json" });',
  '    res.end(JSON.stringify({ error: "not found" }));',
  "  });",
  "});",
  "",
  'server.listen(0, "127.0.0.1", async () => {',
  "  const port = server.address().port;",
  "  const context = {",
  "    getCredentials: async () => ({",
  '      baseUrl: "http://127.0.0.1:" + port,',
  '      agentId: "agent-a",',
  '      adminPassword: "host-fixture-password",',
  "    }),",
  "    getNodeParameter: (name, _itemIndex, fallback) =>",
  '      name === "subject"',
  '        ? "workflow-a"',
  '        : name === "sessionKey"',
  '          ? ""',
  '          : name === "contextWindowLength"',
  "            ? 10",
  "            : fallback,",
  "    logger: { warn() {} },",
  "  };",
  "  const output = { classicVersion, coreVersion, ok: false, hits };",
  "  try {",
  "    const node = new FlairChatMemory();",
  "    const memory = (await node.supplyData.call(context, 0)).response;",
  "    output.memoryClass = memory.constructor.name;",
  '    await memory.saveContext({ input: "hello from user" }, { output: "hello from ai" });',
  '    const loaded = await memory.loadMemoryVariables({});',
  "    output.loadedKeys = Object.keys(loaded);",
  "    output.messages = (loaded.chat_history || []).map((message) => ({",
  "      type: message._getType(),",
  "      content: message.content,",
  "    }));",
  "    output.ok = true;",
  "  } catch (error) {",
  "    output.name = error && error.name;",
  "    output.error = error && error.message;",
  "  } finally {",
  "    server.close();",
  '    console.log("CHAT_MEMORY_RESULT " + JSON.stringify(output));',
  "  }",
  "});",
].join("\n");

interface DriverResult {
  classicVersion: string;
  coreVersion: string;
  ok: boolean;
  memoryClass?: string;
  loadedKeys?: string[];
  messages?: Array<{ type: string; content: string }>;
  name?: string;
  error?: string;
  hits: Array<{ method: string; url: string; auth: string; body: string }>;
}

function invoke(prefix: string): DriverResult {
  const stdout = run("node", ["driver.cjs"], prefix, INVOKE_TIMEOUT_MS);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("CHAT_MEMORY_RESULT "));
  if (!line) throw new Error(`driver printed no result:\n${stdout}`);
  return JSON.parse(line.slice("CHAT_MEMORY_RESULT ".length)) as DriverResult;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "flair-n8n-chat-memory-"));
  mkdirSync(join(scratch, "home"));
  mkdirSync(join(scratch, "packed"));

  // The test loads the built node, not src. The shared unit lane builds
  // flair-client before package tests; this build makes the node's dist.
  run("bun", ["run", "build"], PACKAGE_DIR, BUILD_TIMEOUT_MS);

  run(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", join(scratch, "packed")],
    CLIENT_DIR,
    BUILD_TIMEOUT_MS,
  );
  run(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", join(scratch, "packed")],
    PACKAGE_DIR,
    BUILD_TIMEOUT_MS,
  );
  const tarballs = readdirSync(join(scratch, "packed")).filter((name) => name.endsWith(".tgz"));
  const client = tarballs.filter((name) => name.startsWith("tpsdev-ai-flair-client-"));
  const node = tarballs.filter((name) => name.startsWith("tpsdev-ai-n8n-nodes-flair-"));
  if (client.length !== 1 || node.length !== 1) {
    throw new Error(`expected one client and one node tarball, found: ${tarballs.join(", ")}`);
  }
  clientTarball = join(scratch, "packed", client[0]);
  nodeTarball = join(scratch, "packed", node[0]);

  for (const pair of PAIRS) {
    const prefix = join(scratch, `host-classic-${pair.classic}-core-${pair.core}`);
    mkdirSync(prefix);
    run("npm", ["init", "-y"], prefix, INIT_TIMEOUT_MS);
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--omit=dev",
        clientTarball,
        nodeTarball,
        `@langchain/classic@${pair.classic}`,
        `@langchain/core@${pair.core}`,
        `n8n-workflow@${N8N_WORKFLOW_VERSION}`,
      ],
      prefix,
      INSTALL_TIMEOUT_MS,
    );
    writeFileSync(join(prefix, "driver.cjs"), DRIVER);
    hostPrefixes.set(`${pair.classic}+${pair.core}`, prefix);
  }
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the built FlairChatMemory through a real host @langchain/classic", () => {
  for (const pair of PAIRS) {
    test(
      `@langchain/classic ${pair.classic} + @langchain/core ${pair.core}: saveContext writes a turn and loadMemoryVariables reads it back`,
      () => {
        const result = invoke(hostPrefixes.get(`${pair.classic}+${pair.core}`)!);
        expect(result.classicVersion).toBe(pair.classic);
        expect(result.coreVersion).toBe(pair.core);
        expect(result.ok).toBe(true);
        expect(result.memoryClass).toBe("BufferWindowMemory");

        // One GET for loadMemoryVariables after the two PUTs for saveContext.
        expect(result.hits.map((hit) => hit.method)).toEqual(["PUT", "PUT", "GET"]);
        expect(result.hits[0]!.url).toMatch(/^\/Memory\/agent-a-/);
        expect(result.hits[1]!.url).toMatch(/^\/Memory\/agent-a-/);
        expect(result.hits[2]!.url).toBe("/Memory?agentId=agent-a");
        for (const hit of result.hits) expect(hit.auth).toBe("present");

        const [humanRow, aiRow] = result.hits.slice(0, 2).map((hit) => JSON.parse(hit.body));
        expect(humanRow).toMatchObject({
          agentId: "agent-a",
          subject: "workflow-a",
          type: "session",
          durability: "ephemeral",
          tags: ["n8n-chat", "role:human"],
        });
        expect(aiRow).toMatchObject({
          agentId: "agent-a",
          subject: "workflow-a",
          type: "session",
          durability: "ephemeral",
          tags: ["n8n-chat", "role:ai"],
        });
        expect(JSON.parse(humanRow.content)).toMatchObject({
          type: "human",
          data: { content: "hello from user" },
        });
        expect(JSON.parse(aiRow.content)).toMatchObject({
          type: "ai",
          data: { content: "hello from ai" },
        });

        expect(result.loadedKeys).toEqual(["chat_history"]);
        expect(result.messages).toEqual([
          { type: "human", content: "hello from user" },
          { type: "ai", content: "hello from ai" },
        ]);
      },
      120_000,
    );
  }
});
