# titan-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for the **Titan 3000 Web API (V1)**,
built for use with **Open WebUI**. Exposes all 32 GET endpoints of the API as MCP tools,
plus derived read-only summary tools; no write (POST/PUT/upload) operations are included.

## Tools

| Area | Tools |
| --- | --- |
| Customers | `list_customers`, `get_customer` |
| Vendors | `list_vendors`, `get_vendor` |
| Products | `list_products` |
| Sales orders | `list_sales_orders`, `get_sales_order`, `list_sales_order_details`, `get_sales_order_detail`, `list_sales_order_structures`, `get_sales_order_structure` |
| Invoices (AR) | `list_invoices`, `get_invoice` |
| Vendor invoices (AP) | `list_vendor_invoices`, `get_vendor_invoice` |
| General ledger | `list_gl_accounts`, `list_gl_journal_entries`, `get_gl_journal_entry` |
| Inventory | `list_inventory_receipts`, `get_inventory_receipt` |
| Production | `list_production_entries`, `get_production_entry` |
| Lookups | `list_currencies`, `list_plants`, `list_regions`, `list_price_levels`, `list_tax_codes`, `list_terms`, `list_sales_reps`, `list_sales_order_types`, `list_po_styles`, `list_lines_of_business` |
| Summaries | `summarize_sales_orders`, `summarize_invoices`, `summarize_production` — aggregate totals (with optional grouping) computed server-side so large transaction sets never reach the model |
| Bookings | `list_booked_orders`, `get_order_index_status` — orders filtered by **`bookedDate`**, which the Titan API cannot filter on (see below) |

List tools accept the API's filter parameters plus `PageNumber`/`PageSize`; responses
include the API's `paginationData` when provided.

## Booked-date queries

A Titan sales order has two different dates, often months or years apart:

- **`orderDate`** — when the order was entered. The only date the API can filter on.
- **`bookedDate`** — when the order was actually booked. **No API filter exists for it**,
  and it is not even returned by the `/SalesOrders` list endpoint — only by the
  per-order `GET /SalesOrders/{jobNumber}`.

Asking the API for "orders booked 19–25 July" is therefore impossible in one call:
answering it means reading every sales order (57k+) individually. This server does
that once in the background and keeps the result in memory:

- `list_booked_orders` — the orders whose `bookedDate` is in a range, with each
  order's booked value, customer, plant, rep and status, plus count and summed
  `bookedValue` for the whole match.
- `summarize_sales_orders` with `DateBasis=booked` + `BookedDateStart`/`BookedDateEnd`
  — the same set as totals, groupable by month, customer, plant, rep or product.
  `DateBasis=booked` **refuses** to run off `OrderDateStart`/`OrderDateEnd`, so a
  booking question can't silently be answered with order-entry dates.
- `get_order_index_status` — build state and progress.

The index builds at startup (roughly 57k single-order fetches at
`TITAN_ORDER_INDEX_CONCURRENCY` in parallel), refreshes incrementally every
`TITAN_ORDER_INDEX_REFRESH_MINUTES`, and rebuilds fully every
`TITAN_ORDER_INDEX_REBUILD_HOURS`. Set `TITAN_ORDER_INDEX_PATH` to a file on a
mounted volume to survive restarts without re-scanning.

