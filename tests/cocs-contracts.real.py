"""Real baseline/draft browser regression probes; never touches owner checkout."""
import importlib.util,json,shutil,tempfile,subprocess
from pathlib import Path
R=Path(__file__).resolve().parents[1];spec=importlib.util.spec_from_file_location('validator',R/'sdk/cocs/validate.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
CHROME='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'
with tempfile.TemporaryDirectory() as t:
 tmp=Path(t);repo=tmp/'repo';shutil.copytree(R.parent/'cocs-source/game',repo/'game');view=repo/'game/view.mjs';original=view.read_text()
 def probe(label):return v.probe(repo,R/'sdk/cocs',R/'apps/cocs-viewer',CHROME,tmp,label)
 base=probe('base');assert v.compare(base,base)['ok']
 marker="g.userData={kind,vehicle:true,wheels,turret,barrels,guns,accessories:"
 assert marker in original
 cases=[('vehicle-flag',original.replace('kind,vehicle:true,wheels','kind,vehicle:false,wheels')),('wheels',original.replace('kind,vehicle:true,wheels,turret','kind,vehicle:true,wheels:[],turret')),('detached-turret',original.replace(marker,"g.remove(turret);"+marker)),('unbatched',original.replace(marker,"box(g,.1,.1,.1,0,4,0,material('#ff0000'));"+marker))]
 for name,source in cases:
  view.write_text(source);r=v.compare(base,probe(name));assert not r['ok'],name;print(name,'REJECTED:',r['errors'][0])
 view.write_text(original.replace("color:'#5f6338'","color:'#775599'"));r=v.compare(base,probe('paint'));assert r['ok'],r['errors'];print('paint-only: ACCEPTED')
 print('PASS: baseline 21 models; four real broken-model regressions rejected; paint-only allowed')
