export type Agent = {
  id: string;
  name: string;
  role?: string;
  publicKey: string;
  createdAt: string;
  updatedAt?: string;
};

export type Integration = {
  id: string;
  agentId: string;
  platform: string;
  username?: string;
  userId?: string;
  email?: string;
  encryptedCredential?: string;
  metadata?: string;
  createdAt: string;
  updatedAt?: string;
};

export type DB = {
  agents: Agent[];
  integrations: Integration[];
};
