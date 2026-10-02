import type { ICredentialType, INodeProperties } from 'n8n-workflow';

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
        'The memory owner and, with Agent Private Key selected, signing identity. Workflows that share an agent id share memory ownership.',
    },
    {
      displayName: 'Agent Private Key',
      name: 'agentPrivateKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description:
        "Register a new agent with `flair agent add <agent-id>`, or use an existing agent's matching Ed25519 key; encode it with `base64 < ~/.flair/keys/<agent-id>.key` and paste the output. With Agent Private Key selected, requests sign as Agent ID. Ordinary agents read their own and other agents' non-private memories; administrator-role agents have broader authority.",
    },
    {
      displayName: 'Admin Password (deprecated)',
      name: 'adminPassword',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description:
        "Used only with Agent Private Key empty. Harper administrator Basic authentication includes access to other agents' private memories; each node execution warns.",
    },
  ];
}
