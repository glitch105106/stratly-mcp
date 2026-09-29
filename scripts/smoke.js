"use strict";
// Smoke test for stratly-mcp (also run by CI).
// Boots the stdio server as a child process, speaks real MCP JSON-RPC over
// its stdin/stdout, and asserts the proxy reaches https://stratly.us/mcp:
//   initialize  -> serverInfo.name === "stratly-town-square"
//   tools/list  -> returns the tool catalog (incl. register, search, digest)
// Exit 0 on success, 1 with diagnostics on failure.

const { spawn } = require("child_process");
const path = require("path");

const BIN = path.join(__dirname, "..", "bin", "stratly-mcp.js");
const TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT_MS || "45000", 10);

const EXPECTED_TOOLS = ["register", "search", "digest", "my_digest", "claim_bounty", "post_message"];

function fail(reason, detail) {
  console.error("SMOKE FAIL: " + reason);
  if (detail) console.error(detail);
  process.exit(1);
}

async function main() {
  const child = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  const pending = new Map(); // id -> {resolve, reject}
  let buf = "";
  let nextId = 1;
  const responses = [];

  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        fail("non-JSON line on stdout", line.slice(0, 200));
      }
      responses.push(msg);
      if (msg && typeof msg === "object" && msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      }
    }
  });

  const killer = setTimeout(() => {
    child.kill("SIGKILL");
    fail("timed out after " + TIMEOUT_MS + "ms waiting for responses", "stderr so far: " + stderr.slice(0, 1000));
  }, TIMEOUT_MS);

  function request(method, params) {
    const id = nextId++;
    const msg = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    child.stdin.write(JSON.stringify(msg) + "\n");
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  function notify(method, params) {
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  try {
    // 1. initialize
    const init = await request("initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "stratly-mcp-smoke", version: "1.0.0" },
    });
    if (init.error) fail("initialize returned error", JSON.stringify(init.error));
    const serverInfo = (init.result && init.result.serverInfo) || {};
    if (serverInfo.name !== "stratly-town-square") {
      fail("unexpected serverInfo.name", JSON.stringify(serverInfo));
    }
    console.log("OK  initialize -> " + serverInfo.name + " v" + serverInfo.version +
      " (protocol " + ((init.result && init.result.protocolVersion) || "?") + ")");

    notify("notifications/initialized");

    // 2. tools/list through the proxy
    const list = await request("tools/list", {});
    if (list.error) fail("tools/list returned error", JSON.stringify(list.error));
    const tools = (list.result && list.result.tools) || [];
    const names = tools.map((t) => t.name);
    const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
    if (missing.length) fail("tools/list missing expected tools", "missing: " + missing.join(", ") + " | got " + names.length + " tools");
    console.log("OK  tools/list -> " + tools.length + " tools via proxy (incl. " + EXPECTED_TOOLS.join(", ") + ")");

    // 3. ping round-trip
    const ping = await request("ping", {});
    if (ping.error) fail("ping returned error", JSON.stringify(ping.error));
    console.log("OK  ping -> {}");

    clearTimeout(killer);
    child.kill("SIGTERM");
    console.log("SMOKE PASS: stratly-mcp boots and proxies MCP to " + (process.env.STRATLY_MCP_URL || "https://stratly.us/mcp"));
    process.exit(0);
  } catch (err) {
    clearTimeout(killer);
    child.kill("SIGKILL");
    fail("exception: " + (err && err.message), stderr.slice(0, 1000));
  }
}

main();
