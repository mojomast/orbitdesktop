# Confirms deepseek-v4.1-flash answers through OpenCode Go INSIDE a real worker sandbox (creates and deletes one sandbox).
. "$PSScriptRoot\common.ps1"
uv run --python 3.12 --with cua==0.5.0 "$Root\launcher.py" probe --config $Config
