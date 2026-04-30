---
name: "Harper Docker = npm at same tag"
description: "Harper Docker image and npm package are byte-identical at matching versions"
type: "reference"
tags: ["harper", "docker", "npm", "build"]
---

The Harper Docker image (`ghcr.io/tpsdev-ai/harper`) and npm package (`@harperfast/harper`) should be byte-identical when using the same version tag.

This ensures users get the same Harper binary whether they run via Docker or npm install.

Verification: Pull both, compare dist/* contents.
