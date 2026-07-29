# TitanMCP — Server-Side Change Handoff (reconciled)

**Date:** 2026-07-28
**Requested by:** T.J. Schmitz (ERP Manager, NWPX)
**Origin:** Consistency review of the Titan Reporting assistant system prompt
**Status of this document:** the original review was written against the *system
prompt's description* of the tool contract, without access to this repository (see
its §6). This version reconciles it against the actual server at **v1.5.0**, folds in
findings from the live deployment on `rosie`, and records decisions taken since.

---

## 1. Context

TitanMCP is a read-only MCP server wrapping the Titan 3000 ERP API. Its consumer is
the "Titan Reporting assistant" — an LLM agent whose system prompt
(`docs/owui-system-prompt.md`) instructs it to answer business questions (bookings,
sales, production, AR/AP) exclusively from TitanMCP tool calls.

**Design principle (unchanged, and correct):** the prompt is advisory, the schema is
enforcement. A rule written as "NEVER call X for Y" is a rule the model can drop on
turn 40 of a long session. If the same rule can be expressed as a required parameter,
a validation error, or a tool description, it belongs in the server.

### Domain facts — verified against live data, not inherited from the prompt

- A sales order carries `orderDate` (entered) and `bookedDate` (actually booked).
  Confirmed in production: job **57535** was entered 2026-06-24 and booked 2026-07-20.
- The Titan API cannot filter on `bookedDate`, and `GET /SalesOrders` does not return
  it at all — nor `bookedValue`, `plantId`, or `customerId`, which come back null.
  Those fields exist only on `GET /SalesOrders/{jobNumber}`.
- TitanMCP therefore maintains a background index of every order. Live build:
  **57,892 orders in 163 s, 0 failures**, persisted to `/data/order-index.json`.
- `summarize_sales_orders` already refuses `DateBasis=booked` against
  `OrderDateStart`/`OrderDateEnd`. That guard is the model for WI-1.

### Deployment shape (relevant to sequencing)

`rosie` runs `titan-mcp` (container, port 8585) and `mcpo-pts`
(`ghcr.io/open-webui/mcpo:main`), which proxies `http://titan-mcp:8585/mcp` over
streamable-http and exposes it to Open WebUI as an OpenAPI tool server under `/titan`.

**Consequence:** mcpo builds its route table at startup. Any *new tool* requires
`docker restart mcpo-pts` **and** a re-save of the OWUI connection **and** a new chat
before the model can see it. Changes to existing tools' parameters or responses need
none of that. This cost one debugging cycle already; consider pointing OWUI at
`http://titan-mcp:8585/mcp` natively (OWUI ≥ 0.6.31) to remove mcpo from the loop.

---

## 2. Status summary

| Item | Original ask | Actual state at v1.5.0 | Remaining |
|---|---|---|---|
| WI-1 | `DateBasis` required | Optional; infers `booked` when a booked range is passed | **Revised (D-5):** default to `booked`, not required |
| WI-2 | Self-describing responses | ~60% shipped (`dateBasis`, `filters`, `coverage`) | `dateField`, `resolvedRange`, `measureFields`, `measureNote` |
| WI-3 | Server-side `Period` | Not started | Blocked on fiscal year **and timezone** |
| WI-4 | Customer lookup by name | Not possible as passthrough — API has no name filter | Build as cached in-process search |
| WI-5 | `list_job_statuses` | No such API endpoint exists | Derive from the index instead |
| WI-6 | Rules in tool descriptions | Mostly shipped | `summarize_invoices` / `list_invoices` only |
| WI-7 | Fail closed on partial coverage | Not started | Small, with three precisions below |
| F-1…F-4 | — | New findings, not in the original | See §4 |

---

## 3. Work items

### WI-1 — Default `DateBasis` to `booked` on `summarize_sales_orders`

**Premise correction.** `DateBasis` does not unconditionally default to `order`: it
infers `booked` when `BookedDateStart`/`BookedDateEnd` are present. The real trap is
narrower — a call passing `OrderDateStart` with no `DateBasis` silently returns an
entry-date figure that the agent will present as "sales."

