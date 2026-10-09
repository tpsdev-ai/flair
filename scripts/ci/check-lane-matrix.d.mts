export type Matrix = Record<string, unknown>;
export function effectiveMatrix(matrix: Matrix): Matrix[];
export function shardValues(matrix: Matrix): number[];
export function verifyWorkflowMatrix(text: string): void;
