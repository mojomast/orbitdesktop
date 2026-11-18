"""Stage release-owned static host inputs in a fresh fixture checkout."""
import json
from pathlib import Path
import shutil
import subprocess

INVENTORY = Path(__file__).resolve().parent / 'fixtures/ui-projection-inputs.mjs'


def copy_ui_source(source, fixture):
    shutil.copytree(source / 'src', fixture / 'src')
    for name in json.loads(subprocess.check_output(['node', str(INVENTORY), str(source)], text=True)):
        target = fixture / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)
