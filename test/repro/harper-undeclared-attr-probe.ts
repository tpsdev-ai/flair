// flair#1940 A1' item 1 — the Harper undeclared-attribute probe.
//
// Run: bun test/repro/harper-undeclared-attr-probe.ts
//
// Boots a HOME-isolated ephemeral Harper against THIS repo (real schemas +
// resources), inserts a Memory row with an attribute the Memory schema does
// NOT declare (`undeclaredProbe`), then reads it back. The point: if Harper
// stores an undeclared attribute, then removing a field from the schema does
// NOT stop a raw writer — which is why A1' needs the shared "declared
// attributes only" guard, not just a schema change.
//
// Not a `.test.ts`: the unit lane must not boot Harper. This is a one-shot
// probe whose output is recorded in the PR report.
import { startHarper, stopHarper } from "../helpers/harper-lifecycle";

const harper = await startHarper({});
try {
  const admin = async (op: Record<string, any>) =>
    fetch(harper.opsURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`,
      },
      body: JSON.stringify(op),
    });

  const id = `probe-${Date.now()}`;
  const insert = await admin({
    operation: "insert",
    database: "flair",
    table: "Memory",
    records: [
      {
        id,
        agentId: "probe-agent",
        content: "undeclared-attribute probe",
        visibility: "private",
        createdAt: new Date().toISOString(),
        undeclaredProbe: "SENTINEL",
      },
    ],
  });
  console.log("INSERT status:", insert.status, (await insert.text()).slice(0, 200));

  const read = await admin({
    operation: "search_by_value",
    database: "flair",
    table: "Memory",
    search_attribute: "id",
    search_type: "equals",
    search_value: id,
    get_attributes: ["*"],
  });
  const body = await read.text();
  console.log("READ status:", read.status);
  console.log("READ body:", body.slice(0, 400));

  let survived = false;
  try {
    const parsed = JSON.parse(body);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    survived = row?.undeclaredProbe === "SENTINEL";
  } catch {
    /* ignore */
  }
  console.log("PROBE RESULT — undeclared attribute survived on disk:", survived);
} finally {
  await stopHarper(harper);
}
