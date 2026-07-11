export { FlairClient, FlairError, canonicalRelationshipId } from "./client.js";
export { loadPrivateKey, resolveKeyPath, signRequest } from "./auth.js";
export type {
  FlairClientConfig,
  Memory,
  MemoryType,
  Durability,
  Visibility,
  SoulEntry,
  SearchResult,
  BootstrapResult,
  Relationship,
} from "./types.js";
