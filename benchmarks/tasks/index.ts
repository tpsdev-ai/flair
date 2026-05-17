/**
 * Task registry. Add new tasks here so the runner can discover them.
 */

import { task as t01 } from "./01-decision-recall.js";
import { task as t02 } from "./02-fact-lookup.js";
import { task as t03 } from "./03-reference-resolution.js";

import type { Task } from "../harness/types.js";

export const ALL_TASKS: Task[] = [t01, t02, t03];

export function getTask(id: string): Task | undefined {
  return ALL_TASKS.find((t) => t.id === id);
}
