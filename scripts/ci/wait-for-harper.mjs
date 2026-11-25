// wait-for-harper.mjs — wait for a Docker-hosted Harper to answer /Health.
//
// The CI E2E lane starts Harper inside a container and polls /Health. This
// waiter polls against one elapsed-time budget, taken once in milliseconds.
// Each poll's probe and first inspect get the smaller of the per-request cap
// and the time left; the final inspect gets the per-request cap. The waiter
// checks the budget after the first inspect, before the probe, and after the
// final inspect, before it reports ready, and kills each docker child with
// SIGKILL at its bound. The failure diagnostic is bounded separately: ten
// seconds for the container logs plus one per-request cap.
//
// Each poll inspects the container before it believes /Health, and inspects
// once more before it reports ready. A dead container detected before the
// deadline stops polling; the waiter prints the exit code and attempts
// `docker logs`, reporting a logs error if that fails. An inspect that reports
// not running after the deadline ends the wait as a timeout.
//
// Usage:
//   node wait-for-harper.mjs --container <name> --url <health-url>
//     [--credentials-env <NAME>] [--budget-seconds <n>]
//     [--poll-interval-ms <n>] [--progress-interval-ms <n>]
//     [--per-request-ms <n>]
//
//   --credentials-env names an environment variable holding `user:pass`. The
//   value is read in this process, sent as a request header, and redacted from
//   Docker output, Docker errors and diagnostic response headers in its raw,
//   Base64 token, full header and password-component forms. That named variable is omitted from the waiter's Docker children.
//   --budget-seconds bounds the polling; it defaults to
//   $HARPER_START_BUDGET_S, then 300.
//
// Exit status: 0 when a /Health probe answers with a 2xx status and the final
// inspect finds the container running before the deadline, 1 on failure,
// 2 on bad usage.

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
const MAX_BUDGET_SECONDS = 24 * 60 * 60;
const MAX_TIMER_MS = 2147483647;
const CREDENTIALS_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Resolve the budget: the flag, else the environment, else 300 seconds. */
export function resolveBudget(flagValue, envValue) {
  const raw = flagValue !== undefined ? flagValue : envValue?.trim() || String(DEFAULT_BUDGET_S);
  const seconds = Number(raw);
  if (
    !/^[0-9]+$/.test(raw) ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > MAX_BUDGET_SECONDS
  ) {
    throw new Error(`budget must be a positive whole number of seconds at most ${MAX_BUDGET_SECONDS}, got '${raw}'`);
  }
  return seconds;
}

/** The named credential variable, omitted from the waiter's Docker children. */
function childEnvironment(credentialsEnv) {
  const env = { ...process.env };
  if (credentialsEnv !== undefined) delete env[credentialsEnv];
  return env;
}

/** Remove a credential's value from text before it is printed. */
function redact(text, secrets) {
  let result = String(text);
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result;
}

/**
 * Validate the health URL: absolute http or https, with no username or password.
 * Node's http.request can turn nonempty URL credentials into a Basic header by
 * itself, so such a URL would send credentials the caller did not name.
 */
function healthUrl(text) {
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("--url must be an absolute http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--url must be an absolute http or https URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("--url must not carry credentials; name the variable with --credentials-env");
  }
  return text;
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
    url: healthUrl(url),
    credentialsEnv,
    budgetSeconds: resolveBudget(budget, env.HARPER_START_BUDGET_S),
    pollIntervalMs: poll === undefined ? DEFAULT_POLL_INTERVAL_MS : positiveInteger("--poll-interval-ms", poll),
    progressIntervalMs:
      progress === undefined ? DEFAULT_PROGRESS_INTERVAL_MS : positiveInteger("--progress-interval-ms", progress),
    perRequestMs: perRequestLimit(perRequest),
  };
}

/** A per-request cap must fit Node's timer range; above it Node fires in 1 ms. */
function perRequestLimit(value) {
  if (value === undefined) return DEFAULT_PER_REQUEST_MS;
  const milliseconds = positiveInteger("--per-request-ms", value);
  if (milliseconds > MAX_TIMER_MS) {
    throw new Error(`--per-request-ms must be at most ${MAX_TIMER_MS}, got '${value}'`);
  }
  return milliseconds;
}

function errorText(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || String(error);
}

/** Inspect the container's state; stdout only, so a warning on stderr is not state. */
async function inspectContainer(container, timeoutMs, env) {
  const { stdout } = await execFileAsync(
    "docker",
    ["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", container],
    {
      env,
      timeout: Math.max(1, Math.floor(timeoutMs)),
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    },
  );
  const [running, exitCode] = String(stdout).trim().split(/\s+/);
  return { running: running === "true", exitCode: exitCode || "unknown" };
}

