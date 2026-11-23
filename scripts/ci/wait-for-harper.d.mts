export interface WaiterOptions {
  container: string;
  url: string;
  credentialsEnv?: string;
  budgetSeconds: number;
  pollIntervalMs: number;
  progressIntervalMs: number;
  perRequestMs: number;
}

export function resolveBudget(flagValue: string | undefined, envValue: string | undefined): number;
export function parseArgs(argv: string[], env?: NodeJS.ProcessEnv): WaiterOptions;
export function main(options: WaiterOptions): Promise<number>;
