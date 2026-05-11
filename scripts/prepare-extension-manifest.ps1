[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$PublisherId = $env:PUBLISHER_ID,

    [Parameter(Mandatory = $false)]
    [string]$SourcePath = ".\extension-manifest.json",

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ".\extension-manifest.generated.json"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($PublisherId)) {
    throw "PublisherId was not provided. Pass -PublisherId or set the PUBLISHER_ID environment variable."
}

if ($PublisherId -notmatch "^[A-Za-z0-9][A-Za-z0-9.-]*$") {
    throw "PublisherId '$PublisherId' is not a valid Marketplace publisher id format."
}

if (-not (Test-Path -LiteralPath $SourcePath)) {
    throw "Source manifest not found: $SourcePath"
}

$source = Get-Content -Raw -LiteralPath $SourcePath
if ($source -notmatch "__PUBLISHER_ID__") {
    throw "Source manifest does not contain the __PUBLISHER_ID__ token."
}

$generated = $source.Replace("__PUBLISHER_ID__", $PublisherId)
$generated | ConvertFrom-Json | Out-Null

$outputDirectory = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDirectory) -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

Set-Content -LiteralPath $OutputPath -Value $generated -Encoding UTF8
Write-Host "Generated extension manifest: $OutputPath"
