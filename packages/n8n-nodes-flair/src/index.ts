// n8n discovers nodes/credentials via package.json's `n8n` field, not via
// JS exports. This file exists so a downstream importer can `require` the
// package without crashing — it intentionally has no public surface.
export {};
