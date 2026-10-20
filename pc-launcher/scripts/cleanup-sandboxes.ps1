# Deletes leftover orbit-* sandboxes (never touches others).
. "$PSScriptRoot\common.ps1"
$ls = Invoke-Cua sb ls 2>&1 | Out-String
[regex]::Matches($ls,'local:(orbit-[A-Za-z0-9\-]+)') | % { $_.Groups[1].Value } | Sort -Unique | % { "rm $_ : " + ((Invoke-Cua sb rm -f $_ 2>&1 | Out-String).Trim()) }
Invoke-Cua sb ls
