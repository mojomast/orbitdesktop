"""Assemble clean versioned extension inputs; no secrets or runtime data."""
from pathlib import Path
import shutil,subprocess
R=Path(__file__).resolve().parents[1]
work=R/'extensions/cocs-workshop';lab=R/'extensions/cocs-lattice-lab'
for dest in [work/'sdk',lab/'sdk']:
 dest.mkdir(exist_ok=True)
 for src in (R/'sdk/cocs').iterdir():
  if src.is_file() and src.suffix in ('.mjs','.py','.json','.md'):shutil.copy2(src,dest/src.name)
shutil.copy2(work/'main.py',lab/'workshop.py');shutil.copy2(R/'scripts/build_lattice.py',lab/'build_lattice.py')
(lab/'ui').mkdir(exist_ok=True)
for src in (R/'apps/cocs-lattice-lab').iterdir():
 if src.is_file():shutil.copy2(src,lab/'ui'/src.name)
subprocess.run(['python3',str(R/'scripts/build_lattice.py'),str(R.parent/'cocs-lattice-source'),str(lab/'dist'),'--standalone'],check=True)
print('Clean sources assembled; stage separately after testing.')
