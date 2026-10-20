$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Data = Join-Path $env:USERPROFILE '.orbit-launcher'
$Config = Join-Path $Data 'config.json'
$PidFile = Join-Path $Data 'launcher.pid'
$Log = Join-Path $Data 'launcher.log'
New-Item -ItemType Directory -Force $Data | Out-Null
function Lock-UserOnly($p) { icacls $p /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null }
# uv/cua may not be on PATH in non-interactive shells: resolve them explicitly.
if (-not (Get-Command uv -EA 0)) { $u = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\astral-sh.uv_*\uv.exe" -EA 0 | Select -First 1; if ($u) { $env:PATH = "$(Split-Path $u.FullName);$env:PATH" } }
function Invoke-Cua { uv run -q --python 3.12 --with cua==0.5.0 cua @args }
