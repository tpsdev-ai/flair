// Mock Harper globals for unit testing logic without a running instance.
// Pattern adapted from harper-kb.

export function createMockTable(name: string) {
  const data = new Map<string, any>();
  return {
    get: async (id: string) => data.get(id),
    put: async (record: any) => {
      const id = record.id || Math.random().toString(36).slice(2);
      data.set(id, { ...record, id });
      return id;
    },
    delete: async (id: string) => data.delete(id),
    search: async (params: any) => {
      return Array.from(data.values());
    },
    _data: data
  };
}

export function setupHarperMocks() {
  (globalThis as any).tables = {
    Agent: createMockTable("Agent"),
    Integration: createMockTable("Integration"),
    Memory: createMockTable("Memory"),
    Soul: createMockTable("Soul"),
  };
  (globalThis as any).databases = {
    system: {
      hdb_user: {
        operation: async () => ({ operation_token: "mock-jwt", refresh_token: "mock-refresh" })
      }
    }
  };
  (globalThis as any).Resource = class MockResource {
    getContext() { return { user: "admin" }; }
  };
}
