const { readFileSync } = require("node:fs");
const databases = require("../../node_modules/harper/dist/resources/databases.js");
databases.table = () => ({});
const { authentication } = require("../../node_modules/harper/dist/security/auth.js");
const { settleDeferredCredentialRejection } = require("../../node_modules/harper/dist/security/deferredAuthentication.js");
const { Request } = require("../../node_modules/harper/dist/server/serverHelpers/Request.js");

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const request = new Request({
    method: input.method ?? "GET", url: input.url ?? "/Presence", headers: input.headers, socket: { server: {} },
  }, { on() {} });
  request.user = input.user;
  const result = await authentication(request, () =>
    settleDeferredCredentialRejection(request) ?? { status: 200 });
  process.stdout.write(JSON.stringify({ status: result.status, body: result.body }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
