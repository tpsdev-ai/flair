// Shared state for harper mocks across test files.
// Bun's mock.module is process-global — multiple files mocking "harper"
// race for which mock wins.  By sharing the same agentStore / serverStore
// and defining IDENTICAL mock shapes in each file, it doesn't matter
// which mock.module call wins: both files see the same state.

export const agentStore = new Map<string, any>();

export const serverStore = {
  getUserResult: null as any,
  getUserError: false,
};

// auth-middleware.ts is a side-effect module (no exports) — it calls
// server.http(fn, {runFirst:true}).  Tests capture the callback here.
// Wrapped in an object so mock closures can reassign .value (ESM import
// bindings are read-only).
export const middlewareCapture = { value: null as any };

export function resetHarperState() {
  agentStore.clear();
  serverStore.getUserResult = null;
  serverStore.getUserError = false;
  middlewareCapture.value = null;
}
