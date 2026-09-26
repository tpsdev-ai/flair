/**
 * federation-pair-local-access.test.ts — flair#820 (fails-first)
 *
 * On main, `flair federation pair` dumps Harper's raw AccessViolation
 * JSON when the identity GET 403s. The contract is a named error whose
 * message names the LOCAL side, the path, the missing role/grant, and
 * the pairing-role fix command (`flair init --remote` → flair_pair_initiator).
 *
 * The pair action itself calls api() + process.exit, so (same convention
 * as cli-federation-status-fetch.test.ts) the helpers are what we unit-test.
 * A source-text tripwire pins the action to the rewriter.
 *
 * Flint adjudication (comment 5699010330): `flair principal promote <id>`
 * is not an admin grant. The printed remedy is `flair principal add <id>
 * --admin`. resolveFlairInvocation must fail the promote string on arity
 * and pass the add string.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiHttpError } from "../../src/lib/auth-resolve.ts";
import { program } from "../../src/cli.ts";
import {
  ADMIN_AGENTS_ENV,
  FEDERATION_INSTANCE_PATH,
  FEDERATION_PAIR_HUB_ACCESS_ERROR_NAME,
  FEDERATION_PAIR_LOCAL_ACCESS_ERROR_NAME,
  PAIR_INITIATOR_FIX_COMMAND,
  PAIR_INITIATOR_ROLE,
  PRINCIPAL_ADD_ADMIN_COMMAND,
  FederationPairHubAccessError,
  FederationPairLocalAccessError,
  describeFederationPairHubAccessError,
  describeFederationPairLocalAccessError,
  isFederationInstanceAccessViolation,
  isFederationPairHubAccessDenial,
  principalAddAdminInvocation,
  rewriteFederationPairHubAccessError,
  rewriteFederationPairLocalAccessError,
} from "../../src/lib/federation-pair-access.ts";

const RAW_ACCESS_VIOLATION =
  '{"type":"error:AccessViolation","error":"forbidden","instance":"/FederationInstance"}';
const IDENTITY_URL = "http://localhost:9926";
const AGENT_ID = "agent-spoke-1";
const LYING_PROMOTE = `flair principal promote ${AGENT_ID}`;
const REAL_ADD_ADMIN = principalAddAdminInvocation(AGENT_ID);

function pairActionSource(): string {
  const src = readFileSync(join(import.meta.dir, "../../src/commands/federation.ts"), "utf8");
  const start = src.indexOf('.command("pair <hub-url>")');
  const end = src.indexOf('.command("token")', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function assertSharedLocalShape(msg: string): void {
  expect(msg).toContain("pair:");
  expect(msg).toContain("LOCAL");
  expect(msg).toContain(FEDERATION_INSTANCE_PATH);
  expect(msg).toContain("403");
  expect(msg).toContain("AccessViolation");
  expect(msg).toMatch(/role\/grant/i);
  expect(msg).toContain(ADMIN_AGENTS_ENV);
  expect(msg).toContain(PAIR_INITIATOR_FIX_COMMAND);
  expect(msg).toContain(PAIR_INITIATOR_ROLE);
  expect(msg).not.toContain("principal promote");
  expect(msg).not.toContain("<unknown>");
  expect(msg).not.toMatch(/^\s*\{\s*"type"\s*:\s*"error:AccessViolation"/);
}

describe("describeFederationPairLocalAccessError — message shape (flair#820)", () => {
  test("names LOCAL side, path, 403, missing role/grant, and principal add --admin", () => {
    const msg = describeFederationPairLocalAccessError({
      url: IDENTITY_URL,
      agentId: AGENT_ID,
    });
    assertSharedLocalShape(msg);
    expect(msg).toContain(`GET ${IDENTITY_URL}${FEDERATION_INSTANCE_PATH} → 403 AccessViolation`);
    expect(msg).toContain(`agent '${AGENT_ID}'`);
    expect(msg).toContain(REAL_ADD_ADMIN);
    expect(msg).toContain(`${PRINCIPAL_ADD_ADMIN_COMMAND} ${AGENT_ID} --admin`);
  });

  test("absent agent id tells the operator to set FLAIR_AGENT_ID — no <unknown>", () => {
    const msg = describeFederationPairLocalAccessError({ url: IDENTITY_URL });
    assertSharedLocalShape(msg);
    expect(msg).toContain("FLAIR_AGENT_ID");
    expect(msg).not.toContain(`${PRINCIPAL_ADD_ADMIN_COMMAND} <unknown>`);
    expect(msg).not.toContain("agent '<unknown>'");
  });
});

describe("rewriteFederationPairLocalAccessError", () => {
  test("wraps ApiHttpError 403 AccessViolation as the named error", () => {
    const raw = new ApiHttpError(403, RAW_ACCESS_VIOLATION);
    const rewritten = rewriteFederationPairLocalAccessError(raw, {
      url: IDENTITY_URL,
      agentId: AGENT_ID,
    });
    expect(rewritten).toBeInstanceOf(FederationPairLocalAccessError);
    expect((rewritten as Error).name).toBe(FEDERATION_PAIR_LOCAL_ACCESS_ERROR_NAME);
    assertSharedLocalShape((rewritten as Error).message);
    expect((rewritten as Error).message).toContain(REAL_ADD_ADMIN);
    expect((rewritten as FederationPairLocalAccessError).status).toBe(403);
    expect((rewritten as FederationPairLocalAccessError).side).toBe("LOCAL");
    expect((rewritten as FederationPairLocalAccessError).path).toBe(FEDERATION_INSTANCE_PATH);
  });

  test("wraps a bare AccessViolation message (no status field)", () => {
    const rewritten = rewriteFederationPairLocalAccessError(new Error(RAW_ACCESS_VIOLATION), {
      url: "http://127.0.0.1:19926",
      agentId: AGENT_ID,
    });
    expect(rewritten).toBeInstanceOf(FederationPairLocalAccessError);
    assertSharedLocalShape((rewritten as Error).message);
  });

  test("leaves connect failures and non-403 HTTP errors untouched", () => {
    const connect = new Error("fetch failed");
    const notFound = new ApiHttpError(404, "HTTP 404");
    expect(rewriteFederationPairLocalAccessError(connect, { url: IDENTITY_URL })).toBe(connect);
    expect(rewriteFederationPairLocalAccessError(notFound, { url: IDENTITY_URL })).toBe(notFound);
    expect(isFederationInstanceAccessViolation(connect)).toBe(false);
    expect(isFederationInstanceAccessViolation(notFound)).toBe(false);
  });

  test("does not rewrite no-credentials or rejected-password 403s as missing admin", () => {
    const noCreds = new ApiHttpError(403, "HTTP 403: no credentials sent. Set FLAIR_ADMIN_PASS.", true);
    const rejected = new ApiHttpError(403, "HTTP 403: invalid password");
    expect(isFederationInstanceAccessViolation(noCreds)).toBe(false);
    expect(isFederationInstanceAccessViolation(rejected)).toBe(false);
    expect(rewriteFederationPairLocalAccessError(noCreds, { url: IDENTITY_URL })).toBe(noCreds);
    expect(rewriteFederationPairLocalAccessError(rejected, { url: IDENTITY_URL })).toBe(rejected);
  });
});

describe("hub pairing-role denial — init --remote fix command", () => {
  test("hub message names flair_pair_initiator and flair init --remote", () => {
    const msg = describeFederationPairHubAccessError({
      hubUrl: "https://hub.example:19926",
      status: 400,
    });
    expect(msg).toContain("pair:");
    expect(msg).toContain("HUB");
    expect(msg).toContain("/FederationPair");
    expect(msg).toContain("400");
    expect(msg).toMatch(/role\/grant/i);
    expect(msg).toContain(PAIR_INITIATOR_ROLE);
    expect(msg).toContain(PAIR_INITIATOR_FIX_COMMAND);
  });

  test("rewrites only when the body names the pairing role — not every 403", () => {
    expect(rewriteFederationPairHubAccessError(
      403,
      "https://hub.example:19926",
      RAW_ACCESS_VIOLATION,
    )).toBeNull();
    expect(isFederationPairHubAccessDenial(403, RAW_ACCESS_VIOLATION)).toBe(false);
    expect(isFederationPairHubAccessDenial(403, "forbidden")).toBe(false);
    expect(isFederationPairHubAccessDenial(401, "invalid_or_expired_pairing_token")).toBe(false);
    const named = rewriteFederationPairHubAccessError(
      400,
      "https://hub.example:19926",
      "role not found: flair_pair_initiator",
    );
    expect(named).toBeInstanceOf(FederationPairHubAccessError);
    expect(named?.name).toBe(FEDERATION_PAIR_HUB_ACCESS_ERROR_NAME);
    expect(isFederationPairHubAccessDenial(400, "role not found: flair_pair_initiator")).toBe(true);
  });
});

describe("wiring — pair identity GET uses the named rewriter", () => {
  test("LOCAL rewriter is scoped to the identity GET only (Flint #820)", () => {
    const pairSrc = pairActionSource();
    const getIdx = pairSrc.indexOf('api("GET", "/FederationInstance"');
    const localRewriteIdx = pairSrc.indexOf("rewriteFederationPairLocalAccessError");
    const hubRewriteIdx = pairSrc.indexOf("rewriteFederationPairHubAccessError");
    const secretKeyIdx = pairSrc.indexOf("loadInstanceSecretKey");
    const hubPostIdx = pairSrc.indexOf("/FederationPair");
    expect(getIdx).toBeGreaterThan(-1);
    expect(localRewriteIdx).toBeGreaterThan(getIdx);
    expect(localRewriteIdx).toBeLessThan(secretKeyIdx);
    expect(hubRewriteIdx).toBeGreaterThan(secretKeyIdx);
    expect(hubPostIdx).toBeGreaterThan(secretKeyIdx);
    expect(pairSrc.split("rewriteFederationPairLocalAccessError").length - 1).toBe(1);
    expect(pairSrc).toContain("identityUrl");
    // The GET is pinned to identityUrl. flair#1873 rides the resolved admin
    // credential along with it, so the object is no longer the single-field
    // literal this line used to assert verbatim.
    expect(pairSrc).toContain("baseUrl: identityUrl");
    expect(pairSrc).toContain("explicitAdminPass: opts.adminPass");
    expect(pairSrc).toContain("url: redactUrl(identityUrl)");
  });
});

/**
 * PLAN ACCEPTED / Flint adjudication: every remedy the new errors name
 * must be invocable as printed. Flags alone are not enough — required
 * positionals (commander registeredArguments / _args) must be satisfied
 * by non-flag tokens.
 */
