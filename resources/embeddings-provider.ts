/**
 * embeddings-provider.ts
 *
 * Thin wrapper around harper-fabric-embeddings for Flair resources.
 * harper-fabric-embeddings handles loading and running the embedding model
 * at the Harper sub-component level — we just delegate to its exported API.
 *
 * On platforms where the native binary isn't available, getEmbedding()
 * returns null and semantic search falls back to keyword matching.
 */

import * as hfe from "harper-fabric-embeddings";

const SINGLETON_KEY = "__flair_hfe_provider_v1__";

interface ProviderState {
  initialized: boolean;
  available: boolean;
}

function getState(): ProviderState {
  if (!(globalThis as any)[SINGLETON_KEY]) {
    (globalThis as any)[SINGLETON_KEY] = { initialized: false, available: false };
  }
  return (globalThis as any)[SINGLETON_KEY];
}

export async function initEmbeddings(): Promise<void> {
  const state = getState();
  if (state.initialized) return;

  // harper-fabric-embeddings is initialized by Harper as a sub-component
  // (declared in config.yaml). It inits in the background so it may not
  // be ready when resources first load. Retry a few times before giving up.
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const dims = hfe.dimensions();
      state.available = true;
      state.initialized = true;
      console.log(`[embeddings] ready (${dims} dims, attempt ${attempt})`);
      return;
    } catch {
      if (attempt < 10) await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log("[embeddings] not available after 10 attempts — search will be keyword-only");
  state.available = false;
  state.initialized = true;
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  const state = getState();
  if (!state.initialized) await initEmbeddings();
  if (!state.available) return null;
  try {
    return hfe.embed(text);
  } catch (err: any) {
    console.log(`[embeddings] embed failed: ${err.message}`);
    return null;
  }
}

export function getMode(): "local" | "none" {
  const state = getState();
  return state.available ? "local" : "none";
}
