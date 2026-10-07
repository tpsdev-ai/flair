/**
 * Version field of an installed `@node-llama-cpp/<platform>` package.json.
 * This module does not read the umbrella `node-llama-cpp` package.
 * `readEmbeddingProvenance` is the caller that names which platform package.
 */
export { versionFromPackageJson } from "./provenance.js";
