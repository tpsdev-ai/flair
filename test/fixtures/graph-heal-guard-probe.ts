import { Resource, databases } from "harper";
import { getModelId } from "../../resources/embeddings-provider.js";
import { recomputeLatch, spaceGuardState } from "../../resources/embedding-space-guard.js";
import { createGraphHealMigration } from "../../resources/migrations/graph-heal.js";
import { MigrationRegistry } from "../../resources/migrations/registry.js";
import { runMigrationCycle } from "../../resources/migrations/runner.js";

export class GraphHealGuardProbe extends Resource {
  allowCreate() { return true; }

  async post({ action }: { action: "verify" | "cycle" }) {
    if (action === "verify") {
      await recomputeLatch();
      return { guard: spaceGuardState(), modelId: getModelId() };
    }
    if (action !== "cycle") throw new Error("unknown probe action");
    const dataDir = process.env.FLAIR_GRAPH_HEAL_TEST_DATA_DIR;
    if (!dataDir) throw new Error("missing test data directory");
    return runMigrationCycle({
      registry: new MigrationRegistry().register(createGraphHealMigration()),
      getTable: (name) => databases.flair[name],
      dataDir,
      runningVersion: "graph-heal-guard-test",
    });
  }
}
