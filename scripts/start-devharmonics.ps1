param(
  [string]$ProjectPath = (Get-Location).Path,
  [int]$Port = 4317,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $repoRoot "dist\src\cli.js"

if (-not (Test-Path -LiteralPath $entryPoint)) {
  Write-Host "Building DevHarmonics for first use..."
  & npm.cmd run build --prefix $repoRoot
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$resolvedProject = (Resolve-Path -LiteralPath $ProjectPath).Path
$open = if ($NoOpen) { "false" } else { "true" }
Write-Host "Starting DevHarmonics for $resolvedProject"
Write-Host "Keep this window open while you use the dashboard. Press Ctrl+C to stop."
& node $entryPoint serve --project $resolvedProject --port $Port --open $open
exit $LASTEXITCODE
