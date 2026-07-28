#!/usr/bin/env node
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { TitanClient } from "./titanClient.js";
import { OrderIndex } from "./orderIndex.js";
import { buildServer } from "./server.js";

async function runStdio(client: TitanClient, orderIndex: OrderIndex): Promise<void> {
  const server = buildServer(client, orderIndex);
  await server.connect(new StdioServerTransport());
  console.error("titan-mcp running on stdio");
}

async function runHttp(client: TitanClient, orderIndex: OrderIndex): Promise<void> {
  const port = Number(process.env.TITAN_MCP_PORT ?? 8585);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TITAN_MCP_PORT: ${process.env.TITAN_MCP_PORT}`);
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, server: "titan-mcp", orderIndex: orderIndex.status() });
  });

  // Stateless mode: a fresh server + transport per request, no session tracking.
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer(client, orderIndex);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling /mcp request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. This server is stateless; use POST /mcp.",
      },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(port, "0.0.0.0", () => {
    console.error(`titan-mcp listening on http://0.0.0.0:${port}/mcp`);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new TitanClient(config);
  const orderIndex = new OrderIndex(client, config.orderIndex);

  if (process.argv.includes("--stdio")) {
    await runStdio(client, orderIndex);
  } else {
    await runHttp(client, orderIndex);
  }

  // Start warming the booked-date index immediately (and keep it fresh) so the
  // first booked-date question is answered from memory rather than by a scan.
  if (config.orderIndex.enabled) {
    orderIndex.kick();
    setInterval(() => orderIndex.kick(), 60_000).unref();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
