/**
 * Shared Flair client construction for the n8n nodes.
 *
 * Every node authenticates as the credential's agent: the credential holds an
 * agent id and that agent's Ed25519 private key, and each request carries a
 * `TPS-Ed25519` signature built by flair-client — the same signing path the
 * other Flair adapters use.
 *
 * The pre-existing admin-password credential keeps working as a DEPRECATED
 * path: it authenticates as the Harper administrator (whole-instance
 * read/write, including other agents' private memories) and every execution
 * that uses it logs a warning. An agent key always wins when both are present.
 */
import type { FlairClient } from "@tpsdev-ai/flair-client";
import type {
  ICredentialDataDecryptedObject,
  ICredentialTestFunctions,
  ICredentialsDecrypted,
  INodeCredentialTestResult,
  Logger,
} from "n8n-workflow";

/** The fields the FlairApi credential supplies. */
export interface FlairCredentials {
  baseUrl: string;
  agentId: string;
  /** Ed25519 private key for `agentId` (a secret; never logged or echoed). */
  agentPrivateKey?: string;
  /** Deprecated Harper admin password — instance-wide authority. */
  adminPassword?: string;
}

// flair-client is published ESM-only. n8n nodes compile to CJS and load via
// `require`, so a static `import { FlairClient } from "@tpsdev-ai/flair-client"`
// crashes at boot on Node 24+ with "No exports main defined" because the
// flair-client package only declares an `import` condition in its exports
// map. The `import type` above emits no runtime require, and this dynamic
// import is the standard CJS→ESM interop path.
//
// The import is wrapped in Function() so TypeScript (compiled to CommonJS for
// n8n consumption) doesn't downlevel `await import(...)` to a `require()` call,
// which hits the ESM-only exports map and is rejected by Node 24+.
export const importFlairClient = (): Promise<typeof import("@tpsdev-ai/flair-client")> =>
  (new Function("return import('@tpsdev-ai/flair-client')") as () => Promise<any>)();

/** The credential text: the credential's fields, trimmed, as strings. */
export function asFlairCredentials(data: ICredentialDataDecryptedObject): FlairCredentials {
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  return {
    baseUrl: text(data.baseUrl),
    agentId: text(data.agentId),
    agentPrivateKey: text(data.agentPrivateKey) || undefined,
    adminPassword: text(data.adminPassword) || undefined,
  };
}

/**
 * True when this credential has no agent key and carries the deprecated admin
 * password — i.e. the execution will run with the Harper administrator's
 * instance-wide authority instead of the agent's identity.
 */
export function usesDeprecatedAdminPassword(credentials: FlairCredentials): boolean {
  return !credentials.agentPrivateKey && !!credentials.adminPassword;
}

/** The warning logged on EVERY execution that takes the deprecated path. */
export function adminPasswordWarning(agentId: string): string {
  return (
    "Flair API credential: using the deprecated Admin Password, not an agent key. " +
    "This execution runs as the Harper administrator, which can read and write every " +
    `agent's memories (including private ones) rather than being signed as agent '${agentId}'. ` +
    "Set the credential's Agent Private Key to sign as that agent."
  );
}

/** The refusal when a credential carries neither an agent key nor an admin password. */
function missingCredentialMessage(): string {
  return (
    "Flair API credential: set the Agent Private Key (the Ed25519 key of the credential's " +
    "agent id), or the deprecated Admin Password to authenticate as the Harper administrator."
  );
}

/**
 * Warn when the execution is about to run under the deprecated admin password.
 * Called at every node entry point, before any request, so it warns on every
 * execution — including one that later fails.
 */
export function warnDeprecatedAdminPassword(
  logger: Logger | undefined,
  credentials: FlairCredentials,
): void {
  if (!usesDeprecatedAdminPassword(credentials)) return;
  logger?.warn(adminPasswordWarning(credentials.agentId));
}

function assertKeyIsNotPem(key: string): void {
  if (key.includes("-----BEGIN")) {
    throw new Error(
      "Flair API credential: the Agent Private Key field expects the key file's contents " +
        "(base64), not a PEM block.",
    );
  }
}

/** Build the Flair client for this credential, signing as the agent when it has a key. */
export async function makeClient(credentials: FlairCredentials): Promise<FlairClient> {
  const mod = await importFlairClient();
  if (credentials.agentPrivateKey) {
    assertKeyIsNotPem(credentials.agentPrivateKey);
    return new mod.FlairClient({
      url: credentials.baseUrl,
      agentId: credentials.agentId,
      privateKey: mod.loadPrivateKeyString(credentials.agentPrivateKey),
    });
  }
  if (credentials.adminPassword) {
    return new mod.FlairClient({
      url: credentials.baseUrl,
      agentId: credentials.agentId,
      adminUser: "admin",
      adminPassword: credentials.adminPassword,
    });
  }
  throw new Error(missingCredentialMessage());
}

/**
 * The credential test, wired from each node's credential declaration
 * (`testedBy`). It builds the same client the nodes build and performs the
 * read the nodes' client lists from (`GET /Memory?agentId=<id>`), which the
 * server scopes to that agent: a wrong key fails with the server's 401. n8n's
 * declarative credential test cannot sign, so this is the only way to test the
 * agent-key path.
 */
export async function flairCredentialTest(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
): Promise<INodeCredentialTestResult> {
  const credentials = asFlairCredentials(credential.data ?? {});
  try {
    const client = await makeClient(credentials);
    await client.request("GET", `/Memory?${new URLSearchParams({ agentId: credentials.agentId })}`);
    return {
      status: "OK",
      message: credentials.agentPrivateKey
        ? `Signed as agent '${credentials.agentId}'.`
        : `Authenticated as the Harper administrator with the deprecated Admin Password (agent '${credentials.agentId}' is the memory owner).`,
    };
  } catch (error) {
    return {
      status: "Error",
      message: error instanceof Error ? error.message : "Flair API credential test failed.",
    };
  }
}
