// wait-for-harper.mjs — wait for a Docker-hosted Harper to answer /Health.
//
// The CI E2E lane starts Harper inside a container and polls /Health. This
// waiter works against one elapsed-time budget, taken once in milliseconds.
// The HTTP probe and the container inspect each get the smaller of their
// per-request cap and the time left, so the wait ends at the deadline even
// when a request stalls.
//
// Each poll inspects the container before it believes /Health, and inspects
// once more before it reports ready: a dead container behind a healthy port
// fails at once with its exit code and logs.
//
// Usage:
//   node wait-for-harper.mjs --container <name> --url <health-url>
//     [--credentials-env <NAME>] [--budget-seconds <n>]
//     [--poll-interval-ms <n>] [--progress-interval-ms <n>]
//     [--per-request-ms <n>]
//
//   --credentials-env names an environment variable holding `user:pass`. The
//   value is read in this process and sent only as an Authorization header.
//   --budget-seconds defaults to $HARPER_START_BUDGET_S, then 300.
//
// Exit status: 0 once /Health answers, 1 on failure, 2 on bad usage.

import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_BUDGET_S = 300;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;
const DEFAULT_PER_REQUEST_MS = 5000;
const CREDENTIALS_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Resolve the budget: the flag, else the environment, else 300 seconds. */
export function resolveBudget(flagValue, envValue) {
  const raw = flagValue !== undefined ? flagValue : envValue?.trim() || String(DEFAULT_BUDGET_S);
  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`budget must be a positive whole number of seconds, got '${raw}'`);
  }
  return Number(raw);
}

function positiveInteger(flag, value) {
  if (!/^[0-9]+$/.test(value) || Number(value) <= 0) {
    throw new Error(`${flag} must be a positive whole number, got '${value}'`);
  }
  return Number(value);
}

