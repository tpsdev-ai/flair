export function parseJobLog(text: string): Record<string, number>;
export function aggregate(logs: string[], keep?: Set<string>): Record<string, number>;
