#Requires -Version 5.1
<#
.SYNOPSIS
  Idempotent one-time provisioning of Cloudflare resources for this Worker.

.DESCRIPTION
  Creates (or verifies) the Vectorize index + metadata indexes, the Hyperdrive
  config, and the four Worker secrets. Safe to re-run: existing resources are
  detected and skipped. The Hyperdrive ID is written back into wrangler.jsonc.

  All output is ASCII on purpose: Windows PowerShell 5.1 reads .ps1 files as
  ANSI unless a BOM is present, so non-ASCII text would be garbled.

.EXAMPLE
  .\scripts\init-cloudflare.cmd -DatabaseUrl "postgres://user:pw@host:5432/db?sslmode=require"

.EXAMPLE
  .\scripts\init-cloudflare.cmd -WhatIf
#>
param(
  [string]$DatabaseUrl,
  [string]$HyperdriveId,
  [string]$JwtSecret,
  [string]$AdminToken,
  [string]$AdminEmail,
  [string]$AdminPassword,
  [switch]$ForceSecrets,
  [switch]$SkipVectorize,
  [switch]$SkipHyperdrive,
  [switch]$SkipSecrets,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$script:WhatIfMode = [bool]$WhatIf

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root 'wrangler.jsonc'
$DevVarsPath = Join-Path $Root '.dev.vars'
$Placeholder = 'REPLACE_WITH_YOUR_HYPERDRIVE_ID'
$IndexName = 'product-catalog'
$HyperdriveName = 'product-pg'
$SecretNames = @('JWT_SECRET', 'ADMIN_TOKEN', 'ADMIN_EMAIL', 'ADMIN_PASSWORD')
$MetadataIndexes = @(
  @{ Name = 'kind'; Type = 'string' },
  @{ Name = 'status'; Type = 'string' },
  @{ Name = 'category'; Type = 'string' },
  @{ Name = 'tenant'; Type = 'string' },
  @{ Name = 'price'; Type = 'number' }
)
$Results = [ordered]@{}

function Write-Head([string]$Text) { Write-Host ''; Write-Host "=== $Text ===" -ForegroundColor Cyan }
function Write-Ok([string]$Text) {
  if ($script:WhatIfMode) { Write-Host "  [WhatIf]  $Text" -ForegroundColor DarkYellow }
  else { Write-Host "  [OK]      $Text" -ForegroundColor Green }
}
function Write-Skip([string]$Text) { Write-Host "  [SKIP]    $Text" -ForegroundColor Yellow }
function Write-Warn2([string]$Text) { Write-Host "  [WARN]    $Text" -ForegroundColor Magenta }

function Find-Exe([string[]]$Names) {
  foreach ($n in $Names) {
    $cmd = Get-Command $n -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

function Invoke-Wrangler {
  param([string[]]$Arguments, [switch]$AllowFailure, [switch]$Probe)
  $line = 'npx wrangler ' + ($Arguments -join ' ')
  if ($script:WhatIfMode) {
    Write-Host "  [WhatIf]  $line" -ForegroundColor DarkYellow
    return @{ ExitCode = $(if ($Probe) { 1 } else { 0 }); Output = '' }
  }
  Write-Host "  > $line" -ForegroundColor DarkGray
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & $script:NpxExe wrangler @Arguments 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $text = ($raw -join "`n")
  foreach ($l in ($text -split "`n")) {
    if ($l.Trim()) { Write-Host "    $l" -ForegroundColor DarkGray }
  }
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "Wrangler failed (exit $code): $line"
  }
  return @{ ExitCode = $code; Output = $text }
}

function New-RandomToken([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($buffer).Replace('+', '-').Replace('/', '_').TrimEnd('=')
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

function Get-ConfigHyperdriveId {
  $text = [System.IO.File]::ReadAllText($ConfigPath)
  $m = [regex]::Match($text, '"hyperdrive"\s*:\s*\[\s*\{[^}]*?"id"\s*:\s*"([^"]*)"')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

function Set-ConfigHyperdriveId([string]$Id) {
  if ($Id -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
    throw "Refusing to write an invalid Hyperdrive ID into wrangler.jsonc: '$Id'"
  }
  $text = [System.IO.File]::ReadAllText($ConfigPath)
  $pattern = '("hyperdrive"\s*:\s*\[\s*\{[^}]*?"id"\s*:\s*")[^"]*(")'
  if (-not [regex]::IsMatch($text, $pattern)) { throw 'Could not locate hyperdrive[0].id in wrangler.jsonc' }
  if ($script:WhatIfMode) {
    Write-Host "  [WhatIf]  write hyperdrive[0].id = $Id into wrangler.jsonc" -ForegroundColor DarkYellow
    return
  }
  $replacement = '${1}' + $Id + '${2}'
  $newText = [regex]::Replace($text, $pattern, $replacement)
  [System.IO.File]::WriteAllText($ConfigPath, $newText, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok "wrangler.jsonc: hyperdrive[0].id = $Id"
}

# ---------------------------------------------------------------- preflight
Write-Head 'Preflight'
$previousLocation = Get-Location
try {
  Set-Location -LiteralPath $Root

  $script:NpxExe = Find-Exe @('npx.cmd', 'npx')
  $nodeExe = Find-Exe @('node.exe', 'node')
  $npmExe = Find-Exe @('npm.cmd', 'npm')
  if (-not $script:NpxExe -or -not $nodeExe -or -not $npmExe) {
    throw 'Node.js / npm / npx not found on PATH. Install Node.js 20+ first.'
  }
  Write-Ok "node: $(& $nodeExe --version)"

  if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules/wrangler'))) {
    Write-Warn2 'node_modules/wrangler missing - running npm install'
    if (-not $script:WhatIfMode) { & $npmExe install; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' } }
  }

  if (-not $script:WhatIfMode) {
    $who = Invoke-Wrangler @('whoami', '--json') -Probe -AllowFailure
    if ($who.ExitCode -ne 0) { throw 'Not logged in to Cloudflare. Run: npx wrangler login' }
    Write-Ok 'Cloudflare authentication: OK'
  } else {
    Write-Host '  [WhatIf]  skipping wrangler whoami' -ForegroundColor DarkYellow
  }

  # ------------------------------------------------------------- Vectorize
  Write-Head "Vectorize index: $IndexName"
  if ($SkipVectorize) {
    Write-Skip 'Vectorize (-SkipVectorize)'
    $Results['Vectorize'] = 'SKIPPED'
  } else {
    $exists = Invoke-Wrangler @('vectorize', 'get', $IndexName, '--json') -Probe -AllowFailure
    if ($exists.ExitCode -eq 0) {
      Write-Ok "index '$IndexName' already exists"
      if ($exists.Output -match '"dimensions"\s*:\s*(\d+)') {
        $dims = [int]$Matches[1]
        if ($dims -ne 1024) { Write-Warn2 "index has $dims dimensions, expected 1024 - embedding model mismatch" }
      }
    } else {
      $null = Invoke-Wrangler @('vectorize', 'create', $IndexName, '--dimensions=1024', '--metric=cosine')
      Write-Ok "created '$IndexName' (1024 / cosine)"
    }

    # Metadata indexes MUST exist before any vector is written.
    $listed = Invoke-Wrangler @('vectorize', 'list-metadata-index', $IndexName, '--json') -Probe -AllowFailure
    $listedText = $listed.Output
    foreach ($idx in $MetadataIndexes) {
      $pattern = '(?i)(?:"?propertyName"?\s*[:=]\s*"?' + [regex]::Escape($idx.Name) + '"?|\b' + [regex]::Escape($idx.Name) + '\b)'
      if ($listed.ExitCode -eq 0 -and $listedText -match $pattern) {
        Write-Skip "metadata index '$($idx.Name)' already exists"
      } else {
        $null = Invoke-Wrangler @('vectorize', 'create-metadata-index', $IndexName, "--propertyName=$($idx.Name)", "--type=$($idx.Type)")
        Write-Ok "created metadata index '$($idx.Name)' ($($idx.Type))"
      }
    }
    $null = Invoke-Wrangler @('vectorize', 'list-metadata-index', $IndexName) -AllowFailure
    $Results['Vectorize'] = 'READY'
  }

  # ------------------------------------------------------------- Hyperdrive
  Write-Head 'Hyperdrive'
  if ($SkipHyperdrive) {
    Write-Skip 'Hyperdrive (-SkipHyperdrive)'
    $Results['Hyperdrive'] = 'SKIPPED'
  } else {
    $currentId = Get-ConfigHyperdriveId
    $finalId = ''
    if ($HyperdriveId) {
      $finalId = $HyperdriveId
      $check = Invoke-Wrangler @('hyperdrive', 'get', $finalId) -Probe -AllowFailure
      if (-not $script:WhatIfMode -and $check.ExitCode -ne 0) {
        throw "Hyperdrive config '$finalId' does not exist on this account"
      }
      Write-Ok "using provided Hyperdrive ID: $finalId"
    } elseif ($currentId -and $currentId -ne $Placeholder) {
      $check = Invoke-Wrangler @('hyperdrive', 'get', $currentId) -Probe -AllowFailure
      if ($check.ExitCode -eq 0 -or $script:WhatIfMode) {
        Write-Ok "wrangler.jsonc already points at Hyperdrive $currentId"
        $finalId = $currentId
      } else {
        Write-Warn2 "configured ID $currentId is not reachable; re-check your account"
      }
    }

    if (-not $finalId -and $DatabaseUrl) {
      $created = Invoke-Wrangler @('hyperdrive', 'create', $HyperdriveName, "--connection-string=$DatabaseUrl")
      $m = [regex]::Match($created.Output, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
      if ($script:WhatIfMode) {
        $finalId = '00000000-0000-0000-0000-000000000000'
      } elseif ($m.Success) {
        $finalId = $m.Value
      } else {
        throw 'Could not extract the Hyperdrive ID from wrangler output. Pass -HyperdriveId <id> manually.'
      }
      Write-Ok "created Hyperdrive '$HyperdriveName': $finalId"
    }

    if ($finalId) {
      if ($finalId -ne $currentId) { Set-ConfigHyperdriveId $finalId }
      $Results['Hyperdrive'] = 'READY'
    } else {
      Write-Warn2 'No Hyperdrive configured. Re-run with -DatabaseUrl or -HyperdriveId (or use -SkipHyperdrive).'
      $Results['Hyperdrive'] = 'PENDING'
    }
  }

  # --------------------------------------------------------------- Secrets
  Write-Head 'Worker secrets'
  if ($SkipSecrets) {
    Write-Skip 'Secrets (-SkipSecrets)'
    $Results['Secrets'] = 'SKIPPED'
  } else {
    $provided = @{
      JWT_SECRET = $JwtSecret
      ADMIN_TOKEN = $AdminToken
      ADMIN_EMAIL = $AdminEmail
      ADMIN_PASSWORD = $AdminPassword
    }
    $dev = Read-DevVars
    $values = @{}
    $generated = @{}
    foreach ($name in $SecretNames) {
      $value = $provided[$name]
      if (-not $value) { $value = $dev[$name] }
      if (-not $value) {
        switch ($name) {
          'JWT_SECRET' { $value = New-RandomToken 32 }
          'ADMIN_TOKEN' { $value = New-RandomToken 24 }
          'ADMIN_EMAIL' { $value = 'admin@example.com' }
          'ADMIN_PASSWORD' { $value = 'Admin_' + (New-RandomToken 9) }
        }
        $generated[$name] = $value
        Write-Warn2 "$name was missing - generated a value"
      }
      $values[$name] = $value
    }

    if ($generated.Count) {
      if ($script:WhatIfMode) {
        Write-Host "  [WhatIf]  append generated keys to .dev.vars: $($generated.Keys -join ', ')" -ForegroundColor DarkYellow
      } else {
        $lines = @('', '# generated by scripts/init-cloudflare.ps1')
        foreach ($k in $generated.Keys) { $lines += "$k=$($generated[$k])" }
        $tail = ($lines -join "`n") + "`n"
        [System.IO.File]::AppendAllText($DevVarsPath, $tail, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "generated keys written to .dev.vars (keeps ADMIN_TOKEN in sync with ingest script)"
      }
    }

    $list = Invoke-Wrangler @('secret', 'list', '--format', 'json') -Probe -AllowFailure
    $missing = @($SecretNames | Where-Object { $list.ExitCode -ne 0 -or $list.Output -notmatch [regex]::Escape($_) })
    if (-not $missing.Count -and -not $ForceSecrets) {
      Write-Ok 'all four secrets already set (use -ForceSecrets to overwrite)'
      $Results['Secrets'] = 'READY (unchanged)'
    } else {
      $tmpDir = Join-Path $Root '.wrangler'
      if (-not (Test-Path -LiteralPath $tmpDir)) {
        if (-not $script:WhatIfMode) { $null = New-Item -ItemType Directory -Path $tmpDir }
      }
      $tmpFile = Join-Path $tmpDir 'secrets-bulk.json'
      if (-not $script:WhatIfMode) {
        $json = $values | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($tmpFile, $json, (New-Object System.Text.UTF8Encoding($false)))
      }
      try {
        $null = Invoke-Wrangler @('secret', 'bulk', $tmpFile)
      } finally {
        if (-not $script:WhatIfMode -and (Test-Path -LiteralPath $tmpFile)) {
          Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
        }
      }
      Write-Ok 'secrets uploaded via a single bulk request; temp file removed'
      $Results['Secrets'] = 'READY'
    }
  }

  # ---------------------------------------------------------------- summary
  Write-Head 'Summary'
  foreach ($k in $Results.Keys) { Write-Host ("  {0,-12} {1}" -f $k, $Results[$k]) }
  Write-Host "`nNext: .\scripts\deploy-cloudflare.cmd" -ForegroundColor Cyan
  if ($Results['Hyperdrive'] -eq 'PENDING') {
    Write-Warn2 'Deployment will fail until the Hyperdrive ID is set in wrangler.jsonc.'
  }
} finally {
  Set-Location -LiteralPath $previousLocation
}
