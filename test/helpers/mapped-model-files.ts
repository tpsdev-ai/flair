/**
 * The embedding-model files a running process has mapped: the files its
 * embedding engine loaded (harper-fabric-embeddings maps the model it loads).
 * Linux reads /proc/<pid>/maps; macOS lists the process's open files with lsof.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The embedding model the test lanes pre-fetch (scripts/ci/fetch-model.sh). */
export const EMBEDDING_MODEL_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";

export function mappedModelFiles(pid: number): string[] {
  let paths: string[];
  if (process.platform === "linux") {
    paths = readFileSync(`/proc/${pid}/maps`, "utf8")
      .split("\n")
      .map((line) => {
        const at = line.indexOf(" /");
        return at < 0 ? "" : line.slice(at + 1);
      });
  } else {
    const r = spawnSync("lsof", ["-n", "-P", "-p", String(pid), "-Fn"], { encoding: "utf8", timeout: 20_000 });
    if (r.error || r.status !== 0) throw new Error(`lsof -p ${pid} failed: ${r.error?.message ?? r.stderr}`);
    paths = r.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  }
  return [...new Set(paths.filter((path) => path.endsWith(".gguf")))];
}