Until the first build finishes, booked-date tools fall back to a bounded scan
(orders entered within a year before the requested window) and mark the result
`coverage.basis = "partialScan"` with an explicit `incompleteWarning`. Every
response carries a `coverage` object — check it before treating a number as final.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Required | Description |
| --- | --- | --- |
| `TITAN_BASE_URL` | yes | Base URL of the Titan API, e.g. `http://titanapi-dev.nwpipe.com` |
| `TITAN_APP_ID` | yes | Sent as the `X-App-Id` header |
| `TITAN_API_KEY` | yes | Sent as the `X-Api-Key` header |
| `TITAN_MCP_PORT` | no | HTTP port (default `8585`) |
| `TITAN_EXCLUDED_PLANTS` | no | Comma-separated plant IDs excluded from the `summarize_*` and booked-order tools (e.g. inactive plants) |
| `TITAN_ORDER_INDEX` | no | `false` disables the booked-date index (default on) |
| `TITAN_ORDER_INDEX_CONCURRENCY` | no | Parallel order fetches while indexing (default `12`) |
| `TITAN_ORDER_INDEX_REFRESH_MINUTES` | no | Incremental refresh interval (default `15`) |
| `TITAN_ORDER_INDEX_REBUILD_HOURS` | no | Full rebuild interval (default `24`) |
| `TITAN_ORDER_INDEX_PATH` | no | File to persist the index to, so restarts skip the full scan (e.g. `/data/order-index.json`) |
| `TITAN_ORDER_INDEX_MIN_ORDER_DATE` | no | `YYYY-MM-DD`; skip orders *entered* before this date to shrink the build. Responses then carry an `indexFloorNote` and `complete: false` |

## Running

### Docker (recommended — run it on a host that can reach the Titan API)

A prebuilt image is published to GitHub Container Registry on every push to
`main` (see `.github/workflows/docker.yml`):

```bash
docker volume create titan-mcp-data
docker run -d --name titan-mcp -p 8585:8585 \
  -v titan-mcp-data:/data \
  -e TITAN_BASE_URL=http://titanapi-dev.nwpipe.com \
  -e TITAN_APP_ID=<your app id> \
  -e TITAN_API_KEY=<your api key> \
  -e TITAN_ORDER_INDEX_PATH=/data/order-index.json \
  ghcr.io/tschmitznwp/titanmcp:latest
```

The volume is what keeps the booked-date index across restarts; without it the
container re-reads all ~58k orders every time it starts. Watch the first build
with `docker logs -f titan-mcp` (lines tagged `[order-index]`), or poll
`curl -s localhost:8585/healthz`.

Or build it yourself:

```bash
docker build -t titan-mcp .
docker run -d --name titan-mcp -p 8585:8585 \
  -e TITAN_BASE_URL=http://titanapi-dev.nwpipe.com \
  -e TITAN_APP_ID=<your app id> \
  -e TITAN_API_KEY=<your api key> \
  titan-mcp
```

### Node directly

```bash
npm ci
npm run build
# HTTP mode (for Open WebUI):
npm start
# stdio mode (for MCP Inspector / Claude Code):
npm run start:stdio
```

The MCP endpoint is `http://<host>:8585/mcp` (Streamable HTTP, stateless).
A health check is available at `http://<host>:8585/healthz`.

## Connecting Open WebUI

Requires Open WebUI **v0.6.31 or newer** (native MCP Streamable HTTP support):

1. Open WebUI → **Admin Panel → Settings → External Tools** (or per-user
   **Settings → Tools**).
2. Add a connection with type **MCP (Streamable HTTP)**.
3. URL: `http://<host-running-titan-mcp>:8585/mcp` (no auth header needed —
   Titan credentials live in the titan-mcp container, not in OWUI).
4. Save, then enable the tool server in a chat and ask something like
   *"List the plants in Titan."*

If your Open WebUI is older than 0.6.31, either upgrade or run this server in
stdio mode behind [mcpo](https://github.com/open-webui/mcpo):
`uvx mcpo --port 8600 -- node dist/index.js --stdio` and add it in OWUI as an
OpenAPI tool server instead.

## Verification

```bash
npm run build    # TypeScript compiles clean
npm run verify   # every swagger GET path has a matching tool
npm run smoke    # starts the server in stdio + HTTP modes, lists tools,
                 # and verifies the unreachable-API error path
```

The live smoke test (real data from Titan) must be run from a network that can
reach the Titan API — see `PROJECT.md` §5.

## Security notes

- Strictly read-only: only GET endpoints are implemented.
- Credentials come from the environment and are never logged or committed.
- The `/mcp` endpoint itself has no authentication; run it on a trusted
  network segment reachable by Open WebUI, not exposed to the internet.
