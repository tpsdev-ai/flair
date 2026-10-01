import { expect, test } from "bun:test";
import { applyMultiWorkerUnsafeSpawnOption } from "../helpers/harper-lifecycle.js";

test("explicit refused fixture removes an inherited unsafe opt-in from the child environment", () => {
  const childEnv = { FLAIR_MULTI_WORKER_UNSAFE: "1", THREADS_COUNT: "2" };
  applyMultiWorkerUnsafeSpawnOption(childEnv, { threads: 2, multiWorkerUnsafe: false });
  expect(childEnv).not.toHaveProperty("FLAIR_MULTI_WORKER_UNSAFE");
  expect(childEnv.THREADS_COUNT).toBe("2");
});
