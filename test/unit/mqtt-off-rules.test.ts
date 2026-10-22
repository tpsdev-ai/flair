/**
 * mqtt-off-rules.test.ts — the rules the component-deployment channel's
 * MQTT-off step applies (src/mqtt-off-deploy.ts, src/lib/mqtt-config.ts):
 *   - the saved configuration it requires after the deploy's restart
 *     (mqttOffConfirmed), reported by field name and category, never a value
 *     the answer carries; and the root-configuration recognizer
 *     (rootConfigurationProblem) that decides whether an answer is one;
 *   - the URL rules (unsafeUrlProblem, safeUrl, deployUrlRefusal): http or
 *     https with a host, and nothing but scheme, host, port and path;
 *   - cluster node names (isNodeHost, peerOpsUrl): a node's operations API URL
 *     is built only for a valid host name or IP address, and printed through
 *     safeUrl;
 *   - restart-job outcomes (reportedRestartFailure, isCompletedJobMessage):
 *     only Harper's exact completed-job message for the requested job id
 *     counts;
 *   - the report's closing sentences (MQTT_OFF_REPORT_LIMIT).
 */
import { describe, expect, test } from "bun:test";
import {
  MQTT_OFF_REPORT_LIMIT,
  deployUrlRefusal,
  isCompletedJobMessage,
  isNodeHost,
  peerOpsUrl,
  reportedRestartFailure,
  safeUrl,
  unsafeUrlProblem,
} from "../../src/mqtt-off-deploy.ts";
import { mqttOffConfirmed, rootConfigurationProblem } from "../../src/lib/mqtt-config.ts";

describe("mqttOffConfirmed", () => {
  test("passes Harper's answer after the MQTT-off configuration is set", () => {
    expect(mqttOffConfirmed({ mqtt: { network: { port: null, securePort: null, mtls: false }, webSocket: false, requireAuthentication: true } })).toBeNull();
  });
  test("names what is missing or still on; an empty answer is not off", () => {
    expect(mqttOffConfirmed(null)).toBe("the answer is not a configuration object");
    expect(mqttOffConfirmed({})).toBe("the answer has no mqtt section");
    expect(mqttOffConfirmed({ mqtt: { webSocket: true, network: { port: 1883, securePort: null } } })).toBe("mqtt.webSocket is not false, mqtt.network.port is not null");
    expect(mqttOffConfirmed({ mqtt: { webSocket: false } })).toBe("mqtt.network is missing");
    expect(mqttOffConfirmed({ mqtt: { network: {} } })).toBe("mqtt.webSocket is missing, mqtt.network.port is missing, mqtt.network.securePort is missing");
  });
  test("reports field names and categories only, never a value the answer carries", () => {
    const reason = mqttOffConfirmed({ mqtt: { webSocket: "private-value", network: { port: "private-value", securePort: { v: "private-value" } } } });
    expect(reason).toBe("mqtt.webSocket is not false, mqtt.network.port is not null, mqtt.network.securePort is not null");
    expect(reason).not.toContain("private-value");
  });
});

describe("rootConfigurationProblem", () => {
  test("an answer without an object http, an object operationsApi and a non-empty string rootPath is not a root configuration", () => {
    expect(rootConfigurationProblem(null)).toBe("the answer is not an object");
    expect(rootConfigurationProblem({})).toBe("it has no http, operationsApi, rootPath");
    expect(rootConfigurationProblem({ mqtt: { webSocket: false, network: { port: null, securePort: null } } })).toBe("it has no http, operationsApi, rootPath");
    expect(rootConfigurationProblem({ http: { port: 9926 }, operationsApi: {}, rootPath: "" })).toBe("it has no rootPath");
    expect(rootConfigurationProblem({ http: { port: 9926 }, operationsApi: {}, rootPath: "/hdb" })).toBeNull();
  });
});

