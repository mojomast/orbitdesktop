# Start, stop or inspect a local Orbit Desktop instance on Windows.
#
# This is the native-Windows counterpart to the systemd units in deploy/ (see
# docs/WINDOWS.md for the boundaries and expected degradations). It binds loopback
# only and is not a reboot-persistent service.
#
#   powershell -ExecutionPolicy Bypass -File scripts\orbit_windows.ps1 start
#   powershell -ExecutionPolicy Bypass -File scripts\orbit_windows.ps1 status
#   powershell -ExecutionPolicy Bypass -File scripts\orbit_windows.ps1 stop
#
# Configuration is read from a private, Git-ignored env file (default: .env.deploy in
# the repository root, matching the Linux deployment convention). Recognised keys are
# PORT, ORBIT_TOKEN, HERMES_API_URL, HERMES_API_KEY and ORBIT_HOST_SHELL. Tokens and
# keys are loaded into the child process environment only and are never printed.

param(
  [ValidateSet('start', 'stop', 'status')][string]$Action = 'start',
  [string]$Repo,
  [string]$EnvFile,
  [string]$NodeExe = 'node'
)

$ErrorActionPreference = 'Stop'

if (-not $Repo) { $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
if (-not $EnvFile) { $EnvFile = Join-Path $Repo '.env.deploy' }
$runtime = Join-Path $Repo '.runtime'
$pidFile = Join-Path $runtime 'orbit-server.pid'
$outLog = Join-Path $runtime 'orbit-server.out.log'
$errLog = Join-Path $runtime 'orbit-server.err.log'

function Get-NodePath {
  # Prefer an explicit path over a bare name so the detached child never depends on the
  # caller's PATH resolution.
  $cmd = Get-Command $NodeExe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "Node executable '$NodeExe' was not found. Install Node.js 22.12+ or pass -NodeExe."
}

function Resolve-HostShell {
  # A 'pwsh' resolved from the Microsoft Store is an App Execution Alias (a reparse
  # point). node-pty cannot launch it and fails with "File not found" while Test-Path
  # still returns true, so only explicit executable paths are considered. The Store path
  # is version-pinned and changes on update, hence the candidate list and the fallback.
  $candidates = @(
    'C:\Program Files\PowerShell\7\pwsh.exe',
    (Join-Path $env:ProgramFiles 'WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return 'powershell.exe'
}

function Load-EnvFile([string]$path) {
  if (-not (Test-Path $path)) { return @{} }
  $values = @{}
  foreach ($line in Get-Content $path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
    $index = $trimmed.IndexOf('=')
    $values[$trimmed.Substring(0, $index).Trim()] = $trimmed.Substring($index + 1).Trim().Trim('"').Trim("'")
  }
  return $values
}

function Get-RunningPid {
  if (-not (Test-Path $pidFile)) { return $null }
  $recorded = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($recorded -and (Get-Process -Id $recorded -ErrorAction SilentlyContinue)) { return [int]$recorded }
  return $null
}

$settings = Load-EnvFile $EnvFile
$port = if ($settings['PORT']) { [int]$settings['PORT'] } else { 8318 }

switch ($Action) {
  'start' {
    $existing = Get-RunningPid
    if ($existing) {
      Write-Host "Orbit is already running (PID $existing) on http://127.0.0.1:$port"
      exit 0
    }
    if (-not (Test-Path (Join-Path $Repo 'dist\index.html'))) {
      throw "No served build found. Run: npm ci; node_modules\.bin\vite build --outDir dist --emptyOutDir"
    }
    if (-not (Test-Path $runtime)) { New-Item -ItemType Directory -Force -Path $runtime | Out-Null }

    # Export the file's settings to this process so the detached child inherits them.
    foreach ($key in $settings.Keys) { Set-Item -Path "Env:$key" -Value $settings[$key] }
    $env:PORT = "$port"
    $env:ORBIT_HOST_SHELL = Resolve-HostShell

    # The server only writes its own token file when ORBIT_TOKEN is unset. When it is
    # set, mirror it here so there is one obvious place to read the live token and a
    # stale file cannot make "Connect host" reject the current one.
    if ($env:ORBIT_TOKEN) {
      Set-Content -Path (Join-Path $runtime 'session-token') -Value $env:ORBIT_TOKEN
    }

    $node = Get-NodePath
    $process = Start-Process -FilePath $node `
      -ArgumentList '--experimental-strip-types', 'server/index.mjs' `
      -WorkingDirectory $Repo -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Set-Content -Path $pidFile -Value $process.Id

    Write-Host "Orbit started (PID $($process.Id)) on http://127.0.0.1:$port"
    Write-Host "Host shell: $env:ORBIT_HOST_SHELL"
    Write-Host "Token:      see ORBIT_TOKEN in $EnvFile (or .runtime\session-token)"
    Write-Host "Logs:       $outLog"
    Write-Host "            $errLog"
  }
  'stop' {
    $existing = Get-RunningPid
    if ($existing) {
      Stop-Process -Id $existing -Force
      Write-Host "Stopped Orbit (PID $existing)."
    } else {
      Write-Host 'Orbit does not appear to be running.'
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  'status' {
    $existing = Get-RunningPid
    if ($existing) { Write-Host "running (PID $existing) on http://127.0.0.1:$port" }
    else { Write-Host 'stopped' }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 5
      Write-Host ("health: " + ($health | ConvertTo-Json -Compress))
    } catch {
      Write-Host 'health: unreachable'
    }
  }
}
