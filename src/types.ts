export type Durability = "permanent" | "persistent" | "standard" | "ephemeral";

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

export type Memory = {
  id: string;
  agentId: string;
  content: string;
  embedding?: number[];
  tags?: string[];
  durability: Durability;
  source?: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
};

export type Soul = {
  id: string;
  agentId: string;
  key: string;
  value: string;
  durability: Durability;
  createdAt: string;
  updatedAt?: string;
};

export type DB = {
  agents: Agent[];
  integrations: Integration[];
  memories: Memory[];
  souls: Soul[];
};
