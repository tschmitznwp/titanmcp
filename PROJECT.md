# Titan MCP — Project Charter

MCP server exposing the Titan 3000 Web API (V1) as read-only tools for Open WebUI.

## 1. What is the one thing this must do?

Let Open WebUI query live Titan 3000 data (customers, vendors, invoices, sales
orders, GL, production, inventory, and supporting lookup tables) through MCP
tools, authenticated with the Titan `X-App-Id` / `X-Api-Key` headers.

## 2. What would be wrong if we shipped "working" software without it?

- **All 32 GET endpoints covered** — a subset is not done. Full list
  (list/get pairs are two endpoints each):
  currencies, customers (list/get), GL accounts, GL journal entries (list/get),
  inventory receipts (list/get), invoices (list/get), lines of business,
  plants, PO styles, price levels, production entries (list/get), products,
  regions, sales orders (list/get), sales order details (list/get), sales
  order structures (list/get), sales order types, sales reps, tax codes,
  terms, vendor invoices (list/get), vendors (list/get).
- **Each tool exposes the endpoint's real filter and paging parameters**
  (PageNumber/PageSize plus endpoint-specific filters), not just bare calls.
- **Envelope handling** — responses are unwrapped (`result` +
  `paginationData`); API `errorMessage`/`errors` and HTTP failures surface as
  readable tool errors, never silent empty results.
- **Works with Open WebUI** — Streamable HTTP transport, connectable from
  OWUI's External Tools settings.

## 3. What is explicitly off-limits as a workaround?

- **No write tools.** POST/PUT/upload endpoints are NOT exposed in v1, period.
- **No hardcoded credentials or base URL** — config comes only from
  environment variables (`TITAN_BASE_URL`, `TITAN_APP_ID`, `TITAN_API_KEY`).
  Secrets are never committed to the repo.
- **No "edit the source to change the server"** — pointing at a different
  Titan instance must be a config change only.
- **No silently dropping endpoints** that prove awkward — if one can't be
  implemented as specified, stop and raise it.

## 4. Deployment target and backup location

- **Deployment:** Node 20+ service (Docker image provided) running on a host
  that can reach `http://titanapi-dev.nwpipe.com` and is reachable by Open
  WebUI. Not runnable end-to-end from the dev PC (Titan API not reachable
  here). OWUI ≥ 0.6.31 connects natively via Streamable HTTP; older OWUI
  would need the `mcpo` proxy.
- **Backup:** this git repository (initialized 2026-07-23).

## 5. How will we verify it is done?

1. `npm run build` completes with no TypeScript errors.
2. Server starts in both HTTP and `--stdio` modes.
3. An MCP client (scripted, stdio and HTTP modes) lists all 32 tools with
   correct input schemas.
4. Automated check: every GET path in the swagger spec has a matching tool.
5. Error-path check against an unreachable/wrong URL returns a clear error.
6. **User smoke test** (only step requiring the real network): deploy near
   OWUI, connect from OWUI External Tools, run e.g. `list_plants` and
   `list_currencies` and confirm real data returns.

## Stack

TypeScript, official `@modelcontextprotocol/sdk`, Streamable HTTP transport
(+ stdio flag for testing), Dockerfile for deployment.
