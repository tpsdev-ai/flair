declare module "@harperfast/harper" {
  export const server: {
    http: (handler: (request: any, next: any) => any, options?: any) => void;
    operation: (operation: Record<string, unknown>, context: any, authorize?: boolean) => Promise<any>;
    getUser: (username: string, password: string | null, request: any) => Promise<any>;
  };
  export const tables: Record<string, any>;
  export const databases: Record<string, any>;
  /**
   * Process-wide model-call facade (#1325). Only the shapes flair currently
   * consumes are stubbed here — mirrors @harperfast/harper's
   * resources/models/types.ts EmbedOpts/GenerateOpts/GenerateResult.
   * `generate` added for #707 (REM slice 2 in-process distillation,
   * resources/MemoryReflect.ts execute mode) — no tool-calling or streaming
   * fields, flair doesn't use them.
   */
  export const models: {
    embed: (
      input: string | string[],
      opts?: { model?: string; requires?: string[]; inputType?: "document" | "query"; signal?: AbortSignal }
    ) => Promise<Float32Array[]>;
    generate: (
      input: string,
      opts?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        responseFormat?: "text" | "json" | { schema: object };
        signal?: AbortSignal;
      }
    ) => Promise<{
      content: string;
      finishReason: "stop" | "length" | "tool_calls" | "content_filter";
      usage?: { promptTokens?: number; completionTokens?: number };
    }>;
  };
  /**
   * Server logger (#707) — only the levels flair currently calls.
   */
  export const logger: {
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    info: (...args: any[]) => void;
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
