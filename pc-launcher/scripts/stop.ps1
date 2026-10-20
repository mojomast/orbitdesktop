. "$PSScriptRoot\common.ps1"
if (Test-Path $PidFile) { Stop-Process -Id (Get-Content $PidFile) -EA 0; Remove-Item $PidFile; Write-Host 'Stopped (attempt journal kept; running sandboxes keep running and are reattached on next start).' } else { Write-Host 'Not running.' }
