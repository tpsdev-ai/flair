export type NativeInstallViolation = { line: number; platform: string; version: string | null };
export type WorkflowViolation = NativeInstallViolation & { file: string };
export function scanWorkflowPins(text: string, expected: string): { installs: number; violations: NativeInstallViolation[] };
export function workflowFiles(dir: string): string[];
export function checkWorkflows(dir: string, expected: string): { installs: number; violations: WorkflowViolation[] };
