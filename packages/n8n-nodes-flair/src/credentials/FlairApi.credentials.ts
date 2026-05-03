import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

/**
 * Flair API credential — v1 admin-token authentication.
 *
 * SECURITY NOTE: an admin token grants read/write to the entire Flair
 * instance, not just the specified agentId. The blast radius is the whole
 * memory store. This is acceptable for v1 / proof-of-concept where the
 * operator controls the n8n workflow inputs, but Ed25519 per-agent auth
 * (ops-q3qf-followup) should land before any deployment with sensitive
 * memories from untrusted workflow inputs.
 *
 * The agentId field controls memory ownership — workflows that share an
 * agentId share memory ownership, allowing "this assistant remembers"
 * patterns across workflows. Use distinct agentIds when isolation matters.
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
      default: 'http://localhost:9926',
      required: true,
      description: 'The Flair instance URL. Use http://localhost:9926 for local installs.',
    },
    {
      displayName: 'Agent ID',
      name: 'agentId',
      type: 'string',
      default: '',
      required: true,
      description:
        'Logical identity used as the memory owner. Workflows that share an agentId share memory ownership.',
    },
    {
      displayName: 'Admin Token',
      name: 'adminToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'Flair admin token. Sensitive: grants read/write to the entire instance. Use Ed25519 per-agent auth (post-1.0) for production with untrusted workflow inputs.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.adminToken}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{ $credentials.baseUrl }}',
      url: '/Health',
    },
  };
}
