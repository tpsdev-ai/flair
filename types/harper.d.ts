declare module "@harperfast/harper" {
  export const server: {
    http: (handler: (request: any, next: any) => any, options?: any) => void;
    operation: (operation: Record<string, unknown>, context: any, authorize?: boolean) => Promise<any>;
    getUser: (username: string, password: string | null, request: any) => Promise<any>;
  };
  export const tables: Record<string, any>;
  export const databases: Record<string, any>;
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
