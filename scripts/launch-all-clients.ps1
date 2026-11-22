<#
.SYNOPSIS
  Sequentially launches RPA Client instances (client-A, client-B, client-C) if not already running.
#>
[CmdletBinding()]
param(
  [int]$DelaySeconds = 2,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$electronExe = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron executable not found: $electronExe"
}

$instances = @("client-A", "client-B", "client-C")

function Test-InstanceRunning {
  param([Parameter(Mandatory)][string]$InstanceId)

  # 1. Match electron.exe processes by exact --instance=<id> CLI argument
  $pattern = "(?:^|\s)--instance=$([regex]::Escape($InstanceId))(?:\s|$)"
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue
  foreach ($proc in $procs) {
    if ($proc.CommandLine -and ($proc.CommandLine -match $pattern)) {
      return $true
    }
  }

  # 2. Fallback check via instance.lock PID
  $lockFile = Join-Path $projectRoot ".local\instances\$InstanceId\instance.lock"
  if (Test-Path -LiteralPath $lockFile) {
    try {
      $lockData = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
      if ($lockData.pid -and (Get-Process -Id ([int]$lockData.pid) -ErrorAction SilentlyContinue)) {
        return $true
      }
    } catch {
      # Ignore unreadable/stale lockfile
    }
  }

  return $false
}

$launchedCount = 0
for ($i = 0; $i -lt $instances.Count; $i++) {
  $id = $instances[$i]
  if (Test-InstanceRunning -InstanceId $id) {
    Write-Host "[SKIP] $id is already running."
    continue
  }

  $launchArgs = ". --instance=$id"
  if ($DryRun) {
    Write-Host "[DRY-RUN] Would launch: `"$electronExe`" $launchArgs (cwd: $projectRoot)"
  } else {
    Start-Process -FilePath $electronExe -ArgumentList $launchArgs -WorkingDirectory $projectRoot | Out-Null
    Write-Host "[STARTED] $id"
  }
  $launchedCount++

  if (-not $DryRun -and $i -lt ($instances.Count - 1)) {
    Start-Sleep -Seconds $DelaySeconds
  }
}

Write-Host "Done. Launched $launchedCount instance(s)."
