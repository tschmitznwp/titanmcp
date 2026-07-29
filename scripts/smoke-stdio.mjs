// Charter checks 5.2/5.3/5.5 (stdio side): server starts on stdio, lists all
// tools with input schemas, and returns a clear error when the API is unreachable.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOL_COUNT = 41;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js", "--stdio"],
  env: {
    ...process.env,
    // Deliberately unreachable: exercises the error path (charter 5.5).
    TITAN_BASE_URL: "http://127.0.0.1:59999",
    TITAN_APP_ID: "smoke-test",
    TITAN_API_KEY: "smoke-test",
    // No API here, so the background order index would only retry and log.
    TITAN_ORDER_INDEX: "false",
  },
});

const client = new Client({ name: "titan-mcp-smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
if (tools.length !== EXPECTED_TOOL_COUNT) {
  console.error(`FAIL: expected ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}`);
  process.exit(1);
}
const missingSchemas = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== "object");
if (missingSchemas.length > 0) {
  console.error(`FAIL: tools without object input schema: ${missingSchemas.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

const result = await client.callTool({ name: "list_plants", arguments: {} });
const text = result.content?.[0]?.text ?? "";
if (result.isError !== true || !text.includes("Could not reach the Titan API")) {
  console.error("FAIL: expected a clear unreachable-API error from list_plants, got:", JSON.stringify(result));
  process.exit(1);
}

// Booked-date path: reaches the API through the index fallback, so it must also
// surface a readable error rather than an empty result.
const booked = await client.callTool({
  name: "list_booked_orders",
  arguments: { BookedDateStart: "2026-07-19", BookedDateEnd: "2026-07-25" },
});
const bookedText = booked.content?.[0]?.text ?? "";
if (booked.isError !== true || !bookedText.includes("Could not reach the Titan API")) {
  console.error(
    "FAIL: expected a clear unreachable-API error from list_booked_orders, got:",
    JSON.stringify(booked)
  );
  process.exit(1);
}

// Bad input must be rejected before any API call.
const badRange = await client.callTool({
  name: "list_booked_orders",
  arguments: { BookedDateStart: "2026-07-25", BookedDateEnd: "2026-07-19" },
});
if (badRange.isError !== true || !(badRange.content?.[0]?.text ?? "").includes("is after")) {
  console.error("FAIL: expected an inverted-range error, got:", JSON.stringify(badRange));
  process.exit(1);
}

// summarize_invoices must carry the "not a sales substitute" prohibition (WI-6),
// since that rule reaches the model on every call rather than only via the prompt.
const invoiceTool = tools.find((t) => t.name === "summarize_invoices");
if (!/not a substitute/i.test(invoiceTool?.description ?? "")) {
  console.error("FAIL: summarize_invoices description is missing the sales-substitute prohibition");
  process.exit(1);
}

// Both booked-date tools must expose AllowPartial (WI-7 fail-closed escape hatch).
for (const name of ["list_booked_orders", "summarize_sales_orders"]) {
  const tool = tools.find((t) => t.name === name);
  if (!tool?.inputSchema?.properties?.AllowPartial) {
    console.error(`FAIL: ${name} is missing the AllowPartial parameter`);
    process.exit(1);
  }
}

// Order-entry dates on a booked basis (including the default) must be refused
// rather than silently answered from the wrong date — the bug this exists to stop.
const wrongBasis = await client.callTool({
  name: "summarize_sales_orders",
  arguments: { OrderDateStart: "2026-07-19", OrderDateEnd: "2026-07-25" },
});
if (
  wrongBasis.isError !== true ||
  !/date basis is 'booked'/i.test(wrongBasis.content?.[0]?.text ?? "")
) {
  console.error(
    "FAIL: expected order dates under the default booked basis to error, got:",
    JSON.stringify(wrongBasis)
  );
  process.exit(1);
}

// Period and explicit dates are mutually exclusive (WI-3).
const bothRanges = await client.callTool({
  name: "list_booked_orders",
  arguments: { Period: "lastWeek", BookedDateStart: "2026-07-19", BookedDateEnd: "2026-07-25" },
});
if (
  bothRanges.isError !== true ||
  !/mutually exclusive/i.test(bothRanges.content?.[0]?.text ?? "")
) {
  console.error("FAIL: expected Period + explicit dates to be rejected, got:", JSON.stringify(bothRanges));
  process.exit(1);
}

// get_server_time needs no API access, so it must return real data even here —
// this is the end-to-end check that period resolution is wired to the tools.
const serverTime = await client.callTool({ name: "get_server_time", arguments: {} });
const timePayload = JSON.parse(serverTime.content?.[0]?.text ?? "{}");
if (
  serverTime.isError === true ||
  !/^\d{4}-\d{2}-\d{2}$/.test(timePayload.today ?? "") ||
  timePayload.timeZone !== "America/Denver" ||
  !/^\d{4}-\d{2}-\d{2}$/.test(timePayload.periods?.lastWeek?.start ?? "")
) {
  console.error("FAIL: get_server_time did not return resolved periods, got:", JSON.stringify(serverTime));
  process.exit(1);
}

await client.close();
console.log(
  `stdio smoke OK: ${tools.length} tools listed, unreachable-API and booked-date ` +
    "argument error paths verified."
);


