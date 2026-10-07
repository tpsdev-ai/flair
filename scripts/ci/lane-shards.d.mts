export const ROOT: string;
export const ROOT_STEP_TIMEOUT_MS: number;
export const LANE_SHARDS: number;
export const WORKSPACE_PACKAGES: string[];

export interface UnitStep {
  name: string;
  cwd: string;
  args: string[];
  files: string[];
  /** This step's own time limit when the lane runs with limits; unset means the lane's default. */
  timeoutMs?: number;
  /** Set on the root unit shard steps that replace the single root unit step (flair#2258). */
  shard?: { index: number; of: number };
}

export function unitPlan(root?: string): UnitStep[];
export function isShardedStep(step: UnitStep): boolean;
export function shardedSteps(steps: UnitStep[]): UnitStep[];
export function sharedSteps(steps: UnitStep[]): UnitStep[];
export function weightOf(step: UnitStep): number;
export function assignLaneShards(steps: UnitStep[], of?: number): UnitStep[][];
export function laneShardPlans(steps: UnitStep[], of?: number): UnitStep[][];
export function shardSteps(index: number, of?: number, steps?: UnitStep[]): UnitStep[];
export function listLaneFiles(root?: string): string[];
export function commandFiles(step: UnitStep): string[];
export function laneCoverage(
  steps: UnitStep[],
  shards: UnitStep[][],
  allFiles?: string[],
): {
  totalSteps: number;
  coveredSteps: number;
  totalFiles: number;
  coveredFiles: number;
  missingSteps: string[];
  duplicatedSteps: string[];
  unknownSteps: string[];
  missingFiles: string[];
  duplicatedFiles: string[];
  unknownFiles: string[];
  invalidSharedSteps: string[];
  invalidTestSteps: string[];
  invalidCommands: string[];
  fileMismatches: { step: string; declaredOnly: string[]; commandOnly: string[] }[];
  empty: number[];
};
export function verifyLaneShards(
  of?: number,
  steps?: UnitStep[],
  allFiles?: string[],
): ReturnType<typeof laneCoverage>;
