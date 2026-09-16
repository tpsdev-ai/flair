/**
 * Spoke pair local-identity denial (flair#820).
 *
 * `flair federation pair` starts with a signed GET of /FederationInstance
 * (CLI tooling — peers never call this path during the handshake). That
 * resource is allowAdmin. When the invoking agent is not a runtime admin,
 * Harper returns a raw `error:AccessViolation` JSON body and pair printed
 * it unchanged — operators read a HUB auth failure and spent hours on
 * hub theories. The failing call is LOCAL.
 *
 * Named error + operator sentence live here so the contract can be
 * unit-tested without driving process.exit. Pair wraps only the identity
 * GET; later failures (token, hub POST, local Peer write) keep their
 * own messages unless the body is specifically a missing pairing role.
 */

export const FEDERATION_INSTANCE_PATH = "/FederationInstance";
export const FEDERATION_PAIR_LOCAL_ACCESS_ERROR_NAME = "FederationPairLocalAccessError";
export const FEDERATION_PAIR_HUB_ACCESS_ERROR_NAME = "FederationPairHubAccessError";
export const PAIR_INITIATOR_ROLE = "flair_pair_initiator";
export const PAIR_INITIATOR_FIX_COMMAND = "flair init --remote";
export const ADMIN_AGENTS_ENV = "FLAIR_ADMIN_AGENTS";
/** Real admin-grant surface: upserts `role: "admin"` + `admin: true`. */
export const PRINCIPAL_ADD_ADMIN_COMMAND = "flair principal add";

export type FederationPairAccessSide = "LOCAL" | "REMOTE";

export class FederationPairLocalAccessError extends Error {
  readonly status = 403;
  readonly side: FederationPairAccessSide;
  readonly path = FEDERATION_INSTANCE_PATH;
  constructor(message: string, side: FederationPairAccessSide = "LOCAL") {
    super(message);
    this.name = FEDERATION_PAIR_LOCAL_ACCESS_ERROR_NAME;
    this.side = side;
  }
}

export class FederationPairHubAccessError extends Error {
  readonly status: number;
  readonly side = "HUB" as const;
  constructor(message: string, status = 403) {
    super(message);
    this.name = FEDERATION_PAIR_HUB_ACCESS_ERROR_NAME;
    this.status = status;
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) {
    return String((err as { message?: unknown }).message ?? err);
  }
  return String(err);
}

function isNoCredentialsDenial(err: unknown): boolean {
  if (typeof err === "object" && err && "noCredentials" in err) {
    return (err as { noCredentials?: unknown }).noCredentials === true;
  }
  return /no credentials sent/i.test(errorText(err));
}

/**
 * True only for Harper's AccessViolation body (missing admin on an
 * authenticated call). Bare 403, no-credentials, and rejected-password
 * bodies stay out so their honest text is not replaced.
 */
export function isFederationInstanceAccessViolation(err: unknown): boolean {
  if (!err || isNoCredentialsDenial(err)) return false;
  return /AccessViolation/i.test(errorText(err));
}

export function principalAddAdminInvocation(agentId: string): string {
  return `${PRINCIPAL_ADD_ADMIN_COMMAND} ${agentId} --admin`;
}

export function describeFederationPairLocalAccessError(opts: {
  url: string;
  side?: FederationPairAccessSide;
  agentId?: string | null;
}): string {
  const side = opts.side ?? "LOCAL";
  const base = opts.url.replace(/\/$/, "");
  const agent = opts.agentId?.trim() ?? "";
  const identity =
    `pair: cannot read ${side} instance identity ` +
    `(GET ${base}${FEDERATION_INSTANCE_PATH} → 403 AccessViolation). `;
  const hubRole =
    `Hub pairing role: if pairing later fails because the hub is missing ` +
    `${PAIR_INITIATOR_ROLE}, restore it with \`${PAIR_INITIATOR_FIX_COMMAND}\`.`;
  if (!agent) {
    return (
      identity +
      `Missing role/grant: the calling agent is not a runtime admin ` +
      `(${FEDERATION_INSTANCE_PATH} is allowAdmin). ` +
      `Fix: add the agent to ${ADMIN_AGENTS_ENV} in the SERVER process env ` +
      `(not just .env). Set FLAIR_AGENT_ID so the grant can name the principal. ` +
      hubRole
    );
  }
  return (
    identity +
    `Missing role/grant: agent '${agent}' is not a runtime admin ` +
    `(${FEDERATION_INSTANCE_PATH} is allowAdmin). ` +
    `Fix: add '${agent}' to ${ADMIN_AGENTS_ENV} in the SERVER process env ` +
    `(not just .env), or grant the admin role with \`${principalAddAdminInvocation(agent)}\`. ` +
    hubRole
  );
}

export function rewriteFederationPairLocalAccessError(
  err: unknown,
  opts: { url: string; side?: FederationPairAccessSide; agentId?: string | null },
): unknown {
  if (!isFederationInstanceAccessViolation(err)) return err;
  return new FederationPairLocalAccessError(
    describeFederationPairLocalAccessError(opts),
    opts.side ?? "LOCAL",
  );
}

/**
 * Hub POST /FederationPair is a pairing-role problem only when the body
 * names `flair_pair_initiator` or a role-not-found. A bare 403 (proxy,
 * wrong host, rejected bootstrap password) keeps its own text.
 */
export function isFederationPairHubAccessDenial(_status: number, body: string): boolean {
  return /role[- ]?not[- ]?found|flair_pair_initiator/i.test(body);
}

export function describeFederationPairHubAccessError(opts: {
  hubUrl: string;
  status: number;
}): string {
  const hub = opts.hubUrl.replace(/\/$/, "");
  return (
    `pair: HUB rejected the pairing request ` +
    `(POST ${hub}/FederationPair → ${opts.status}). ` +
    `Missing role/grant: the hub may lack ${PAIR_INITIATOR_ROLE}. ` +
    `Fix: re-run \`${PAIR_INITIATOR_FIX_COMMAND}\` on the hub to restore ` +
    `the pairing role, mint a new token, then retry.`
  );
}

export function rewriteFederationPairHubAccessError(
  status: number,
  hubUrl: string,
  body: string,
): FederationPairHubAccessError | null {
  if (!isFederationPairHubAccessDenial(status, body)) return null;
  return new FederationPairHubAccessError(
    describeFederationPairHubAccessError({ hubUrl, status }),
    status,
  );
}