function findCommand(root: { commands: readonly { name: () => string }[] }, path: string[]): any {
  let node: any = root;
  for (const name of path) {
    node = node.commands.find((c: any) => c.name() === name);
    if (!node) return null;
  }
  return node;
}

function backtickSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

function requiredPositionals(cmd: any): { name: string; required: boolean }[] {
  const raw = cmd?.registeredArguments ?? cmd?._args ?? [];
  return [...raw].map((a: any) => ({
    name: typeof a.name === "function" ? a.name() : String(a._name ?? a.name ?? ""),
    required: a.required === true,
  }));
}

type InvocationResolution = { ok: true } | { ok: false; reason: string };

function resolveFlairInvocation(invocation: string): InvocationResolution {
  if (!invocation.startsWith("flair ")) {
    return { ok: false, reason: `${invocation} is not a flair invocation` };
  }
  const tokens = invocation.slice("flair ".length).trim().split(/\s+/);
  let node: any = program;
  let i = 0;
  while (i < tokens.length && !tokens[i].startsWith("-")) {
    const next = node.commands?.find((c: any) => c.name() === tokens[i]);
    if (!next) break;
    node = next;
    i++;
  }
  if (node === program || typeof node?.name !== "function") {
    return { ok: false, reason: `${invocation} walked no command` };
  }
  const remaining = tokens.slice(i);
  const flags = remaining.filter((t) => t.startsWith("-")).map((t) => t.split("=")[0]);
  const positionals = remaining.filter((t) => !t.startsWith("-"));
  const longs = (node.options ?? []).map((o: any) => o.long);
  for (const flag of flags) {
    if (!longs.includes(flag)) {
      return { ok: false, reason: `${invocation} names missing flag ${flag} on \`${node.name()}\`` };
    }
  }
  const required = requiredPositionals(node).filter((a) => a.required);
  if (positionals.length < required.length) {
    return {
      ok: false,
      reason:
        `${invocation} is not invocable: \`${node.name()}\` needs ` +
        `${required.length} required positional(s) [${required.map((a) => a.name).join(", ")}], ` +
        `got ${positionals.length}`,
    };
  }
  return { ok: true };
}