/** One GET with a hard deadline and no keep-alive socket; null when it errors or times out. */
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
      // Capture the status and headers, then close the response: a body that
      // never ends must not keep this process alive past the request's bound.
      const result = { status: response.statusCode ?? 0, headers: response.headers };
      response.destroy();
      settle(result);
    });
    timer = setTimeout(() => {
      req.destroy(new Error("request timed out"));
      settle(null);
    }, Math.max(1, timeoutMs));
    req.on("error", () => settle(null));
    req.end();
  });
}

/** The /Health response status, or null when no response arrived. */
async function probe(url, authorization, timeoutMs) {
  const response = await request(url, authorization ? { authorization } : {}, timeoutMs);
  return response === null ? null : response.status;
}

/**
 * On failure: container logs, then an unauthenticated request; its status and
 * headers are printed only when that request answers.
 */
async function diagnose({ container, url, perRequestMs, childEnv, secrets }) {
  console.error("Full logs:");
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["logs", container], {
      env: childEnv,
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
    if (String(stdout).trim()) console.error(redact(String(stdout).trimEnd(), secrets));
    if (String(stderr).trim()) console.error(redact(String(stderr).trimEnd(), secrets));
  } catch (error) {
    console.error(`docker logs failed: ${redact(errorText(error), secrets)}`);
  }
  console.error("---");
  console.error("Unauthenticated diagnostic request:");
  const response = await request(url, {}, perRequestMs);
  if (response === null) {
    console.error("request failed");
  } else {
    console.error(`status ${response.status}`);
    for (const [header, value] of Object.entries(response.headers)) {
      console.error(redact(`${header}: ${value}`, secrets));
    }
  }
}

export async function main(options) {
  const { container, url, credentialsEnv, budgetSeconds, pollIntervalMs, progressIntervalMs, perRequestMs } = options;

  let checkedUrl;
  try {
    checkedUrl = healthUrl(url);
  } catch (error) {
    console.error(`wait-for-harper: ${error.message}`);
    return 2;
  }

  let authorization;
  let secrets = [];
  if (credentialsEnv !== undefined) {
    if (!CREDENTIALS_ENV_NAME.test(credentialsEnv) || credentialsEnv.startsWith("NODE_")) {
      console.error(`wait-for-harper: credentials variable name '${credentialsEnv}' is not valid`);
      return 2;
    }
    const credential = process.env[credentialsEnv];
    if (!credential) {
      console.error(`wait-for-harper: credentials variable '${credentialsEnv}' is unset or empty`);
      return 2;
    }
    const token = Buffer.from(credential).toString("base64");
    authorization = `Basic ${token}`;
    secrets = [authorization, token, credential];
    const separator = credential.indexOf(":");
    if (separator !== -1) {
      const password = credential.slice(separator + 1);
      if (password) secrets.push(password);
    }
  }
  const childEnv = childEnvironment(credentialsEnv);

  const startedAt = performance.now();
  const deadline = startedAt + budgetSeconds * 1000;
  const remaining = () => deadline - performance.now();
  const elapsedMs = () => performance.now() - startedAt;

  const reportExited = async (exitCode) => {
    console.error(`Harper container '${container}' exited (exit code ${exitCode}) before Harper was ready`);
    await diagnose({ ...options, childEnv, secrets });
    return 1;
  };

  let lastProgressAt = 0;
  let lastHealthResult = "no response";
  for (;;) {
    if (remaining() <= 0) break;

    let state;
    try {
      state = await inspectContainer(container, Math.min(perRequestMs, remaining()), childEnv);
    } catch (error) {
      if (remaining() <= 0) break;
      console.error(`wait-for-harper: cannot inspect container '${container}': ${redact(errorText(error), secrets)}`);
      return 1;
    }
    if (remaining() <= 0) break;
    if (!state.running) return reportExited(state.exitCode);

    const status = await probe(checkedUrl, authorization, Math.min(perRequestMs, remaining()));
    lastHealthResult = status === null ? "no response" : String(status);
    if (status !== null && status >= 200 && status < 300) {
      if (remaining() <= 0) break;
      let finalState;
      try {
        finalState = await inspectContainer(container, perRequestMs, childEnv);
      } catch (error) {
        if (remaining() <= 0) break;
        console.error(`wait-for-harper: cannot inspect container '${container}': ${redact(errorText(error), secrets)}`);
        return 1;
      }
      if (remaining() <= 0) break;
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

  console.error(`Harper was not ready within ${budgetSeconds}s; last /Health result: ${lastHealthResult}`);
  await diagnose({ ...options, childEnv, secrets });
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
