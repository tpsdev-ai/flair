export type NativeInstallViolation = { line: number };
export type WorkflowViolation = NativeInstallViolation & { file: string };
export function scanWorkflowPins(text: string): NativeInstallViolation[];
export function workflowFiles(dir: string): string[];
export function checkWorkflows(dir: string): WorkflowViolation[];