**Change (revised — supersedes "make it required", see D-5).** Default `DateBasis` to
`booked`, which is the requested basis ~95% of the time and matches NWPX vocabulary,
where "sales" means booked. Behavior by call shape:

| Call shape | Result |
|---|---|
| Booked range, no `DateBasis` | `booked` — unchanged from today's inference |
| Order dates, no `DateBasis` | **Error.** Basis is `booked` but no booked range was given. Error names both exits: supply a booked range, or pass `DateBasis=order` for entry date |
| No dates at all | `booked`, unbounded — answered from the in-memory index at no API cost |
| `DateBasis=order` + order dates | Works as today |
| `DateBasis=order` + booked range | Error (mirror guard) |

**Guard relaxation required.** Today `DateBasis=booked` always demands a booked range.
Under the new default that breaks legitimate unbounded queries ("what has customer X
bought from us, by year"). The range becomes mandatory only when order dates were
*also* supplied — i.e. only to resolve genuine ambiguity.

**Error-text rewrite required.** The current message reads "`DateBasis=booked`
requires `BookedDateStart`/`End`", which is misleading when the caller never chose
booked — it did. It must name both exits.

**Behavior change to be aware of.** An all-time query with no dates shifts from
order-basis to booked-basis. Different number, no error. Judged correct — summing
`bookedValue` over orders bucketed by entry date was always an odd measure — but it
is a silent change, not a loud one.

**Prompt guidance stays explicit.** The prompt should still instruct the agent to pass
`DateBasis` on every call: defaulted in the schema so mistakes fail loud, explicit in
the prompt so intent is stated and the response echo confirms it.

**Sequencing correction (supersedes original §4).** The original says land this with
the prompt edit simultaneously. Unnecessary: the current server already *accepts* an
explicit `DateBasis`, so a prompt that always passes it works against both versions.
**Land the prompt first, let it soak, then land the server change.** The breaking
window disappears; no coordinated deploy.

---

### WI-2 — Self-describing responses

**Already shipped:** `dateBasis`, `filters` (the `filtersApplied` echo, including
`excludedPlants`), `coverage`, `skippedRecords`/`skippedNote`, `truncationNote`.

**Remaining:**

| Field | Contents |
|---|---|
| `dateBasis` | Normalize to `booked`｜`order`｜`invoice`｜`production`. Currently `summarize_sales_orders` puts a *field name* here and `list_booked_orders` puts prose — an inconsistency introduced in v1.5.0 |
| `dateField` | `bookedDate`｜`orderDate`｜`invoiceDate`｜`date` |
| `resolvedRange` | `{start, end}`, normalized `YYYY-MM-DD`, `null` when unbounded. An echo until `Period` lands; this is the field `Period` will populate |
| `measureFields` | Array of value fields summed (see decision D-1) |
| `measureNote` | Only when `DateBasis=order`, wording as originally drafted |

---

### WI-3 — Server-side relative-period resolution

Sound, and LLM date arithmetic is a real error source. Two blockers, not one:

1. **Fiscal vs. calendar year** (original §3 Q1) — still open, blocks `ytd` /
   `priorYear`.
2. **Timezone — not identified in the original.** "Last week is Sunday–Saturday" is
   undefined without one. The container sets no `TZ`, so it computes in UTC while
   NWPX books in Mountain. At week and month boundaries that is silently off by a day,
   which is worse than the model's arithmetic because it is consistent and invisible.
   `Period` needs `TITAN_TZ=America/Denver` (or equivalent) before it can be correct.

`get_server_time` (or a server-date field on every response) remains worth adding
regardless — it is independent of both blockers.

---

### WI-4 — Customer lookup by name

**Cannot be built as specified.** `GET /Customers` accepts only `Status` and
`Userfield1–5`; there is no name filter to pass through. Same for `GET /Products`
(`Type`, `ProductLine`, `Status`, `PartTypeID`, `Region`, `Group`, `Subgroup`).

**`list_vendors` already has a server-side `CompanyName` filter** — vendors need
nothing.

**Build instead:** `search_customers` / `search_products` as in-process substring
search over a cached catalog, reusing the `getProductCatalog` pattern in
`titanClient.ts` (full fetch, 30-minute TTL, single in-flight promise). The product
catalog is already cached for the aggregate tools, so `search_products` is nearly free.

**Note:** these are *new tools* — see the mcpo restart requirement in §1.

---

### WI-5 — `list_job_statuses`

**No job-status endpoint exists** among the 32 swagger GET paths.
`list_sales_order_types` exists and covers job *type*, a different axis.

**Derive it from the index instead**, which holds `jobStatus` for all 57,892 orders:
return distinct statuses with counts and a booked/unbooked split. That is strictly
more useful than a lookup table — it reflects actual usage — and the same query
settles open question Q5 (§5).

Also a *new tool*; see §1.

---

### WI-6 — Encode hard rules in tool descriptions

**Already shipped** for `list_sales_orders` (carries the prohibition nearly verbatim),
`summarize_sales_orders`, and `list_booked_orders`.

**Remaining:** `summarize_invoices` says what it is *for* but never that it is not a
sales substitute. Add to it and to `list_invoices`: billed/invoiced AR only, not a
substitute for sales or bookings, naming `list_booked_orders` and
`summarize_sales_orders` with `DateBasis=booked`.

---

### WI-7 — Fail closed on incomplete coverage

Endorsed, with three precisions:

1. **Trigger on `coverage.complete === false`, not `basis === "partialScan"`.**
   Order-basis queries during an index build return `partialScan` but are genuinely
   complete for their window (`complete: true`). Failing those breaks working queries
   for no reason.
2. **The error text must forbid the detour.** A hard error invites the model to fall
   back to order-date or invoice figures — the original bug. Name that explicitly,
   alongside the build progress and the `AllowPartial=true` escape hatch.
3. **Low urgency.** With `TITAN_ORDER_INDEX_PATH` set, `partialScan` now occurs only
   on a cold first build (~163 s, once). This is insurance, not a live fix.

Retain and keep surfacing `indexRefreshInProgress`, `skippedRecords`/`skippedNote`,
and `truncationNote` — already correct. `indexFloorNote` moves under D-2.

---

## 4. Findings not in the original review

### F-1 — `bookedValue: 0` on ~10% of booked orders

Orders carrying a `bookedDate` and real detail-line value return `bookedValue: 0` on
the header. Every bookings total is understated by an unknown amount.

**Owner: source database.** Confirmed 2026-07-28 as bad data in Titan, to be corrected
there rather than worked around in the server. No fallback-to-line-value logic will be
built — substituting a different measure would violate the same integrity rule this
document exists to enforce.

**Recommended server-side support while the data is cleaned:** report
`ordersWithZeroBookedValue` (count) on booked responses, so the agent can disclose how
much of a total is affected. Harmless once the data is fixed. *Awaiting decision.*

### F-2 — `estimatedValue` is dead

Zero on every row observed, `null` in raw payloads. Currently summed and reported,
which reads as "we estimated nothing" rather than "not tracked." See D-3.

This also answers Q4 and probably kills a promise the prompt makes — see Q2.

### F-3 — `TITAN_EXCLUDED_PLANTS` silently narrows booked totals

Live config excludes **CO, LV, PM, TR**. The booked tools honor it and echo it in
`filters`, but `coverage.complete: true` refers to *index* coverage, not *plant*
coverage. A figure labeled complete that quietly omits four plants is precisely the
failure class this review exists to catch. Addressed by D-2.

Worked example: the verified 2026-07-19→25 result (**32 orders, $462,581.25**) is not
a company-wide number.

### F-4 — Timezone

Folded into WI-3 above.

---

## 5. Open questions

**Answered:**

- **Q4 — order-basis value field.** `bookedValue` is effectively the only monetary
  field on a sales order. The header carries `bookedValue` and `estimatedValue`; the
  latter is unpopulated (F-2). `measureNote` stands as drafted, with the F-1 caveat.
- **Q2 — footage and bid value.** `yards` exists on order detail lines and production
  details and is already summed. "Bid value" most plausibly maps to `estimatedValue`,
  which is empty — so the prompt is promising a figure the data cannot produce. The
  honest fix is striking it from the prompt, not building a tool that returns zeros.
  *Needs T.J. to confirm the mapping before the prompt is edited.*

**Still open:**

- **Q1 — fiscal vs. calendar year, and fiscal year start.** Blocks `ytd` /
  `priorYear`. Now joined by the timezone question (F-4).
- **Q3 — backlog (booked, not yet shipped).** Header carries `percentComplete`,
  `completedDate`, `jobStatus`, so booked-minus-delivered is plausibly derivable, but
  it depends on whether invoices carry a job reference. Worth a spike before promising
  it.
- **Q5 — quotes / unbooked pipeline carry no `bookedDate`.** Consistent with
  everything observed, not yet proven. Settled in one query by the WI-5 crosstab.

---

## 6. Decisions taken

- **D-1 — `measureFields` (array), not `measureField` (singular).**
  `summarize_invoices` sums subtotal/tax/total and `summarize_production` sums five
  fields; a singular field would force a lie. *Accepted 2026-07-28.*

- **D-2 — `coverage.complete` means index coverage only.**
  Permanent, disclosed narrowing — excluded plants (F-3) and the
  `TITAN_ORDER_INDEX_MIN_ORDER_DATE` floor, which today wrongly sets
  `complete: false` — moves to `coverage.scopeNote` / `coverage.plantsExcluded`.
  Without this, a deployment that sets the floor reports `complete: false` forever,
  the flag stops meaning anything, and WI-7 fails closed permanently.
  *Accepted 2026-07-28.*

- **D-3 — `estimatedValue` is omitted when zero across all matches**, and included
  with a note when any match is non-zero. Keeps indexing it at no cost, avoids a
  misleading `$0`, does not hide data if it turns out to be populated somewhere.
  *Accepted 2026-07-28.*

- **D-4 — No line-value fallback for F-1.** Source-data fix, not a server workaround.
  *Accepted 2026-07-28.*

- **D-5 — `DateBasis` defaults to `booked` rather than being required.**
  Booked is the requested basis ~95% of the time, so a required parameter taxes every
  call to catch a rare mistake. The default achieves the same enforcement — a call
  passing order dates without a basis now errors instead of silently returning an
  entry-date figure — while removing a parameter from the common path and a rule from
  the prompt. Requires the guard relaxation and error-text rewrite in WI-1.
  *Accepted 2026-07-28, superseding the original WI-1.*

---

## 7. Sequencing

1. ~~`bookedValue: 0` root cause~~ → F-1, owned by the source DB.
2. **WI-2 delta + D-2 coverage split + D-3.** Small.
3. **WI-1**, prompt first, then server. Small.
4. **WI-3**, once fiscal year *and* timezone are answered.
5. **WI-4 / WI-5** via the cached-catalog and index patterns. New tools → mcpo restart.
6. **WI-6 delta + WI-7.** Small.

Items 2, 3 and 6 touch `src/aggregates.ts` mostly, with small changes to
`src/orderIndex.ts` for the coverage/scope split, plus `docs/owui-system-prompt.md`,
`README.md`, a version bump to 1.6.0, and a smoke assertion that a missing
`DateBasis` errors. No new tools, so the tool count stays 37 and mcpo needs no
restart — OWUI still needs the prompt re-pasted for WI-1.

Work on a branch and open a PR rather than editing the running server in place.

---

## 8. Explicitly out of scope

Prompt-side fixes, tracked separately in `docs/owui-system-prompt.md`:

- ~~Correcting the claim that `get_sales_order` is the only place `bookedDate`
  appears~~ — already corrected in the current prompt.
- Adding a pipeline/quote branch to the date-basis guidance (blocked on Q5).
- Extending the vocabulary map (revenue, backlog, awarded, won, shipped, quoted).
- Relocating the "last week"/"last month" definitions out of the vocabulary→basis list
  (superseded if WI-3 lands — the server owns the definitions then).
- Documenting what `list_sales_orders` is *for*, not just what it is forbidden for.
- Striking "bid value" from the tool-usage mandate, pending Q2.
