/**
 * #2825 — the built node's tool schema through a real host @langchain/core.
 *
 * The package unit tests build the LangChain tool from source and call `func`
 * directly, so they never exercise the host's schema parsing. This file packs
 * the BUILT node and installs it, with `@langchain/core` and `n8n-workflow`,
 * into a scratch prefix outside the workspace: no root `overrides`, so
 * n8n-workflow keeps the zod 3 it declares and the node keeps its zod 4.
 *
 * The install follows the Dependency Audit job's consumer install in
 * `.github/workflows/test.yml`: `npm pack` the workspace tarballs, `npm init`
 * in a mktemp prefix, then `npm install --ignore-scripts --omit=dev
 * --legacy-peer-deps`. The runner has registry access, as that job does, so no
 * fixture registry is involved; the node is installed as a host would install
 * it, and the parser is the host's.
 *
 * The driver loads `dist/nodes/FlairSearch/FlairSearch.node.js` from the
 * installed tarball, calls `supplyData`, then `tool.invoke(input)` — the path
 * an agent run takes. A local HTTP stub records whether the node's `func` ran.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(300_000);

const PACKAGE_DIR = join(import.meta.dir, "..");
const WORKSPACE_ROOT = join(PACKAGE_DIR, "..", "..");
const CLIENT_DIR = join(WORKSPACE_ROOT, "packages", "flair-client");
const N8N_WORKFLOW_VERSION = "1.119.0";
/** The host parser versions this release was measured against. */
const CORE_VERSIONS = (
  process.env.FLAIR_N8N_HOST_CORE_VERSIONS ?? "0.3.0,0.3.57,0.3.68,1.1.0,1.3.0"
)
  .split(",")
  .map((version) => version.trim())
  .filter(Boolean);

const BUILD_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 180_000;
const INVOKE_TIMEOUT_MS = 30_000;

let scratch = "";
let clientTarball = "";
let nodeTarball = "";
const hostPrefixes = new Map<string, string>();

/** A host prefix's npm must not inherit the workspace's npm state. */
function hostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HOME = join(scratch, "home");
  env.npm_config_cache = join(scratch, "npm-cache");
  env.npm_config_userconfig = join(scratch, "npmrc");
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  return env;
}

function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, {
    cwd,
    env: hostEnv(),
    encoding: "utf8",
    timeout,
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

/** The driver runs inside the host prefix so its requires resolve the host's tree. */
const DRIVER = [
  'const http = require("node:http");',
  'const coreVersion = require("@langchain/core/package.json").version;',
  'const { FlairSearch } = require("@tpsdev-ai/n8n-nodes-flair/dist/nodes/FlairSearch/FlairSearch.node.js");',
  "",
  "const hits = [];",
  "const server = http.createServer((req, res) => {",
  '  let body = "";',
  '  req.on("data", (chunk) => (body += chunk));',
  '  req.on("end", () => {',
  "    hits.push({ method: req.method, url: req.url, body });",
  '    res.writeHead(200, { "content-type": "application/json" });',
  '    res.end(JSON.stringify({ results: [{ id: "memory-a", content: "stub-memory", score: 0.9 }] }));',
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
  '    getNodeParameter: (name, _itemIndex, fallback) =>',
  '      name === "operation" ? "search" : name === "limit" ? (fallback ?? 5) : undefined,',
  "    logger: { warn() {} },",
  "  };",
  "  const output = { coreVersion, ok: false, hits };",
  "  try {",
  "    const node = new FlairSearch();",
  "    const tool = (await node.supplyData.call(context, 0)).response;",
  "    output.out = await tool.invoke(JSON.parse(process.argv[2]));",
  "    output.ok = true;",
  "  } catch (error) {",
  "    output.name = error && error.name;",
  "    output.error = error && error.message;",
  "  } finally {",
  "    server.close();",
  '    console.log("HOST_PARSER_RESULT " + JSON.stringify(output));',
  "  }",
  "});",
].join("\n");

interface DriverResult {
  coreVersion: string;
  ok: boolean;
  out?: unknown;
  name?: string;
  error?: string;
  hits: Array<{ method: string; url: string; body: string }>;
}

function invoke(prefix: string, input: Record<string, unknown>): DriverResult {
  const stdout = run("node", ["driver.cjs", JSON.stringify(input)], prefix, INVOKE_TIMEOUT_MS);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("HOST_PARSER_RESULT "));
  if (!line) throw new Error(`driver printed no result:\n${stdout}`);
  return JSON.parse(line.slice("HOST_PARSER_RESULT ".length)) as DriverResult;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "flair-n8n-host-parser-"));
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

  for (const version of CORE_VERSIONS) {
    const prefix = join(scratch, `host-${version}`);
    mkdirSync(prefix);
    run("npm", ["init", "-y"], prefix, INSTALL_TIMEOUT_MS);
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--legacy-peer-deps",
        clientTarball,
        nodeTarball,
        `@langchain/core@${version}`,
        `n8n-workflow@${N8N_WORKFLOW_VERSION}`,
      ],
      prefix,
      INSTALL_TIMEOUT_MS,
    );
    writeFileSync(join(prefix, "driver.cjs"), DRIVER);
    hostPrefixes.set(version, prefix);
  }
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the built FlairSearch tool through a real host @langchain/core parser", () => {
  for (const version of CORE_VERSIONS) {
    test(
      `@langchain/core ${version}: a { query } string reaches the node`,
      () => {
        const accepted = invoke(hostPrefixes.get(version)!, { query: "needle" });
        expect(accepted.coreVersion).toBe(version);
        expect(accepted.ok).toBe(true);
        expect(accepted.hits).toHaveLength(1);
        expect(accepted.hits[0]?.url).toBe("/SemanticSearch");
        expect(JSON.parse(accepted.hits[0]!.body).q).toBe("needle");
        expect(String(accepted.out)).toContain("stub-memory");
      },
      240_000,
    );

    test(
      `@langchain/core ${version}: a non-string query is rejected by the host parser`,
      () => {
        const rejected = invoke(hostPrefixes.get(version)!, { query: 42 });
        expect(rejected.coreVersion).toBe(version);
        expect(rejected.ok).toBe(false);
        expect(rejected.error).toMatch(/did not match expected schema/i);
        expect(rejected.hits).toHaveLength(0);
      },
      60_000,
    );
  }
});
