import { z, type ZodRawShape } from "zod";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** URL path template; segments like {jobNumber} are filled from arguments. */
  path: string;
  /** Argument names that fill path segments; all other arguments become query parameters. */
  pathParams?: string[];
  params: ZodRawShape;
}

const page = (): ZodRawShape => ({
  PageNumber: z.number().int().min(1).optional().describe("Page number (1-based)."),
  PageSize: z.number().int().min(1).optional().describe("Number of records per page."),
});

const dateStr = (label: string) =>
  z.string().optional().describe(`${label} (ISO date or date-time, e.g. 2025-06-01).`);

export const toolDefs: ToolDef[] = [
  {
    name: "list_currencies",
    title: "List currencies",
    description:
      "Retrieves currencies with exchange rates and revaluation accounts, optionally filtered by currency name.",
    path: "/api/v1/Currencies",
    params: {
      CurrencyName: z.string().optional().describe("Filter by currency name (e.g. USD, EURO)."),
      ...page(),
    },
  },
  {
    name: "list_customers",
    title: "List customers",
    description: "Retrieves customers, optionally filtered by status and user-defined fields.",
    path: "/api/v1/Customers",
    params: {
      Status: z
        .string()
        .optional()
        .describe("Filter by customer status code (A, H, P, S, or N)."),
      Userfield1: z.string().optional().describe("Filter by user-defined field 1."),
      Userfield2: z.string().optional().describe("Filter by user-defined field 2."),
      Userfield3: z.string().optional().describe("Filter by user-defined field 3."),
      Userfield4: z.string().optional().describe("Filter by user-defined field 4."),
      Userfield5: z.string().optional().describe("Filter by user-defined field 5."),
      ...page(),
    },
  },
  {
    name: "get_customer",
    title: "Get customer",
    description: "Retrieves a specific customer by CustomerID.",
    path: "/api/v1/Customers/{CustomerID}",
    pathParams: ["CustomerID"],
    params: {
      CustomerID: z.string().describe("The customer ID (e.g. CUST001)."),
    },
  },
  {
    name: "list_gl_accounts",
    title: "List GL accounts",
    description:
      "Retrieves general ledger accounts, optionally filtered by account number.",
    path: "/api/v1/GLAccounts",
    params: {
      AccountNumber: z.string().optional().describe("Filter by GL account number."),
      ...page(),
    },
  },
  {
    name: "list_gl_journal_entries",
    title: "List GL journal entries",
    description:
      "Retrieves GL journal entries (headers with detail lines), optionally filtered by source journal and journal/posting date ranges.",
    path: "/api/v1/GLJournalEntries",
    params: {
      SourceJournal: z
        .string()
        .optional()
        .describe("Filter by source journal code (e.g. GL, AP, AR)."),
      JournalStartDate: dateStr("Journal date range start"),
      JournalEndDate: dateStr("Journal date range end"),
      PostingStartDate: dateStr("Posting date range start"),
      PostingEndDate: dateStr("Posting date range end"),
      OrderByDate: z
        .string()
        .optional()
        .describe("Which date to order the range by: JournalDate or Posted."),
      ...page(),
    },
  },
  {
    name: "get_gl_journal_entry",
    title: "Get GL journal entry",
    description: "Retrieves a single GL journal entry header and its details by JournalID.",
    path: "/api/v1/GLJournalEntries/{journalid}",
    pathParams: ["journalid"],
    params: {
      journalid: z.string().describe("The journal ID (e.g. GL1001)."),
    },
  },
  {
    name: "list_inventory_receipts",
    title: "List inventory receipts",
    description:
      "Retrieves posted inventory receipts/adjustments, filtered by plant, receipt date range, type, posted date range, or journal ID.",
    path: "/api/v1/InventoryReceipts",
    params: {
      PlantID: z.string().optional().describe("Filter by plant ID."),
      StartDate: dateStr("Receipt date range start"),
      EndDate: dateStr("Receipt date range end"),
      Type: z.string().optional().describe("Filter by ticket type (e.g. Receipt, Return, Transfer)."),
      StartPostedDate: dateStr("Posted date range start"),
      EndPostedDate: dateStr("Posted date range end"),
      JournalID: z.string().optional().describe("Filter by journal ID."),
      ...page(),
    },
  },
  {
    name: "get_inventory_receipt",
    title: "Get inventory receipt",
    description:
      "Retrieves a posted inventory receipt/adjustment by ReceiptID, including all detail lines.",
    path: "/api/v1/InventoryReceipts/{ReceiptId}",
    pathParams: ["ReceiptId"],
    params: {
      ReceiptId: z.number().int().describe("The receipt ID (integer)."),
    },
  },
  {
    name: "list_invoices",
    title: "List invoices",
    description:
      "Retrieves posted customer invoices, filtered by plant, customer, invoice/due/posted date ranges, ticket type, or journal ID.",
    path: "/api/v1/Invoices",
    params: {
      PlantId: z.string().optional().describe("Filter by plant ID."),
      CustomerId: z.string().optional().describe("Filter by customer ID."),
      StartDate: dateStr("Invoice date range start"),
      EndDate: dateStr("Invoice date range end"),
      StartDueDate: dateStr("Due date range start"),
      EndDueDate: dateStr("Due date range end"),
      StartPostedDate: dateStr("Posted date range start"),
      EndPostedDate: dateStr("Posted date range end"),
      TicketType: z.string().optional().describe("Filter by ticket type."),
      JournalId: z.string().optional().describe("Filter by journal ID."),
      ...page(),
    },
  },
  {
    name: "get_invoice",
    title: "Get invoice",
    description:
      "Retrieves a posted customer invoice by invoice number, including all detail lines.",
    path: "/api/v1/Invoices/{InvoiceNum}",
    pathParams: ["InvoiceNum"],
    params: {
      InvoiceNum: z.number().int().describe("The invoice (ticket) number (integer)."),
    },
  },
  {
    name: "list_lines_of_business",
    title: "List lines of business",
    description:
      "Retrieves lines of business with AP matching/tolerance settings, optionally filtered by line of business ID.",
    path: "/api/v1/LineOfBusinesses",
    params: {
      LineofBusiness: z.string().optional().describe("Filter by line of business ID."),
      ...page(),
    },
  },
  {
    name: "list_plants",
    title: "List plants",
    description: "Retrieves plants (locations) with address and contact information.",
    path: "/api/v1/Plants",
    params: { ...page() },
  },
  {
    name: "list_po_styles",
    title: "List PO styles",
    description: "Retrieves purchase order form styles, optionally filtered by PO style ID.",
    path: "/api/v1/POStyles",
    params: {
      POStyleID: z.string().optional().describe("Filter by PO style ID."),
      ...page(),
    },
  },
  {
    name: "list_price_levels",
    title: "List price levels",
    description: "Retrieves price levels with sales tax rates, effective dates, and status.",
    path: "/api/v1/PriceLevels",
    params: { ...page() },
  },
  {
    name: "list_production_entries",
    title: "List production entries",
    description:
      "Retrieves posted production entries, filtered by plant, journal ID, production department, type, or production/posted date ranges.",
    path: "/api/v1/ProductionEntries",
    params: {
      PlantID: z.string().optional().describe("Filter by plant ID."),
      JournalID: z.string().optional().describe("Filter by journal ID."),
      ProductionDepartment: z.string().optional().describe("Filter by production department."),
      Type: z.string().optional().describe("Filter by entry type (e.g. Standard, Reversal)."),
      StartProductionDate: dateStr("Production date range start"),
      EndProductionDate: dateStr("Production date range end"),
      StartPostedDate: dateStr("Posted date range start"),
      EndPostedDate: dateStr("Posted date range end"),
      ...page(),
    },
  },
  {
    name: "get_production_entry",
    title: "Get production entry",
    description:
      "Retrieves a posted production entry by ProductionID, including details, mix components, components, and labor/overhead lines.",
    path: "/api/v1/ProductionEntries/{ProductionId}",
    pathParams: ["ProductionId"],
    params: {
      ProductionId: z.number().int().describe("The production entry ID (integer)."),
    },
  },
  {
    name: "list_products",
    title: "List products",
    description:
      "Retrieves products, optionally filtered by type, product line, status, part type, region, group, or subgroup.",
    path: "/api/v1/Products",
    params: {
      Type: z.string().optional().describe("Filter by product type (e.g. Make, Buy)."),
      ProductLine: z.string().optional().describe("Filter by product line."),
      Status: z.string().optional().describe("Filter by status code (e.g. A, I)."),
      PartTypeID: z.string().optional().describe("Filter by part type ID."),
      Region: z.string().optional().describe("Filter by region."),
      Group: z.string().optional().describe("Filter by group."),
      Subgroup: z.string().optional().describe("Filter by subgroup."),
      ...page(),
    },
  },
  {
    name: "list_regions",
    title: "List regions",
    description: "Retrieves regions.",
    path: "/api/v1/Regions",
    params: { ...page() },
  },
  {
    name: "list_sales_orders",
    title: "List sales orders",
    description:
      "Retrieves sales orders, filtered by order date, customer, shipping location, job status, start/completed dates, reference, or quote. Sortable via SortBy.",
    path: "/api/v1/SalesOrders",
    params: {
      OrderDate: dateStr("Filter by order date"),
      CustomerId: z.string().optional().describe("Filter by customer ID."),
      ShippingCity: z.string().optional().describe("Filter by shipping city."),
      ShippingState: z.string().optional().describe("Filter by shipping state."),
      ShippingZip: z.string().optional().describe("Filter by shipping ZIP code."),
      JobStatus: z.string().optional().describe("Filter by job status."),
      StartDate: dateStr("Filter by start date"),
      CompletedDate: dateStr("Filter by completed date"),
      Reference: z.string().optional().describe("Filter by reference."),
      Quote: z.string().optional().describe("Filter by quote number."),
      SortBy: z
        .string()
        .optional()
        .describe(
          "Sort field: OrderDate, CustomerId, ShippingCity, ShippingState, ShippingZip, JobStatus, StartDate, CompletedDate, Reference, or Quote. Defaults to JobNumber."
        ),
      ...page(),
    },
  },
  {
    name: "get_sales_order",
    title: "Get sales order",
    description: "Retrieves a sales order by job number.",
    path: "/api/v1/SalesOrders/{jobNumber}",
    pathParams: ["jobNumber"],
    params: {
      jobNumber: z.string().describe("The sales order job number."),
    },
  },
  {
    name: "list_sales_order_details",
    title: "List sales order details",
    description:
      "Retrieves the detail lines of a sales order, optionally filtered by structure ID.",
    path: "/api/v1/salesorders/{jobNumber}/SalesOrderDetails",
    pathParams: ["jobNumber"],
    params: {
      jobNumber: z.string().describe("The sales order job number."),
      StructureId: z.number().int().optional().describe("Filter by structure ID."),
      ...page(),
    },
  },
  {
    name: "get_sales_order_detail",
    title: "Get sales order detail",
    description: "Retrieves a single sales order detail line by its ID.",
    path: "/api/v1/salesorders/{jobNumber}/SalesOrderDetails/{id}",
    pathParams: ["jobNumber", "id"],
    params: {
      jobNumber: z.string().describe("The sales order job number."),
      id: z.number().int().describe("The sales order detail ID (integer)."),
    },
  },
  {
    name: "list_sales_order_structures",
    title: "List sales order structures",
    description:
      "Retrieves the structures of a sales order, optionally filtered by structure name.",
    path: "/api/v1/salesorders/{jobNumber}/SalesOrderStructures",
    pathParams: ["jobNumber"],
    params: {
      jobNumber: z.string().describe("The sales order job number."),
      Structure: z.string().optional().describe("Filter by structure name."),
      ...page(),
    },
  },
  {
    name: "get_sales_order_structure",
    title: "Get sales order structure",
    description: "Retrieves a single sales order structure by its ID.",
    path: "/api/v1/salesorders/{jobNumber}/SalesOrderStructures/{id}",
    pathParams: ["jobNumber", "id"],
    params: {
      jobNumber: z.string().describe("The sales order job number."),
      id: z.number().int().describe("The sales order structure ID (integer)."),
    },
  },
  {
    name: "list_sales_order_types",
    title: "List sales order types",
    description: "Retrieves sales order types.",
    path: "/api/v1/SalesOrderTypes",
    params: { ...page() },
  },
  {
    name: "list_sales_reps",
    title: "List sales reps",
    description: "Retrieves sales representatives, optionally filtered by status.",
    path: "/api/v1/SalesReps",
    params: {
      Status: z.string().optional().describe("Filter by status (e.g. Active, Inactive)."),
      ...page(),
    },
  },
  {
    name: "list_tax_codes",
    title: "List tax codes",
    description: "Retrieves tax codes with rates, optionally filtered by export code.",
    path: "/api/v1/TaxCodes",
    params: {
      ExportCode: z.string().optional().describe("Filter by export code."),
      ...page(),
    },
  },
  {
    name: "list_terms",
    title: "List terms",
    description:
      "Retrieves payment terms, optionally filtered by type and whether they apply to customers or vendors.",
    path: "/api/v1/Terms",
    params: {
      Type: z.string().optional().describe("Filter by term type (e.g. Standard)."),
      Customer: z.boolean().optional().describe("Filter to terms that apply to customers."),
      Vendor: z.boolean().optional().describe("Filter to terms that apply to vendors."),
      ...page(),
    },
  },
  {
    name: "list_vendor_invoices",
    title: "List vendor invoices",
    description:
      "Retrieves posted vendor (AP) invoices, filtered by plant, vendor, invoice/due/posted date ranges, invoice number, invoice type, or journal ID.",
    path: "/api/v1/VendorInvoices",
    params: {
      PlantId: z.string().optional().describe("Filter by plant ID."),
      VendorId: z.string().optional().describe("Filter by vendor ID."),
      StartDate: dateStr("Invoice date range start"),
      EndDate: dateStr("Invoice date range end"),
      StartDueDate: dateStr("Due date range start"),
      EndDueDate: dateStr("Due date range end"),
      StartPostedDate: dateStr("Posted date range start"),
      EndPostedDate: dateStr("Posted date range end"),
      InvoiceNum: z.string().optional().describe("Filter by vendor invoice number."),
      InvoiceType: z.string().optional().describe("Filter by invoice type."),
      JournalId: z.string().optional().describe("Filter by journal ID."),
      ...page(),
    },
  },
  {
    name: "get_vendor_invoice",
    title: "Get vendor invoice",
    description:
      "Retrieves a posted vendor (AP) invoice by record number, including all detail lines.",
    path: "/api/v1/VendorInvoices/{RecordNum}",
    pathParams: ["RecordNum"],
    params: {
      RecordNum: z.number().int().describe("The vendor invoice record number (integer)."),
    },
  },
  {
    name: "list_vendors",
    title: "List vendors",
    description:
      "Retrieves vendors, optionally filtered by vendor ID, company name, phone number, or ZIP. Sortable via SortBy.",
    path: "/api/v1/Vendors",
    params: {
      VendorID: z.string().optional().describe("Filter by vendor ID."),
      CompanyName: z.string().optional().describe("Filter by company name."),
      PhoneNumber: z.string().optional().describe("Filter by phone number."),
      Zip: z.string().optional().describe("Filter by ZIP code."),
      SortBy: z
        .string()
        .optional()
        .describe(
          "Sort field: VendorID, CompanyName, PhoneNumber, or Zip. Defaults to VendorID."
        ),
      ...page(),
    },
  },
  {
    name: "get_vendor",
    title: "Get vendor",
    description: "Retrieves a specific vendor by VendorID.",
    path: "/api/v1/Vendors/{VendorID}",
    pathParams: ["VendorID"],
    params: {
      VendorID: z.string().describe("The vendor ID (e.g. V001)."),
    },
  },
];
