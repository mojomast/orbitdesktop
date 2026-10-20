$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Data = Join-Path $env:USERPROFILE '.orbit-launcher'
$Config = Join-Path $Data 'config.json'
$PidFile = Join-Path $Data 'launcher.pid'
$Log = Join-Path $Data 'launcher.log'
New-Item -ItemType Directory -Force $Data | Out-Null
function Lock-UserOnly($p) { icacls $p /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null }