describe("URL rules", () => {
  test("a URL carrying a user name or password, any query or any fragment is refused", () => {
    expect(unsafeUrlProblem("https://user:pw@host.example:9925")).toBe("it carries a user name or password");
    expect(unsafeUrlProblem("https://user@host.example:9925")).toBe("it carries a user name or password");
    // An empty user name or password, which the URL parser drops, is refused from the URL as written.
    for (const url of ["https://@example.invalid/flair", "https://:@example.invalid/flair", "https:@example.invalid/flair", " https://@example.invalid", "https://\t@example.invalid/flair"]) {
      expect([url, unsafeUrlProblem(url)]).toEqual([url, "it carries a user name or password"]);
    }
    // An "@" after the authority (in the path) is not a user name.
    expect(unsafeUrlProblem("https://example.invalid/p@q")).toBeNull();
    for (const q of ["token=x", "value=mysecret", "region=eu", "x"]) {
      expect([q, unsafeUrlProblem(`https://host.example:9925/?${q}`)]).toEqual([q, "it carries a query"]);
    }
    expect(unsafeUrlProblem("https://host.example:9925/?")).toBe("it carries a query");
    expect(unsafeUrlProblem("https://host.example:9925/#anything")).toBe("it carries a fragment");
    expect(unsafeUrlProblem("not a url")).toBe("it is not a valid URL");
  });
  test("a scheme other than http or https is refused", () => {
    for (const url of ["file:///tmp/private-value", "javascript:private-value", "ftp://host.example/", "data:text/plain,private-value", "mailto:someone@host.example", "ws://host.example:9926", "wss://host.example:9926"]) {
      expect([url, unsafeUrlProblem(url)]).toEqual([url, "its scheme is not http or https"]);
    }
  });
  test("an http or https URL without a host does not parse, so it is refused as not a valid URL", () => {
    for (const url of ["http://", "https:///", "http://:9925", "http://@/", "https://[]/"]) {
      expect([url, unsafeUrlProblem(url)]).toEqual([url, "it is not a valid URL"]);
    }
  });
  test("an http or https URL with a host, and scheme, host, port and path only, is allowed", () => {
    expect(unsafeUrlProblem("https://host.example:9925")).toBeNull();
    expect(unsafeUrlProblem("http://127.0.0.1:19925/")).toBeNull();
    expect(unsafeUrlProblem("https://host.example/flair")).toBeNull();
  });
  test("safeUrl prints scheme, host, port and path only, and nothing of a URL that is not http or https with a host", () => {
    expect(safeUrl("https://user:pw@host.example:9925/ops?token=x#y")).toBe("https://host.example:9925/ops");
    expect(safeUrl("http://127.0.0.1:19925/")).toBe("http://127.0.0.1:19925");
    expect(safeUrl("::")).toBe("(an unparseable URL)");
    for (const url of ["file:///tmp/private-value", "javascript:private-value"]) {
      expect([url, safeUrl(url)]).toEqual([url, "(a URL that is not http or https with a host)"]);
    }
  });
  test("deployUrlRefusal names the first URL that may not be used; it prints that URL's scheme, host, port and path, never its userinfo, query or fragment", () => {
    const refusal = deployUrlRefusal([
      ["https://host.example:9925", "deploy target URL (--target)"],
      [undefined, "skipped"],
      ["https://user:hunter2@host.example:9925/?token=abc", "operations API URL"],
    ]);
    expect(refusal).toContain("the operations API URL https://host.example:9925 cannot be used: it carries a user name or password");
    expect(refusal).not.toContain("hunter2");
    expect(refusal).not.toContain("token=abc");
    expect(deployUrlRefusal([["https://host.example", "deploy target URL"]])).toBeNull();
    for (const url of ["javascript:private-value", "file:///tmp/private-value"]) {
      const message = deployUrlRefusal([[url, "URL"]]);
      expect(message).toContain("cannot be used: its scheme is not http or https");
      expect(message).not.toContain("private-value");
    }
  });
});

describe("cluster node names", () => {
  test("isNodeHost accepts a valid host name or IP address and nothing else", () => {
    for (const ok of ["node-b", "node-b.cluster.example", "10.0.0.5", "::1", "fe80::1", "a".repeat(63)]) expect([ok, isNodeHost(ok)]).toEqual([ok, true]);
    for (const bad of [":", "", "node-b:9925", "node b", "-node", "node-", "a..b", "node/b", "[::1]", "http://node-b", "a".repeat(64), "x".repeat(254), 42, null, undefined]) {
      expect([bad, isNodeHost(bad)]).toEqual([bad, false]);
    }
  });
  test("peerOpsUrl builds a node's operations API URL from the target's scheme and port, printed through safeUrl, only for a valid host", () => {
    expect(peerOpsUrl("https://flair.example:9925", "node-b")).toBe("https://node-b:9925");
    expect(peerOpsUrl("http://127.0.0.1:19925/", "10.0.0.5")).toBe("http://10.0.0.5:19925");
    expect(peerOpsUrl("http://127.0.0.1:19925", "fe80::1")).toBe("http://[fe80::1]:19925");
    expect(peerOpsUrl("https://flair.example", "node-b")).toBe("https://node-b");
    // An operations URL with a path: no node URL is built from it.
    expect(peerOpsUrl("https://flair.example:9925/ops", "node-b")).toBe("that node's operations API");
    for (const bad of [":", "node-b:9925", "x@evil.example", "node-b/path?q=1", "(a node whose name is not a host name or address)"]) {
      expect([bad, peerOpsUrl("https://flair.example:9925", bad)]).toEqual([bad, "that node's operations API"]);
    }
  });
});

