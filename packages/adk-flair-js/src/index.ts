/**
 * adk-flair — Flair as the memory backend for Google ADK (JS/TS).
 *
 * @packageDocumentation
 */

export { FlairMemoryService } from "./memory_service.js";
export type {
  FlairMemoryEntry,
  FlairSearchMemoryResponse,
  AddMemoryOptions,
  ListMemoriesOptions,
  FlairDurability,
  FlairVisibility,
} from "./memory_service.js";
export { compoundTag, sanitizeTagSegment, desanitizeTagSegment } from "./tag.js";
export { loadEd25519Key, signRequest } from "./signing.js";
