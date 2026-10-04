/** Shared n8n client construction: Agent Private Key signing or deprecated administrator Basic. */
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
  /** Ed25519 private key for `agentId`. */
  agentPrivateKey?: string;
  /** Deprecated Harper admin password — instance-wide authority. */
  adminPassword?: string;
}

export const importFlairClient = (): Promise<typeof import("@tpsdev-ai/flair-client")> =>
  (new Function("return import('@tpsdev-ai/flair-client')") as () => Promise<any>)();

export function asFlairCredentials(data: ICredentialDataDecryptedObject): FlairCredentials {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    baseUrl: text(data.baseUrl),
    agentId: text(data.agentId).trim(),
    agentPrivateKey: text(data.agentPrivateKey).trim() || undefined,
    adminPassword: text(data.adminPassword) || undefined,
  };
}

/** Whether the normalized credential selects administrator Basic authentication. */
export function usesDeprecatedAdminPassword(credentials: FlairCredentials): boolean {
  return !credentials.agentPrivateKey && !!credentials.adminPassword;
}

export function adminPasswordWarning(agentId: string): string {
  return (
    "Flair API credential: using the deprecated Admin Password, not an agent key. " +
    "This execution selected Harper administrator Basic authentication; if Flair accepts the " +
    "credentials, it can read and write every agent's memories (including private ones) " +
    `rather than being signed as agent '${agentId}'. ` +
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
      "Flair API credential: the Agent Private Key field expects the key file's " +
        "base64-encoded contents, not a PEM block.",
    );
  }
}

/** Build the Flair client for this credential, signing as the agent when it has a key. */
export async function makeClient(credentials: FlairCredentials): Promise<FlairClient> {
  if (!credentials.agentId.trim()) {
    throw new Error("Flair API credential: Agent ID is required.");
  }
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
      authMode: "basic",
      adminUser: "admin",
      adminPassword: credentials.adminPassword,
    });
  }
  throw new Error(missingCredentialMessage());
}

/** Test a Memory read with the same normalized credential and auth mode as the nodes. */
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
