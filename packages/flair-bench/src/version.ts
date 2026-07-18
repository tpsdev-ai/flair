/**
 * version.ts — single source of truth for the tool version stamped into
 * output/share documents. Kept as a plain constant (rather than a JSON
 * import of package.json at runtime) to sidestep NodeNext JSON-import-
 * attribute edge cases in a published dist/ build. test/version-sync.test.ts
 * asserts this stays equal to package.json's "version" field.
 */
export const TOOL_VERSION = "0.23.0";
