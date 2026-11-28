export interface NonReleaseVersionConstant {
  file: string;
  identifier: string;
  reason: string;
}

export const NON_RELEASE_VERSION_CONSTANTS: NonReleaseVersionConstant[];

export function loadNonReleaseConstants(customArg?: string): NonReleaseVersionConstant[];

export const VERSION_DECLARATION: RegExp;

export function declaresVersion(
  path: string,
  text: string,
  expected: string,
  nonReleaseConstants?: NonReleaseVersionConstant[],
): boolean;

export function verify(
  expected: string,
  customNonReleaseConstants?: NonReleaseVersionConstant[],
): void;
