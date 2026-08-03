// flair: the ops API is NOT the served origin, and its port is NOT derivable.
//
// `flair mcp enable --instance https://flair.example.harperfabric.com` posted
// its ops calls to port 443, where the flair REST component owns "/" and answers
// 404 Not found. The error then reported it as "failed to look up principal
// '<x>'", which sends the reader to look at principals — a missing principal
// returns 200 [], and the code creates it. It never got that far.
//
// Measured against a live Fabric instance, same request:
//     POST https://<host>/        -> 404 "Not found"
//     POST https://<host>:9925/   -> 200 []
//     POST https://<host>:442/    -> no response   (the documented "port-1" rule)
//     POST https://<host>:19925/  -> no response
//
// So no arithmetic on the served port can be trusted. An operator can put the
// ops API anywhere, which is why an explicit override must always win.
import { describe, test, expect } from "bun:test";
import { resolveOpsUrl, HOSTED_OPS_PORT } from "../../src/lib/mcp-enable.js";

describe("resolveOpsUrl — never assume the served origin is the ops API", () => {
  test("a hosted origin does NOT keep its served port", () => {
    const u = resolveOpsUrl("https://flair.example.harperfabric.com");
    expect(u).not.toContain("harperfabric.com/");     // not the bare origin
    expect(u).toContain(`:${HOSTED_OPS_PORT}`);
  });

  test("the served port is replaced, not decremented", () => {
    // The codebase documents "ops port = HTTP port - 1". Measured dead on
    // Fabric (442 and 19925 both unreachable). Guard against reintroduction.
    const u = resolveOpsUrl("https://flair.example.harperfabric.com:443");
    expect(u).toContain(":9925");
    expect(u).not.toContain(":442");
  });

  test("an explicit ops URL always wins — an operator can put it anywhere", () => {
    const u = resolveOpsUrl("https://flair.example.harperfabric.com", "https://ops.internal:31337");
    expect(u).toBe("https://ops.internal:31337/");
  });

  test("explicit wins even when it looks nothing like the instance", () => {
    const u = resolveOpsUrl("https://a.example.com", "http://10.0.0.5:9925");
    expect(u).toBe("http://10.0.0.5:9925/");
  });

  test("a numeric target stays loopback — the local shape is unchanged", () => {
    expect(resolveOpsUrl(19925)).toBe("http://127.0.0.1:19925/");
  });

  test("a bare host is treated as https and gets the ops port", () => {
    const u = resolveOpsUrl("flair.example.harperfabric.com");
    expect(u).toBe(`https://flair.example.harperfabric.com:${HOSTED_OPS_PORT}/`);
  });

  test("query strings and paths on the instance URL are dropped", () => {
    const u = resolveOpsUrl("https://h.example.com/some/path?x=1");
    expect(u).toBe(`https://h.example.com:${HOSTED_OPS_PORT}/`);
  });

  test("an unparseable target is not turned into an invented URL", () => {
    // Preserve the old behaviour rather than guessing; the caller's error path
    // names the remedy.
    expect(resolveOpsUrl("::::not a url::::")).toBe("::::not a url::::/");
  });
});