describe("reportedRestartFailure and isCompletedJobMessage", () => {
  const done = (id: string) => `Successfully completed job: ${id}`;
  test("a completed job passes; a standalone job needs no node list", () => {
    expect(reportedRestartFailure({ status: "COMPLETE", message: done("j1") }, false, "j1")).toBeNull();
    expect(reportedRestartFailure({ status: "COMPLETE", message: done("j1"), result: { replicated: [{ node: "node-b", message: done("p1") }] } }, true, "j1")).toBeNull();
  });
  test("only Harper's completed-job message for the requested job id counts as completed", () => {
    expect(isCompletedJobMessage(done("j1"), "j1")).toBe(true);
    for (const message of [
      "Successfully completed job but restart failed",
      "Successfully completed job: j1 but restart failed",
      "Successfully completed job: j2",
      "Successfully completed job:j1",
      "successfully completed job: j1",
      " Successfully completed job: j1",
      "Successfully completed job: ",
      42,
      undefined,
    ]) {
      expect([message, isCompletedJobMessage(message, "j1")]).toEqual([message, false]);
      expect([message, reportedRestartFailure({ status: "COMPLETE", message }, false, "j1")]).toEqual([message, "the job completed with a message other than Harper's completed-job message for this job"]);
    }
  });
  test("a cluster node's own job counts as completed only with Harper's message and a plain-token id", () => {
    expect(isCompletedJobMessage(done("peer-job_1.2"))).toBe(true);
    for (const message of ["Successfully completed job but restart failed", "Successfully completed job: p1 but restart failed", "Successfully completed job: ", "connect ECONNREFUSED"]) {
      expect([message, isCompletedJobMessage(message)]).toEqual([message, false]);
    }
    expect(reportedRestartFailure({
      status: "COMPLETE",
      message: done("j1"),
      result: { replicated: [{ node: "node-b", message: done("p1") }, { node: "node-c", message: "Successfully completed job but restart failed" }] },
    }, true, "j1")).toBe("the job records these nodes without Harper's completed-job message: node-c");
  });
  test("names every reported failure, never echoing the job's text", () => {
    expect(reportedRestartFailure({ status: "ERROR", message: "private-value" }, false, "j1")).toBe("the job ended ERROR");
    expect(reportedRestartFailure({ status: "private-value" }, false, "j1")).toBe("the job ended with an unrecognized status");
    expect(reportedRestartFailure({ status: "COMPLETE", message: "private-value" }, false, "j1")).toBe("the job completed with a message other than Harper's completed-job message for this job");
    expect(reportedRestartFailure({ status: "COMPLETE", message: done("j1") }, true, "j1")).toBe("the replicated job's result lists no cluster nodes");
    const failed = reportedRestartFailure({
      status: "COMPLETE",
      message: done("j1"),
      result: { replicated: [{ node: "node-b", message: done("p1") }, { node: "node-c", message: "private-value" }, { node: ":", message: "x" }] },
    }, true, "j1");
    expect(failed).toBe("the job records these nodes without Harper's completed-job message: node-c, (a node whose name is not a host name or address)");
    expect(failed).not.toContain("private-value");
  });
});

describe("the report's closing sentences", () => {
  test("say that flair does not probe the listeners and how to confirm on a node", () => {
    expect(MQTT_OFF_REPORT_LIMIT).toBe(
      "Listeners stop when each node's workers restart; flair does not probe them. To confirm on a node, connect an MQTT client to its MQTT ports or WebSocket path.",
    );
  });
});
