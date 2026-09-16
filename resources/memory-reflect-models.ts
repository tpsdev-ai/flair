/**
 * Sole Harper `models.generate` binding for /ReflectMemories execute.
 *
 * MemoryReflect.ts must not call `models.generate()` itself (flair#1263
 * condition 2): the resource reaches generate only by passing this binder
 * into `runExecuteDistillation` → `generateCandidates`.
 */

import { models } from "harper";
import type { GenerateFn } from "./memory-reflect-lib.js";

export const reflectModelsGenerate: GenerateFn = (input, opts) =>
  models.generate(input, opts);
