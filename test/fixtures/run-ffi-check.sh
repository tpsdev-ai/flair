#!/bin/bash
# Helper script: starts a local HTTP server that returns "now" as publish time,
# runs the CLI's bake-time gate against a temporary fixture repo, and reports
# the CLI exit code.
set -e
cd /home/exedev/agents/ember/work/flair
# Create fixture
T=$(mktemp -d)
echo '{"name":"@ffi-test/fixture","version":"1.0.0","dependencies":{"pkg-dep":"1.0.0"}}' > "$T/package.json"
mkdir -p "$T/packages"
# Start server (node http server, not Bun.serve, to avoid TCP restrictions)
node -e '
const h=require("http")
const s=h.createServer((r,res)=>{
  res.writeHead(200,{"Content-Type":"application/json"})
  res.end(JSON.stringify({time:{"1.0.0":new Date().toISOString()}}))
})
s.listen(0,function(){console.log("PORT:",s.address().port)})' > /tmp/h-ffi.txt 2>&1 &
PID=$!
sleep 0.4
P=$(grep "PORT:" /tmp/h-ffi.txt | head -1 | awk '{print $2}')
if [ -z "$P" ]; then echo "SERVER_FAILED"; kill $PID; exit 1; fi
echo "srv: $P"
export FLAIR_CHECK_DEP_AGES_ROOT="$T"
export FLAIR_NPM_REGISTRY="http://127.0.0.1:$P"
export FLAIR_DEP_MIN_AGE_DAYS=0
node scripts/check-dep-ages.mjs
R=$?
echo "EXIT:$R"
kill $PID 2>/dev/null
wait $PID 2>/dev/null
rm -rf "$T"
exit $R
