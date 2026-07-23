// Charter checks 5.2/5.3 (HTTP side): server starts in Streamable HTTP mode and
// an MCP client can initialize and list all tools over POST /mcp.
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const EXPECTED_TOOL_COUNT = 35;
const PORT = 8599;

const child = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    TITAN_BASE_URL: "http://127.0.0.1:59999",
    TITAN_APP_ID: "smoke-test",
    TITAN_API_KEY: "smoke-test",
    TITAN_MCP_PORT: String(PORT),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  if (stderr) console.error("server stderr:", stderr);
  child.kill();
  process.exit(1);
}

// Wait for /healthz to come up.
let healthy = false;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (!healthy) fail("server did not become healthy within 10s");

try {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
  const client = new Client({ name: "titan-mcp-smoke-http", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (tools.length !== EXPECTED_TOOL_COUNT) {
    fail(`expected ${EXPECTED_TOOL_COUNT} tools over HTTP, got ${tools.length}`);
  }
  await client.close();
  console.log(`HTTP smoke OK: ${tools.length} tools listed via Streamable HTTP on port ${PORT}.`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  child.kill();
}


