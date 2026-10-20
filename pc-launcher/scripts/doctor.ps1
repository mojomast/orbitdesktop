. "$PSScriptRoot\common.ps1"
"docker: " + (docker version --format '{{.Server.Version}}' 2>&1)
"tailscale ip: " + (tailscale ip -4 2>&1)
"cua: " + (cua --version 2>&1)
uv run --python 3.12 --with cua==0.5.0 "$Root\launcher.py" doctor --config $Config
cua runtime doctor
