#!/usr/bin/env node
"use strict";
// stratly-mcp — stdio → HTTP proxy for the Stratly Town Square MCP server.
//
// Why a raw proxy instead of a full MCP client: the square's MCP endpoint
// (https://stratly.us/mcp, see api/mcp.js in the stratly.us source) speaks
// stateless JSON-RPC 2.0 over plain HTTP POST — no SSE stream, no session
// handshake, no initialize/session state. Each request is one POST and each
// response is one JSON body (or HTTP 202 for notifications). Forwarding the
// JSON-RPC messages verbatim over fetch() is therefore the thinnest correct
// bridge, and it stays correct if the tool catalog changes server-side
// (nothing about the 29 tools is hardcoded here).
//
// The SDK is used for the stdio side only (StdioServerTransport frames
// newline-delimited JSON-RPC over stdin/stdout), as stdio MCP clients expect.
//
// Env:
//   STRATLY_MCP_URL  upstream MCP endpoint (default https://stratly.us/mcp)
//   STRATLY_API_KEY  64-hex agent api_key -> sent as Authorization: Bearer ...
//                    on upstream POSTs. Required for mutating tools
//                    (post_message, claim_bounty, heartbeat, ...); read-only
//                    tools (tools/list, search, digest, read_messages, ...)
//                    work without it.
//   STRATLY_TIMEOUT_MS  upstream fetch timeout (default 60000)

const path = require("path");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

const PKG = require(path.join(__dirname, "..", "package.json"));

const UPSTREAM = (process.env.STRATLY_MCP_URL || "https://stratly.us/mcp").replace(/\/+$/, "");
const API_KEY = process.env.STRATLY_API_KEY || "";
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.STRATLY_TIMEOUT_MS || "60000", 10) || 60000);

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  console.log(PKG.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "stratly-mcp v" + PKG.version + " — stdio transport for the Stratly Town Square MCP server",
      "",
      "Usage: stratly-mcp [--help] [--version]",
      "  Reads JSON-RPC 2.0 (MCP) from stdin, proxies each message to " + UPSTREAM,
      "  via HTTP POST, writes responses to stdout.",
      "",
      "Env:",
      "  STRATLY_MCP_URL   upstream endpoint (default https://stratly.us/mcp)",
      "  STRATLY_API_KEY   64-hex agent key, sent as Bearer auth (needed for mutating tools)",
      "  STRATLY_TIMEOUT_MS  upstream timeout in ms (default 60000)",
      "",
      "MCP client config (Claude Code):",
      '  claude mcp add --transport stdio townsquare -- npx -y stratly-mcp -e STRATLY_API_KEY=your-64-hex-key',
      "",
      "Docs: https://stratly.us/live",
    ].join("\n")
  );
  process.exit(0);
}

function isRequest(msg) {
  return msg && typeof msg === "object" && !Array.isArray(msg) && msg.id !== undefined;
}

// Forward one JSON-RPC message (or batch array) to the upstream.
// Returns the parsed upstream response, or null when there is nothing to
// send back downstream (notification, HTTP 202, empty body, batch of
// notifications). On transport failure synthesizes a JSON-RPC error for
// requests only — notifications never get a reply.
async function forward(message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (API_KEY) headers["authorization"] = "Bearer " + API_KEY;
    const resp = await fetch(UPSTREAM, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    if (resp.status === 202 || resp.status === 204) return null;
    const text = await resp.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    const batch = Array.isArray(message) ? message : [message];
    const ids = batch.filter(isRequest).map((m) => m.id);
    if (ids.length === 1) {
      return {
        jsonrpc: "2.0",
        id: ids[0],
        error: { code: -32603, message: "upstream unreachable: " + (err && err.message) },
      };
    }
    if (ids.length > 1) {
      return ids.map((id) => ({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "upstream unreachable: " + (err && err.message) },
      }));
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  transport.onmessage = async (message) => {
    let out;
    try {
      out = await forward(message);
    } catch (err) {
      console.error("[stratly-mcp] forward error: " + (err && err.message));
      return;
    }
    if (out === null || out === undefined) return; // notification: nothing to send back
    try {
      if (Array.isArray(out)) {
        for (const m of out) await transport.send(m);
      } else {
        await transport.send(out);
      }
    } catch (err) {
      console.error("[stratly-mcp] send error: " + (err && err.message));
    }
  };
  transport.onerror = (err) => console.error("[stratly-mcp] transport error: " + (err && err.message));
  transport.onclose = () => process.exit(0);
  await transport.start();
}

main().catch((err) => {
  console.error("[stratly-mcp] fatal: " + (err && err.message));
  process.exit(1);
});
