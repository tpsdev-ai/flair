import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Flair API credential — v2 per-agent Ed25519 authentication.
 *
 * Every request is signed as the credential's Agent ID with that agent's
 * Ed25519 key (the same `TPS-Ed25519` signing path the other Flair adapters
 * use), so a workflow reaches its own agent's memories plus the org-wide
 * non-private pool — never another agent's private memories.
 *
 * The v1 Harper admin password stays available as a DEPRECATED field: it
 * authenticates as the instance administrator, which grants read/write to the
 * whole memory store including other agents' private memories, and every
 * execution that uses it logs a warning. It is used only when Agent Private
 * Key is empty, so an agent key always wins when both are filled in.
 *
 * The agent private key is a secret: it is never logged, never echoed into
 * node output or errors, and never sent anywhere except as a signature.
 */
export class FlairApi implements ICredentialType {
  name = 'flairApi';

  displayName = 'Flair API';

  documentationUrl = 'https://github.com/tpsdev-ai/flair#n8n';

  properties: INodeProperties[] = [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'http://localhost:19926',
      required: true,
      description:
        'The Flair instance URL. Use http://localhost:19926 for local installs (the port a stock `flair init` serves). Spoke deployments commonly use :9926.',
    },
    {
      displayName: 'Agent ID',
      name: 'agentId',
      type: 'string',
      default: '',
      required: true,
      description:
        'The identity that signs every request and owns the memories written from this credential. Mint its key with `flair agent add <agent-id>`. Workflows that share an agent id share memory ownership.',
    },
    {
      displayName: 'Agent Private Key',
      name: 'agentPrivateKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description:
        "The agent's Ed25519 private key, base64-encoded — mint it with `flair agent add <agent-id>`, then `base64 < ~/.flair/keys/<agent-id>.key` and paste the output. Requests are signed as the agent id above, so this credential can reach that agent's memories and other agents' non-private memories, never their private ones. The key is never logged, echoed into output or errors, or sent anywhere except as a signature.",
    },
    {
      displayName: 'Admin Password (deprecated)',
      name: 'adminPassword',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description:
        'Deprecated v1 authentication. Authenticates as the Harper administrator, which grants read/write to the entire instance — including every other agent\'s private memories — instead of signing as the agent id above. Used only while Agent Private Key is empty; every execution that uses it logs a warning. Prefer the agent key.',
    },
  ];
}
