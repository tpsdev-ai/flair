export type NativeInstallViolation = {
  line: number;
  platform: string;
  version: string | null;
  reason: string;
};
export type WorkflowViolation = NativeInstallViolation & { file: string };
export function allowedScript(command: string): string | null;
export function scanWorkflowPins(text: string): { installs: number; violations: NativeInstallViolation[] };
export function workflowFiles(dir: string): string[];
export function checkWorkflows(dir: string): { installs: number; violations: WorkflowViolation[] };
export const REPO_VERSION_SCRIPT: string;
export const INSTALLED_VERSION_SCRIPT: string;
