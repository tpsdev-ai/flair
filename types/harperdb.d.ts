declare module "harperdb" {
  export const server: {
    http: (handler: (request: any, next: any) => any, options?: any) => void;
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
