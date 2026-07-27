# Look up specific productIDs in the product catalog and print the raw rows.
# Usage:
#   .\scripts\lookup-product-ids.ps1
#   .\scripts\lookup-product-ids.ps1 -Codes @("105-12","3230","5201","4231","500-12")

param(
    [string[]]$Codes = @("105-12","100-12","3230","4231","500-12","5201","250-12","3031","110-12","3131")
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
$headers = @{ "X-App-Id" = $appId; "X-Api-Key" = $apiKey; "Accept" = "application/json" }

# Fetch full product catalog once
$products = New-Object System.Collections.Generic.List[object]
for ($page = 1; $page -le 200; $page++) {
    $url = "$baseUrl/api/v1/Products?PageNumber=$page&PageSize=500"
    $body = Invoke-RestMethod -Method Get -Uri $url -Headers $headers -TimeoutSec 120
    $result = $body.result
    if ($null -eq $result -or ($result -isnot [System.Collections.IEnumerable]) -or ($result -is [string])) { break }
    foreach ($r in $result) { $products.Add($r) | Out-Null }
    $pd = $body.paginationData
    if ($null -ne $pd -and $null -ne $pd.totalCount) {
        if ($page -ge [math]::Ceiling($pd.totalCount / 500)) { break }
    } elseif ($result.Count -eq 0) { break }
}
Write-Host "Loaded $($products.Count) products from catalog."
Write-Host ""

foreach ($code in $Codes) {
    $hit = $products | Where-Object {
        ($null -ne $_.productID -and "$($_.productID)" -eq $code) -or
        ($null -ne $_.productId -and "$($_.productId)" -eq $code)
    } | Select-Object -First 1

    Write-Host "=== $code ==="
    if ($null -eq $hit) {
        Write-Host "  (not found in catalog)"
    } else {
        $hit | Format-List *
    }
    Write-Host ""
}
