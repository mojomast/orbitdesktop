. "$PSScriptRoot\common.ps1"
if (-not (Test-Path $Config)) { Copy-Item (Join-Path $Root 'config.example.json') $Config; Write-Host "Created $Config - edit projects, then re-run."; exit 1 }
if ((Test-Path $PidFile) -and (Get-Process -Id (Get-Content $PidFile) -EA 0)) { Write-Host 'Already running.'; exit 0 }
$p = Start-Process uv -ArgumentList @('run','--python','3.12','--with','cua==0.5.0',"$Root\launcher.py",'serve','--config',$Config) -WindowStyle Hidden -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -PassThru
Set-Content $PidFile $p.Id
Start-Sleep 3; & "$PSScriptRoot\status.ps1"
