// One-off: does the productID on a sales-order detail line match the
// productID in the product catalog verbatim, or is normalization needed?
//
// Usage: with TITAN_BASE_URL / TITAN_APP_ID / TITAN_API_KEY set, run
//   node scripts/verify-product-ids.mjs
// Optional: pass a start date to sample from (default: 30 days back).
//   node scripts/verify-product-ids.mjs 2026-07-01

const baseUrl = (process.env.TITAN_BASE_URL ?? "").replace(/\/+$/, "");
const appId = process.env.TITAN_APP_ID ?? "";
const apiKey = process.env.TITAN_API_KEY ?? "";
if (!baseUrl || !appId || !apiKey) {
  console.error("Missing TITAN_BASE_URL / TITAN_APP_ID / TITAN_API_KEY.");
  process.exit(1);
}

const startDate = process.argv[2] ?? isoDaysAgo(30);
console.log(`Sampling sales orders with orderDate >= ${startDate}`);

async function get(path, query = {}) {
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { "X-App-Id": appId, "X-Api-Key": apiKey, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  return body?.result ?? body;
}

async function getAllPages(path, query = {}) {
  const rows = [];
  for (let page = 1; page <= 200; page++) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    url.searchParams.set("PageNumber", String(page));
    url.searchParams.set("PageSize", "500");
    const res = await fetch(url, {
      headers: { "X-App-Id": appId, "X-Api-Key": apiKey, Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${path} page ${page} -> ${res.status}`);
    const body = JSON.parse(text);
    const result = Array.isArray(body?.result) ? body.result : [];
    rows.push(...result);
    const pd = body?.paginationData ?? {};
    if (pd.totalCount != null && page >= Math.ceil(pd.totalCount / 500)) break;
    if (result.length === 0) break;
  }
  return rows;
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function quoted(s) {
  return `"${s}"`;
}

// 1. Fetch product catalog
console.log("Fetching product catalog...");
const products = await getAllPages("/api/v1/Products");
console.log(`  ${products.length} products in catalog.`);

const catalogExact = new Set();
const catalogNormalized = new Map(); // upper+trim -> original
for (const p of products) {
  const pid = p.productID ?? p.productId;
  if (pid == null) continue;
  const raw = String(pid);
  catalogExact.add(raw);
  catalogNormalized.set(raw.trim().toUpperCase(), raw);
}

// 2. Pull a sample of sales orders and their details
console.log("Fetching sample of sales orders...");
const orders = await getAllPages("/api/v1/SalesOrders");
const sampled = orders
  .filter((o) => typeof o.orderDate === "string" && o.orderDate.slice(0, 10) >= startDate)
  .slice(0, 30);
console.log(`  ${sampled.length} orders sampled (limit 30).`);

const detailProductIds = new Map(); // raw productID -> occurrences
let detailLinesFetched = 0;
for (const o of sampled) {
  const jobNumber = o.jobNumber;
  if (jobNumber == null) continue;
  const details = await getAllPages(
    `/api/v1/salesorders/${encodeURIComponent(String(jobNumber))}/SalesOrderDetails`
  );
  for (const d of details) {
    detailLinesFetched++;
    const pid = d.productID ?? d.productId;
    if (pid == null) continue;
    const raw = String(pid);
    detailProductIds.set(raw, (detailProductIds.get(raw) ?? 0) + 1);
  }
}
console.log(
  `  ${detailLinesFetched} detail lines across ${sampled.length} orders, ` +
    `${detailProductIds.size} distinct productIDs.`
);

// 3. Compare
const exactMatch = [];
const normalizedOnly = [];
const unmatched = [];
for (const [raw, count] of detailProductIds) {
  if (catalogExact.has(raw)) {
    exactMatch.push({ raw, count });
    continue;
  }
  const norm = raw.trim().toUpperCase();
  const catalogHit = catalogNormalized.get(norm);
  if (catalogHit != null) {
    normalizedOnly.push({ raw, count, catalog: catalogHit });
    continue;
  }
  unmatched.push({ raw, count });
}

console.log("");
console.log("=== RESULTS ===");
console.log(`Distinct detail productIDs: ${detailProductIds.size}`);
console.log(`  Exact match against catalog:       ${exactMatch.length}`);
console.log(`  Match only after trim+uppercase:   ${normalizedOnly.length}`);
console.log(`  Unmatched:                          ${unmatched.length}`);

if (normalizedOnly.length > 0) {
  console.log("");
  console.log("Normalized-only matches (raw -> catalog):");
  for (const { raw, catalog, count } of normalizedOnly.slice(0, 20)) {
    console.log(`  ${quoted(raw)}  ->  ${quoted(catalog)}  (${count} line(s))`);
  }
  if (normalizedOnly.length > 20) console.log(`  ... and ${normalizedOnly.length - 20} more.`);
}

if (unmatched.length > 0) {
  console.log("");
  console.log("Unmatched productIDs (sample of up to 30, quoted to expose whitespace):");
  for (const { raw, count } of unmatched.slice(0, 30)) {
    console.log(`  ${quoted(raw)}  (${count} line(s))`);
  }
  if (unmatched.length > 30) console.log(`  ... and ${unmatched.length - 30} more.`);
}

console.log("");
if (normalizedOnly.length === 0 && unmatched.length === 0) {
  console.log("VERDICT: All detail productIDs match the catalog exactly. No normalization needed.");
} else if (normalizedOnly.length > 0 && unmatched.length === 0) {
  console.log("VERDICT: Catalog lookup needs to normalize with trim+uppercase on both sides.");
} else if (unmatched.length > 0 && normalizedOnly.length === 0) {
  console.log(
    "VERDICT: Exact match works for catalog products, but " +
      `${unmatched.length} distinct productIDs on detail lines are not in the catalog at all. ` +
      "These are the unresolved codes we need to flag."
  );
} else {
  console.log(
    "VERDICT: Mixed. Some productIDs need normalization, some are truly missing from the catalog."
  );
}
