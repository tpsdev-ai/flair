/** Typings for `published-paths.mjs` — the changelog gate's published-path helpers. */
export function publishedEntryNames(packageRoot: string): Set<string>;
export function hasDeclaredFiles(packageRoot: string): boolean;
export function workspaceTopLevels(packageRoot: string): Set<string>;
export function shippingTopLevels(packageRoot: string): Set<string>;
export function pathTouchesPublished(relPath: string, shipping: Set<string>): boolean;
export function changeTouchesPublished(
  relPaths: readonly string[] | null | undefined,
  packageRoot: string,
): boolean;
