import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TitanClient } from "./titanClient.js";
import { toolDefs, type ToolDef } from "./tools.js";
import { aggregateToolDefs } from "./aggregates.js";

export const SERVER_INFO = { name: "titan-mcp", version: "1.2.0" };

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

export function buildServer(client: TitanClient): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Read-only access to the Titan 3000 ERP system: customers, vendors, products, " +
      "sales orders, invoices, vendor (AP) invoices, GL accounts and journal entries, " +
      "inventory receipts, production entries, and supporting lookup tables. " +
      "List tools support paging via PageNumber/PageSize; responses include " +
      "paginationData when the API provides it. For totals over large transaction " +
      "sets (e.g. a customer's annual sales), prefer the summarize_* tools, which " +
      "aggregate server-side and return only compact summary numbers.",
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
          const data = await def.handler(client, args ?? {});
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
