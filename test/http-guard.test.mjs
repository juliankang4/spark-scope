import test from "node:test";
import assert from "node:assert/strict";
import { hostAllowed, hostName, hostRules, SECURITY_HEADERS } from "../lib/http-guard.mjs";
import { nodeErrorSummary, publicState } from "../lib/public-state.mjs";

test("Host headers are parsed into a plain name, with or without a port", () => {
  assert.equal(hostName("Spark-1.LOCAL:8787"), "spark-1.local");
  assert.equal(hostName("localhost."), "localhost");
  assert.equal(hostName("[::1]:8787"), "::1");
  assert.equal(hostName("192.168.1.20"), "192.168.1.20");
  assert.equal(hostName("evil.example/path"), null);
  assert.equal(hostName("a b"), null);
});

test("the dashboard answers to localhost, IP addresses and this machine's names, not to other domains", () => {
  const rules = hostRules({ bindHost: "0.0.0.0", machine: "rack-pi" });
  for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787", "100.64.0.7:8787", "rack-pi:8787", "rack-pi.local", "rack-pi.example-tailnet.ts.net", "app.localhost", undefined, ""]) {
    assert.equal(hostAllowed(host, rules), true, String(host));
  }
  // A rebinding page uses its own domain; another machine's Tailscale name is not this one.
  for (const host of ["attacker.example:8787", "rack-pi.attacker.example", "other-pi.example-tailnet.ts.net", "localhost.attacker.example", "evil.example/x"]) {
    assert.equal(hostAllowed(host, rules), false, host);
  }
});

test("SPARK_SCOPE_ALLOWED_HOSTS adds names and domains, and * turns the check off", () => {
  const rules = hostRules({ machine: "spark-1", allowed: "dash.example.org, .lab.example ," });
  assert.equal(hostAllowed("dash.example.org:8787", rules), true);
  assert.equal(hostAllowed("scope.lab.example", rules), true);
  assert.equal(hostAllowed("lab.example.evil", rules), false);
  assert.equal(hostAllowed("attacker.example", hostRules({ machine: "spark-1", allowed: "*" })), true);
});

test("responses carry a Content-Security-Policy that allows only this server's own resources and no framing", () => {
  const csp = SECURITY_HEADERS["Content-Security-Policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
});

test("the browser payload leaves out engine URLs, model paths, interface names and raw SSH errors", () => {
  const state = {
    status: "degraded",
    inference: { ok: true, engine: "vLLM", modelName: "example-model", baseUrl: "http://10.0.0.5:8000", modelRoot: "/models/example", generationTokensTotal: 5, outputTokensPerSecond: 12.5 },
    nodes: {
      1: { ok: true, hostname: "spark-1", network: { enp1s0f0np0: { up: true } }, gpu: { temperature: 50 }, error: null },
      2: { ok: false, error: "ssh: connect to host 10.0.0.6 port 22: No route to host" },
      3: null,
    },
  };
  const sent = publicState(state, { pollIntervals: { nodeMs: 5000, apiMs: 2000 } });
  assert.deepEqual(sent.inference, { ok: true, engine: "vLLM", modelName: "example-model", outputTokensPerSecond: 12.5 });
  assert.equal(sent.vllm, sent.inference);
  assert.equal(sent.nodes[1].network, undefined);
  assert.equal(sent.nodes[1].hostname, undefined);
  assert.equal(sent.nodes[1].gpu.temperature, 50);
  assert.equal(sent.nodes[2].error, "SSH connection failed");
  assert.equal(sent.nodes[3], null);
  assert.equal(sent.pollIntervals.apiMs, 2000);
  assert.doesNotMatch(JSON.stringify(sent), /10\.0\.0|enp1s0|\/models/);
  // The live state is not changed.
  assert.equal(state.inference.baseUrl, "http://10.0.0.5:8000");
});

test("failed node polls are summarised without addresses or account names", () => {
  assert.equal(nodeErrorSummary("spark-2: timed out after 4500 ms"), "timed out");
  assert.equal(nodeErrorSummary("admin@10.0.0.6: Permission denied (publickey)."), "SSH authentication failed");
  assert.equal(nodeErrorSummary("Host key verification failed."), "SSH host key check failed");
  assert.equal(nodeErrorSummary("ssh: Could not resolve hostname spark-9: Name or service not known"), "host name not found");
  assert.equal(nodeErrorSummary("ssh: connect to host 10.0.0.6 port 22: Connection refused"), "SSH connection failed");
  assert.equal(nodeErrorSummary("spawn ssh ENOENT"), "command not found");
  assert.equal(nodeErrorSummary("something else"), "collection failed");
  assert.equal(nodeErrorSummary(null), null);
});
