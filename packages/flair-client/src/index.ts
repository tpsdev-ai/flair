export { FlairClient, FlairError, canonicalRelationshipId } from "./client.js";
export {
  loadPrivateKey,
  resolveKeyPath,
  signRequest,
  inspectKeyLookup,
  formatKeyLookup,
  keyPathCandidates,
  callTimeHomes,
  expandHomePrefix,
} from "./auth.js";
export type { KeyLookupState, KeyAuthMethod, HomeSources } from "./auth.js";
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