describe("pair-access remedies resolve against CLI / docs (PLAN ACCEPTED #820)", () => {
  const localMsg = describeFederationPairLocalAccessError({
    url: IDENTITY_URL,
    agentId: AGENT_ID,
  });
  const hubMsg = describeFederationPairHubAccessError({
    hubUrl: "https://hub.example:19926",
    status: 400,
  });
  const named = `${localMsg}\n${hubMsg}`;

  test("arity: promote <id> FAILS; principal add <id> --admin PASSES", () => {
    const lying = resolveFlairInvocation(LYING_PROMOTE);
    const real = resolveFlairInvocation(REAL_ADD_ADMIN);
    expect(lying.ok, `expected ${LYING_PROMOTE} to fail arity`).toBe(false);
    expect(real.ok, `expected ${REAL_ADD_ADMIN} to pass`).toBe(true);
  });

  test("messages still name the accepted remedies", () => {
    expect(named).toContain(ADMIN_AGENTS_ENV);
    expect(named).toContain(PRINCIPAL_ADD_ADMIN_COMMAND);
    expect(named).toContain("--admin");
    expect(named).toContain(PAIR_INITIATOR_FIX_COMMAND);
    expect(named).toContain(PAIR_INITIATOR_ROLE);
    expect(named).not.toContain("principal promote");
  });

  test("every backtick flair invocation is invocable as printed", () => {
    const invocations = backtickSpans(named).filter((span) => span.startsWith("flair "));
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations).toContain(REAL_ADD_ADMIN);
    expect(invocations).toContain(PAIR_INITIATOR_FIX_COMMAND);
    for (const invocation of invocations) {
      const resolved = resolveFlairInvocation(invocation);
      expect(resolved.ok, resolved.ok ? invocation : `${invocation}: ${resolved.reason}`).toBe(true);
    }
  });

  test("FLAIR_ADMIN_AGENTS is a current server-process env surface", () => {
    const example = readFileSync(join(import.meta.dir, "../../.env.example"), "utf8");
    const reader = readFileSync(join(import.meta.dir, "../../resources/agent-auth.ts"), "utf8");
    expect(example).toContain(ADMIN_AGENTS_ENV);
    expect(example).toMatch(new RegExp(`${ADMIN_AGENTS_ENV}=agent-a,agent-b flair start`));
    expect(reader).toContain(`process.env.${ADMIN_AGENTS_ENV}`);
  });

  test("flair principal add --admin is the admin-grant surface in principal.ts", () => {
    const add = findCommand(program, ["principal", "add"]);
    expect(add, "missing `flair principal add`").not.toBeNull();
    expect(add.name()).toBe("add");
    const required = requiredPositionals(add).filter((a) => a.required).map((a) => a.name);
    expect(required).toEqual(["id"]);
    const longs = add.options.map((o: any) => o.long);
    expect(longs).toContain("--admin");
    const src = readFileSync(join(import.meta.dir, "../../src/commands/principal.ts"), "utf8");
    expect(src).toContain('.command("add <id>")');
    expect(src).toContain('.option("--admin"');
    expect(src).toContain("role: isAdmin ? ADMIN_ROLE");
    expect(src).toContain("admin: isAdmin");
  });

  test("flair init --remote exists; flair_pair_initiator is the auth-middleware pairing role", () => {
    const init = findCommand(program, ["init"]);
    expect(init, "missing `flair init`").not.toBeNull();
    const longs = init.options.map((o: any) => o.long);
    expect(longs).toContain("--remote");
    const initSrc = readFileSync(join(import.meta.dir, "../../src/commands/init.ts"), "utf8");
    expect(initSrc).toContain("if (opts.remote)");
    expect(initSrc).toContain("ensureFlairPairInitiatorRole");
    const gate = readFileSync(join(import.meta.dir, "../../resources/auth-middleware.ts"), "utf8");
    expect(gate).toContain(PAIR_INITIATOR_ROLE);
    expect(gate).toContain(`pairUser?.role?.role === "${PAIR_INITIATOR_ROLE}"`);
  });
});
