#Requires -Version 5.1
<#
.SYNOPSIS
  One-click deployment of the Worker (and optionally the initial data import).

.DESCRIPTION
  Preflight checks -> typecheck (also validates SQL registration) -> wrangler
  deploy -> health check. Pass -WithIngest to additionally run the DDL migration,
  import docs/*.json and build the knowledge base (this calls Workers AI and is
  billable, so it is opt-in).

  All output is ASCII on purpose: Windows PowerShell 5.1 reads .ps1 files as
  ANSI unless a BOM is present, so non-ASCII text would be garbled.

.EXAMPLE
  .\scripts\deploy-cloudflare.cmd

.EXAMPLE
  .\scripts\deploy-cloudflare.cmd -WithIngest

.EXAMPLE
  .\scripts\deploy-cloudflare.cmd -WhatIf
#>
param(
  [string]$ApiBase = 'https://ai.hesen.dpdns.org',
  [switch]$WithIngest,
  [switch]$SkipHealthCheck,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$script:WhatIfMode = [bool]$WhatIf
$ApiBase = $ApiBase.TrimEnd('/')

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root 'wrangler.jsonc'
$DevVarsPath = Join-Path $Root '.dev.vars'
$Placeholder = 'REPLACE_WITH_YOUR_HYPERDRIVE_ID'

function Write-Head([string]$Text) { Write-Host ''; Write-Host "=== $Text ===" -ForegroundColor Cyan }
function Write-Ok([string]$Text) {
  if ($script:WhatIfMode) { Write-Host "  [WhatIf]  $Text" -ForegroundColor DarkYellow }
  else { Write-Host "  [OK]      $Text" -ForegroundColor Green }
}
function Write-Warn2([string]$Text) { Write-Host "  [WARN]    $Text" -ForegroundColor Magenta }

function Find-Exe([string[]]$Names) {
  foreach ($n in $Names) {
    $cmd = Get-Command $n -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments, [switch]$AllowFailure)
  $line = "$(Split-Path -Leaf $Exe) $($Arguments -join ' ')"
  if ($script:WhatIfMode) {
    Write-Host "  [WhatIf]  $line" -ForegroundColor DarkYellow
    return @{ ExitCode = 0; Output = '' }
  }
  Write-Host "  > $line" -ForegroundColor DarkGray
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & $Exe @Arguments 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $text = ($raw -join "`n")
  foreach ($l in ($text -split "`n")) {
    if ($l.Trim()) { Write-Host "    $l" -ForegroundColor DarkGray }
  }
  if ($code -ne 0 -and -not $AllowFailure) { throw "Command failed (exit $code): $line" }
  return @{ ExitCode = $code; Output = $text }
}

function Read-DevVars {
  $map = @{}
  if (Test-Path -LiteralPath $DevVarsPath) {
    foreach ($line in (Get-Content -LiteralPath $DevVarsPath)) {
      if ($line.TrimStart().StartsWith('#')) { continue }
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $map[$Matches[1]] = $Matches[2] }
    }
  }
  return $map
}

$previousLocation = Get-Location
try {
  Set-Location -LiteralPath $Root

  # ---------------------------------------------------------------- preflight
  Write-Head 'Preflight'
  $nodeExe = Find-Exe @('node.exe', 'node')
  $npmExe = Find-Exe @('npm.cmd', 'npm')
  $npxExe = Find-Exe @('npx.cmd', 'npx')
  if (-not $nodeExe -or -not $npmExe -or -not $npxExe) {
    throw 'Node.js / npm / npx not found on PATH. Install Node.js 20+ first.'
  }
  Write-Ok "node: $(& $nodeExe --version)"

  if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules/wrangler'))) {
    Write-Warn2 'node_modules missing - running npm install'
    $null = Invoke-Native $npmExe @('install')
  }

  $configText = [System.IO.File]::ReadAllText($ConfigPath)
  $m = [regex]::Match($configText, '"hyperdrive"\s*:\s*\[\s*\{[^}]*?"id"\s*:\s*"([^"]*)"')
  $hyperdriveId = if ($m.Success) { $m.Groups[1].Value } else { '' }
  if (-not $hyperdriveId -or $hyperdriveId -eq $Placeholder) {
    if ($script:WhatIfMode) {
      Write-Warn2 'Hyperdrive ID is still a placeholder - a real run would stop here. Run init-cloudflare.cmd first.'
    } else {
      throw "Hyperdrive ID is not configured in wrangler.jsonc. Run scripts\init-cloudflare.cmd first (with -DatabaseUrl or -HyperdriveId)."
    }
  } else {
    Write-Ok "Hyperdrive ID: $hyperdriveId"
  }

  $dev = Read-DevVars
  $adminToken = $dev['ADMIN_TOKEN']
  if (-not $adminToken) { Write-Warn2 'ADMIN_TOKEN missing in .dev.vars - the ingest step will fail if enabled' }

  if (-not $script:WhatIfMode) {
    $who = Invoke-Native $npxExe @('wrangler', 'whoami', '--json') -AllowFailure
    if ($who.ExitCode -ne 0) { throw 'Not logged in to Cloudflare. Run: npx wrangler login' }
    Write-Ok 'Cloudflare authentication: OK'
  } else {
    Write-Host '  [WhatIf]  skipping wrangler whoami' -ForegroundColor DarkYellow
  }

  # ------------------------------------------------------- checks and deploy
  Write-Head 'Typecheck + SQL registration check'
  $null = Invoke-Native $npmExe @('run', 'typecheck')
  Write-Ok 'typecheck passed'

  Write-Head 'Deploy'
  $deployed = Invoke-Native $npmExe @('run', 'deploy')
  $workerDev = ''
  if ($deployed.Output -match 'https://[^\s"'']*workers\.dev') { $workerDev = $Matches[0] }
  Write-Ok 'Worker deployed with custom domain ai.hesen.dpdns.org'
  if ($workerDev) { Write-Host "  fallback URL: $workerDev" -ForegroundColor Gray }

  # ------------------------------------------------------------ health check
  if ($SkipHealthCheck) {
    Write-Head 'Health check'
    Write-Host '  [SKIP]    -SkipHealthCheck' -ForegroundColor Yellow
  } else {
    Write-Head "Health check: $ApiBase/api/health"
    if ($script:WhatIfMode) {
      Write-Host "  [WhatIf]  GET $ApiBase/api/health" -ForegroundColor DarkYellow
    } else {
      try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
      $healthy = $false
      for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
          $resp = Invoke-RestMethod -Uri "$ApiBase/api/health" -TimeoutSec 15 -ErrorAction Stop
          $ai = if ($resp.bindings.ai) { 'ok' } else { 'missing' }
          Write-Ok "bindings: ai=$ai vectorize=$($resp.bindings.vectorize) hyperdrive=$($resp.bindings.hyperdrive)"
          $healthy = $true
          break
        } catch {
          Write-Warn2 "attempt $attempt failed: $($_.Exception.Message)"
          if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
        }
      }
      if (-not $healthy) {
        Write-Warn2 'Health check failed. The custom-domain certificate may still be issuing.'
        Write-Warn2 'Verify the hesen.dpdns.org zone is Active in Cloudflare, then retry this script or use the workers.dev fallback URL.'
      }
    }
  }

  # ----------------------------------------------------------- data import
  Write-Head 'Initial data import'
  if (-not $WithIngest) {
    Write-Host '  [SKIP]    pass -WithIngest to migrate + import docs/*.json + build knowledge base' -ForegroundColor Yellow
  } else {
    if (-not $adminToken) { throw 'ADMIN_TOKEN missing in .dev.vars - cannot authenticate the ingest script' }
    Write-Warn2 'This runs DDL, ~5985 SKU embeddings and knowledge docs. Workers AI usage is billable.'
    $oldToken = $env:ADMIN_TOKEN
    $oldBase = $env:API_BASE
    try {
      $env:ADMIN_TOKEN = $adminToken
      $env:API_BASE = $ApiBase
      $null = Invoke-Native $nodeExe @('scripts/ingest.mjs', '--migrate')
      Write-Ok 'migration + import + knowledge base finished'
    } finally {
      $env:ADMIN_TOKEN = $oldToken
      $env:API_BASE = $oldBase
    }
  }

  # ---------------------------------------------------------------- summary
  Write-Head 'Done'
  Write-Host "  Site:      $ApiBase" -ForegroundColor Cyan
  if ($workerDev) { Write-Host "  Fallback:  $workerDev" -ForegroundColor Cyan }
  Write-Host "  Admin:     $ApiBase/api/admin/status  (header X-Admin-Token)" -ForegroundColor Cyan
  if (-not $WithIngest) {
    Write-Host "`n  Data not imported yet: .\scripts\deploy-cloudflare.cmd -WithIngest" -ForegroundColor Yellow
  }
} finally {
  Set-Location -LiteralPath $previousLocation
}
