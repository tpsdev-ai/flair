export type InstallRunner = (command: string, argv: string[], options: {
  cwd: string;
  shell: false;
  stdio: "inherit";
}) => { status: number | null; error?: Error; signal?: string | null };
export function installLlamaNative(args: string[], options?: {
  runner?: InstallRunner;
  cwd?: string;
  lockfile?: string;
  log?: (message: string) => void;
}): { version: string; source: string; command: string; argv: string[]; cwd: string };
