// Charter check 5.4: every GET path in the Titan swagger spec has a matching tool.
// Ground truth below is the list of GET paths extracted from the swagger document
// (Titan 3000 Web API V1) this server was built against.
import { toolDefs } from "../dist/tools.js";

const SWAGGER_GET_PATHS = [
  "/api/v1/Currencies",
  "/api/v1/Customers",
  "/api/v1/Customers/{CustomerID}",
  "/api/v1/GLAccounts",
  "/api/v1/GLJournalEntries",
  "/api/v1/GLJournalEntries/{journalid}",
  "/api/v1/InventoryReceipts",
  "/api/v1/InventoryReceipts/{ReceiptId}",
  "/api/v1/Invoices",
  "/api/v1/Invoices/{InvoiceNum}",
  "/api/v1/LineOfBusinesses",
  "/api/v1/Plants",
  "/api/v1/POStyles",
  "/api/v1/PriceLevels",
  "/api/v1/ProductionEntries",
  "/api/v1/ProductionEntries/{ProductionId}",
  "/api/v1/Products",
  "/api/v1/Regions",
  "/api/v1/salesorders/{jobNumber}/SalesOrderDetails",
  "/api/v1/salesorders/{jobNumber}/SalesOrderDetails/{id}",
  "/api/v1/SalesOrders",
  "/api/v1/SalesOrders/{jobNumber}",
  "/api/v1/salesorders/{jobNumber}/SalesOrderStructures",
  "/api/v1/salesorders/{jobNumber}/SalesOrderStructures/{id}",
  "/api/v1/SalesOrderTypes",
  "/api/v1/SalesReps",
  "/api/v1/TaxCodes",
  "/api/v1/Terms",
  "/api/v1/VendorInvoices",
  "/api/v1/VendorInvoices/{RecordNum}",
  "/api/v1/Vendors",
  "/api/v1/Vendors/{VendorID}",
];

let failed = false;

const implemented = new Map(toolDefs.map((d) => [d.path, d.name]));

const missing = SWAGGER_GET_PATHS.filter((p) => !implemented.has(p));
if (missing.length > 0) {
  failed = true;
  console.error("MISSING tools for swagger GET paths:");
  for (const p of missing) console.error(`  ${p}`);
}

const expected = new Set(SWAGGER_GET_PATHS);
const extra = toolDefs.filter((d) => !expected.has(d.path));
if (extra.length > 0) {
  failed = true;
  console.error("Tools with paths NOT in the swagger spec:");
  for (const d of extra) console.error(`  ${d.name}: ${d.path}`);
}

const names = toolDefs.map((d) => d.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length > 0) {
  failed = true;
  console.error(`Duplicate tool names: ${[...new Set(dupes)].join(", ")}`);
}

if (failed) {
  process.exit(1);
}
console.log(
  `Coverage OK: ${toolDefs.length} tools cover all ${SWAGGER_GET_PATHS.length} swagger GET paths.`
);
