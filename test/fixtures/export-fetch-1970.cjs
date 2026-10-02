const { appendFileSync } = require("node:fs");

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const path = `${url.pathname}${url.search}`;
  appendFileSync(process.env.MOCK_PATH_LOG, `${path}\n`);
  if (path.startsWith("/Agent/")) {
    const status = Number(process.env.MOCK_AGENT_STATUS || "500");
    const body = status === 200
      ? (process.env.MOCK_EMPTY_AGENT === "1" ? null : { id: process.env.MOCK_AGENT_ID })
      : { error: status === 404 ? "not found" : "boom" };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  const failed = path === process.env.MOCK_FAILED_COLLECTION;
  return new Response(JSON.stringify(failed ? { error: "boom" } : []), {
    status: failed ? 500 : 200, headers: { "content-type": "application/json" },
  });
};