/** Parse the flags into the waiter's options. */
export function parseArgs(argv, env = process.env) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument '${arg}'`);
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      values.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg.slice(2), value);
    index += 1;
  }

  const take = (name) => {
    const value = values.get(name);
    values.delete(name);
    return value;
  };
  const name = take("container");
  const url = take("url");
  const credentialsEnv = take("credentials-env");
  const budget = take("budget-seconds");
  const poll = take("poll-interval-ms");
  const progress = take("progress-interval-ms");
  const perRequest = take("per-request-ms");
  if (values.size > 0) throw new Error(`unknown flag --${[...values.keys()][0]}`);
  if (!name) throw new Error("--container is required");
  if (!url) throw new Error("--url is required");

  return {
    container: name,
    url,
    credentialsEnv,
    budgetSeconds: resolveBudget(budget, env.HARPER_START_BUDGET_S),
    pollIntervalMs: poll === undefined ? DEFAULT_POLL_INTERVAL_MS : positiveInteger("--poll-interval-ms", poll),
    progressIntervalMs:
      progress === undefined ? DEFAULT_PROGRESS_INTERVAL_MS : positiveInteger("--progress-interval-ms", progress),
    perRequestMs: perRequest === undefined ? DEFAULT_PER_REQUEST_MS : positiveInteger("--per-request-ms", perRequest),
  };
}

function errorText(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || String(error);
}

/** Inspect the container's state; stdout only, so a warning on stderr is not state. */
async function inspectContainer(container, timeoutMs) {
  const { stdout } = await execFileAsync(
    "docker",
    ["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", container],
    { timeout: Math.max(1, timeoutMs), maxBuffer: 1024 * 1024, encoding: "utf8" },
  );
  const [running, exitCode] = String(stdout).trim().split(/\s+/);
  return { running: running === "true", exitCode: exitCode || "unknown" };
}

/** One GET with a hard deadline and no keep-alive socket; null on any failure. */
function request(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(target, { method: "GET", headers, agent: false }, (response) => {
      response.resume();
      settle({ status: response.statusCode ?? 0, headers: response.headers });
    });
    timer = setTimeout(() => {
      req.destroy(new Error("request timed out"));
      settle(null);
    }, Math.max(1, timeoutMs));
    req.on("error", () => settle(null));
    req.end();
  });
}

async function probe(url, authorization, timeoutMs) {
  const response = await request(url, authorization ? { authorization } : {}, timeoutMs);
  return response !== null && response.status >= 200 && response.status < 300;
}

/** On failure: container logs, then an unauthenticated request's status and headers. */
async function diagnose({ container, url, perRequestMs }) {
  console.error("Full logs:");
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["logs", container], {
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
    if (String(stdout).trim()) console.error(String(stdout).trimEnd());
    if (String(stderr).trim()) console.error(String(stderr).trimEnd());
  } catch (error) {
    console.error(`docker logs failed: ${errorText(error)}`);
  }
  console.error("---");
  console.error("Unauthenticated diagnostic request:");
  const response = await request(url, {}, perRequestMs);
  if (response === null) {
    console.error("request failed");
  } else {
    console.error(`status ${response.status}`);
    for (const [header, value] of Object.entries(response.headers)) {
      console.error(`${header}: ${value}`);
    }
  }
}

export async function main(options) {
  const { container, url, credentialsEnv, budgetSeconds, pollIntervalMs, progressIntervalMs, perRequestMs } = options;

  let authorization;
  if (credentialsEnv !== undefined) {
    if (!CREDENTIALS_ENV_NAME.test(credentialsEnv)) {
      console.error(`wait-for-harper: credentials variable name '${credentialsEnv}' is not valid`);
      return 2;
    }
    const credential = process.env[credentialsEnv];
    if (!credential) {
      console.error(`wait-for-harper: credentials variable '${credentialsEnv}' is unset or empty`);
      return 2;
    }
    authorization = `Basic ${Buffer.from(credential).toString("base64")}`;
  }

  const startedAt = Date.now();
  const deadline = startedAt + budgetSeconds * 1000;
  const remaining = () => deadline - Date.now();
  const elapsedMs = () => Date.now() - startedAt;

  const reportExited = async (exitCode) => {
    console.error(`Harper container '${container}' exited (exit code ${exitCode}) before ${url} answered`);
    await diagnose(options);
    return 1;
  };

  let lastProgressAt = 0;
  for (;;) {
    if (remaining() <= 0) break;

    let state;
    try {
      state = await inspectContainer(container, Math.min(perRequestMs, remaining()));
    } catch (error) {
      if (remaining() <= 0) break;
      console.error(`wait-for-harper: cannot inspect container '${container}': ${errorText(error)}`);
      return 1;
    }
    if (!state.running) return reportExited(state.exitCode);

    if (await probe(url, authorization, Math.min(perRequestMs, remaining()))) {
      let finalState;
      try {
        finalState = await inspectContainer(container, Math.min(perRequestMs, Math.max(1, remaining())));
      } catch (error) {
        if (remaining() <= 0) break;
        console.error(`wait-for-harper: cannot inspect container '${container}': ${errorText(error)}`);
        return 1;
      }
      if (!finalState.running) return reportExited(finalState.exitCode);
      console.log(`Harper ready after ${Math.floor(elapsedMs() / 1000)}s`);
      return 0;
    }

    if (elapsedMs() - lastProgressAt >= progressIntervalMs) {
      lastProgressAt = elapsedMs();
      console.log(`waiting for Harper /Health: ${Math.floor(lastProgressAt / 1000)}s`);
    }

    const sleepMs = Math.min(pollIntervalMs, remaining());
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  console.error(`Harper did not answer /Health within ${budgetSeconds}s`);
  await diagnose(options);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`wait-for-harper: ${error.message}`);
    console.error(
      "usage: wait-for-harper.mjs --container <name> --url <health-url> [--credentials-env <NAME>] [--budget-seconds <n>]",
    );
    process.exitCode = 2;
  }
  if (options) {
    main(options).then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(`wait-for-harper: ${error?.message ?? error}`);
        process.exitCode = 1;
      },
    );
  }
}
