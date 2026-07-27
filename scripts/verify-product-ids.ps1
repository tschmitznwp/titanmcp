# One-off: does the productID on a sales-order detail line match the
# productID in the product catalog verbatim, or is normalization needed?
#
# Usage: with TITAN_BASE_URL / TITAN_APP_ID / TITAN_API_KEY set in the shell,
#   .\scripts\verify-product-ids.ps1
# Optional: pass a start date to sample sales orders from (default: 30 days back).
#   .\scripts\verify-product-ids.ps1 -StartDate 2026-07-01

param(
    [string]$StartDate = "2026-07-13",
    [string]$EndDate   = "2026-07-17"
)

$ErrorActionPreference = "Stop"

$baseUrl = $env:TITAN_BASE_URL
$appId   = $env:TITAN_APP_ID
$apiKey  = $env:TITAN_API_KEY

if ([string]::IsNullOrWhiteSpace($baseUrl) -or [string]::IsNullOrWhiteSpace($appId) -or [string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "Missing TITAN_BASE_URL / TITAN_APP_ID / TITAN_API_KEY."
    exit 1
}
$baseUrl = $baseUrl.TrimEnd("/")

$headers = @{
    "X-App-Id" = $appId
    "X-Api-Key" = $apiKey
    "Accept" = "application/json"
}

Write-Host "Sampling sales orders with orderDate between $StartDate and $EndDate (inclusive, all matches)"

function Get-AllPages {
    param(
        [string]$Path,
        [hashtable]$Query = @{}
    )
    $rows = New-Object System.Collections.Generic.List[object]
    for ($page = 1; $page -le 200; $page++) {
        $qs = @("PageNumber=$page", "PageSize=500")
        foreach ($k in $Query.Keys) {
            $v = $Query[$k]
            if ($null -ne $v -and "$v" -ne "") {
                $qs += "$k=" + [System.Uri]::EscapeDataString("$v")
            }
        }
        $url = "$baseUrl$Path`?" + ($qs -join "&")
        try {
            $body = Invoke-RestMethod -Method Get -Uri $url -Headers $headers -TimeoutSec 120
        } catch {
            throw "GET $Path page $page failed: $($_.Exception.Message)"
        }
        $result = $body.result
        if ($null -eq $result) { break }
        if ($result -isnot [System.Collections.IEnumerable] -or $result -is [string]) { break }
        foreach ($r in $result) { $rows.Add($r) | Out-Null }
        $pd = $body.paginationData
        if ($null -ne $pd -and $null -ne $pd.totalCount) {
            if ($page -ge [math]::Ceiling($pd.totalCount / 500)) { break }
        } elseif ($result.Count -eq 0) {
            break
        }
    }
    return ,$rows
}

# 1. Fetch product catalog
Write-Host "Fetching product catalog..."
$products = Get-AllPages -Path "/api/v1/Products"
Write-Host "  $($products.Count) products in catalog."

$catalogExact      = New-Object System.Collections.Generic.HashSet[string]
$catalogNormalized = @{}
foreach ($p in $products) {
    $prodId = if ($null -ne $p.productID) { $p.productID } else { $p.productId }
    if ($null -eq $prodId) { continue }
    $raw = "$prodId"
    [void]$catalogExact.Add($raw)
    $norm = $raw.Trim().ToUpper()
    if (-not $catalogNormalized.ContainsKey($norm)) {
        $catalogNormalized[$norm] = $raw
    }
}

# 2. Sample sales orders + details
Write-Host "Fetching sample of sales orders..."
$orders = Get-AllPages -Path "/api/v1/SalesOrders"
$sampled = @($orders | Where-Object {
    $_.orderDate -is [string] -and
    $_.orderDate.Substring(0,10) -ge $StartDate -and
    $_.orderDate.Substring(0,10) -le $EndDate
})
Write-Host "  $($sampled.Count) orders match window (no cap)."

$detailProductIds = @{}
$detailLinesFetched = 0
foreach ($o in $sampled) {
    $jobNumber = $o.jobNumber
    if ($null -eq $jobNumber) { continue }
    $encoded = [System.Uri]::EscapeDataString("$jobNumber")
    $details = Get-AllPages -Path "/api/v1/salesorders/$encoded/SalesOrderDetails"
    foreach ($d in $details) {
        $detailLinesFetched++
        $prodId = if ($null -ne $d.productID) { $d.productID } else { $d.productId }
        if ($null -eq $prodId) { continue }
        $raw = "$prodId"
        if ($detailProductIds.ContainsKey($raw)) {
            $detailProductIds[$raw] = $detailProductIds[$raw] + 1
        } else {
            $detailProductIds[$raw] = 1
        }
    }
}
Write-Host "  $detailLinesFetched detail lines across $($sampled.Count) orders, $($detailProductIds.Count) distinct productIDs."

# 3. Compare
$exactMatch      = New-Object System.Collections.Generic.List[object]
$normalizedOnly  = New-Object System.Collections.Generic.List[object]
$unmatched       = New-Object System.Collections.Generic.List[object]
foreach ($k in $detailProductIds.Keys) {
    $count = $detailProductIds[$k]
    if ($catalogExact.Contains($k)) {
        $exactMatch.Add([pscustomobject]@{ raw = $k; count = $count }) | Out-Null
        continue
    }
    $norm = $k.Trim().ToUpper()
    if ($catalogNormalized.ContainsKey($norm)) {
        $normalizedOnly.Add([pscustomobject]@{ raw = $k; count = $count; catalog = $catalogNormalized[$norm] }) | Out-Null
        continue
    }
    $unmatched.Add([pscustomobject]@{ raw = $k; count = $count }) | Out-Null
}

Write-Host ""
Write-Host "=== RESULTS ==="
Write-Host "Distinct detail productIDs: $($detailProductIds.Count)"
Write-Host "  Exact match against catalog:       $($exactMatch.Count)"
Write-Host "  Match only after trim+uppercase:   $($normalizedOnly.Count)"
Write-Host "  Unmatched:                          $($unmatched.Count)"

if ($normalizedOnly.Count -gt 0) {
    Write-Host ""
    Write-Host "Normalized-only matches (raw -> catalog):"
    $normalizedOnly | Select-Object -First 20 | ForEach-Object {
        Write-Host ("  `"{0}`"  ->  `"{1}`"  ({2} line(s))" -f $_.raw, $_.catalog, $_.count)
    }
    if ($normalizedOnly.Count -gt 20) { Write-Host "  ... and $($normalizedOnly.Count - 20) more." }
}

if ($unmatched.Count -gt 0) {
    Write-Host ""
    Write-Host "Unmatched productIDs (sample of up to 30, quoted to expose whitespace):"
    $unmatched | Select-Object -First 30 | ForEach-Object {
        Write-Host ("  `"{0}`"  ({1} line(s))" -f $_.raw, $_.count)
    }
    if ($unmatched.Count -gt 30) { Write-Host "  ... and $($unmatched.Count - 30) more." }
}

Write-Host ""
if ($normalizedOnly.Count -eq 0 -and $unmatched.Count -eq 0) {
    Write-Host "VERDICT: All detail productIDs match the catalog exactly. No normalization needed."
} elseif ($normalizedOnly.Count -gt 0 -and $unmatched.Count -eq 0) {
    Write-Host "VERDICT: Catalog lookup needs to normalize with trim+uppercase on both sides."
} elseif ($unmatched.Count -gt 0 -and $normalizedOnly.Count -eq 0) {
    Write-Host "VERDICT: Exact match works for catalog products, but $($unmatched.Count) distinct productIDs on detail lines are not in the catalog at all. These are the unresolved codes we need to flag."
} else {
    Write-Host "VERDICT: Mixed. Some productIDs need normalization, some are truly missing from the catalog."
}
