declare module "@harperfast/harper" {
  export const server: {
    http: (handler: (request: any, next: any) => any, options?: any) => void;
    operation: (operation: Record<string, unknown>, context: any, authorize?: boolean) => Promise<any>;
    getUser: (username: string, password: string | null, request: any) => Promise<any>;
  };
  export const tables: Record<string, any>;
  export const databases: Record<string, any>;
  /**
   * Process-wide model-call facade (#1325). Only the `embed()` shape flair
   * currently consumes (resources/embeddings-provider.ts) is stubbed here —
   * mirrors @harperfast/harper's resources/models/types.ts EmbedOpts.
   */
  export const models: {
    embed: (
      input: string | string[],
      opts?: { model?: string; requires?: string[]; inputType?: "document" | "query"; signal?: AbortSignal }
    ) => Promise<Float32Array[]>;
  };
  export class Resource {
    static search?(query: any): AsyncIterable<any>;
    getContext(): any;
    get?(id?: any): any;
    post?(content: any, context?: any): any;
    put?(content: any): any;
    patch?(content: any): any;
    delete?(): any;
    static connect?(): AsyncIterable<any>;
  }
}
