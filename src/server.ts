import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TitanClient } from "./titanClient.js";
import { toolDefs, type ToolDef } from "./tools.js";
import { aggregateToolDefs, type ToolContext } from "./aggregates.js";
import type { OrderIndex } from "./orderIndex.js";

export const SERVER_INFO = { name: "titan-mcp", version: "1.5.0" };

function splitArgs(
  def: ToolDef,
  args: Record<string, unknown>
): { path: string; query: Record<string, unknown> } {
  let path = def.path;
  const pathParams = new Set(def.pathParams ?? []);
  for (const param of pathParams) {
    const value = args[param];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required path parameter: ${param}`);
    }
    path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
  }
  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!pathParams.has(key)) query[key] = value;
  }
  return { path, query };
}

export function buildServer(client: TitanClient, orderIndex: OrderIndex): McpServer {
  const ctx: ToolContext = { client, orderIndex };
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Read-only access to the Titan 3000 ERP system: customers, vendors, products, " +
      "sales orders, invoices, vendor (AP) invoices, GL accounts and journal entries, " +
      "inventory receipts, production entries, and supporting lookup tables. " +
      "List tools support paging via PageNumber/PageSize; responses include " +
      "paginationData when the API provides it. For totals over large transaction " +
      "sets (e.g. a customer's annual sales), prefer the summarize_* tools, which " +
      "aggregate server-side and return only compact summary numbers. " +
      "SALES ORDER DATES: an order has an orderDate (when it was entered) and a " +
      "separate bookedDate (when it was actually booked); they are often months or " +
      "years apart. The Titan API can only filter on orderDate, so questions about " +
      "what was BOOKED in a period must use list_booked_orders, or " +
      "summarize_sales_orders with DateBasis=booked — never list_sales_orders or an " +
      "OrderDate filter. Those booked-date tools report a coverage object; if it says " +
      "basis=partialScan the answer may be incomplete and that caveat must be passed " +
      "on to the user.",
  });

  for (const def of toolDefs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.params,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const { path, query } = splitArgs(def, args ?? {});
          const data = await client.get(path, query);
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              { type: "text", text: err instanceof Error ? err.message : String(err) },
            ],
          };
        }
      }
    );
  }

  for (const def of aggregateToolDefs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.params,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const data = await def.handler(ctx, args ?? {});
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              { type: "text", text: err instanceof Error ? err.message : String(err) },
            ],
          };
        }
      }
    );
  }

  return server;
}



