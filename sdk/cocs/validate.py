"""Portable model compatibility gate; requires Node/esbuild/Three and Playwright.
Never imports draft code into the host Python/Node runtime. Game code is bundled
with dependency containment and executed in a network-denied browser page.
"""
import argparse,json,subprocess,tempfile,os
from pathlib import Path
POLICY='cocs-contracts-v1'
def compare(base,draft):
 errors=[];warnings=[]
 for group,models in base.items():
  for name,b in models.items():
   d=draft.get(group,{}).get(name)
   if d is None:errors.append(f'{group}/{name}: missing model');continue
   prefix=f'{group}/{name}: '
   errors.extend(prefix+x for x in d['errors'])
   if b.get('contract')!=d.get('contract'):errors.append(prefix+'userData contract changed')
   for ref,v in b['refs'].items():
    if ref not in d['refs'] or not d['refs'][ref]['attached']:errors.append(prefix+ref+' removed or detached')
    elif d['refs'][ref]['type']!=v['type']:errors.append(prefix+ref+' type changed')
   # Existing draw counts are a grandfathered budget, not a claim of optimal batching.
   if d['stationary']>b['stationary']:errors.append(prefix+f"stationary mesh draw budget grew {b['stationary']} → {d['stationary']}; batch stationary geometry without merging animated parts")
   if d['meshes']>b['meshes']+8:errors.append(prefix+'total draw-object budget grew by more than 8')
   if d['triangles']>max(b['triangles']*1.25,b['triangles']+500):errors.append(prefix+'triangle budget grew more than allowed 25%/500')
 return {'policy':POLICY,'ok':not errors,'errors':errors,'warnings':warnings,'baseline':base,'draft':draft}
def command(args):return subprocess.check_output(args,stderr=subprocess.PIPE,text=True,timeout=180)
def probe(repo,sdk,deps,chromium,tmp,label):
 out=tmp/(label+'.html');command(['node',str(sdk/'bundle.mjs'),str(repo),str(sdk/'model-probe.mjs'),str(out),str(deps)])
 from playwright.sync_api import sync_playwright
 with sync_playwright() as p:
  b=p.chromium.launch(executable_path=chromium,headless=True,args=['--no-sandbox']);page=b.new_page();errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)));page.route('http**/*',lambda r:r.abort())
  page.goto(out.as_uri());page.wait_for_function('window.probeResult',timeout=60000);data=page.evaluate('window.probeResult');b.close()
  if errors:raise ValueError('Probe JavaScript failed: '+str(errors))
  return data
def validate(repo,base,sdk,deps,chromium):
 repo=Path(repo).resolve()
 with tempfile.TemporaryDirectory(prefix='cocs-contract-') as t:
  tmp=Path(t);baseline=tmp/'baseline';baseline.mkdir()
  for name in command(['git','-C',str(repo),'ls-tree','-r','--name-only',base,'--','game']).splitlines():
   if not name.endswith('.mjs'):continue
   target=baseline/name
   if not target.resolve().is_relative_to(baseline):raise ValueError('Unsafe base path')
   target.parent.mkdir(parents=True,exist_ok=True);target.write_text(command(['git','-C',str(repo),'show',base+':'+name]))
  result=compare(probe(baseline,sdk,deps,chromium,tmp,'base'),probe(repo,sdk,deps,chromium,tmp,'draft'))
  return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('repo');p.add_argument('base');p.add_argument('--deps',required=True);p.add_argument('--chromium',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 try:
  r=validate(a.repo,a.base,Path(__file__).parent,Path(a.deps),a.chromium);Path(a.output).write_text(json.dumps(r));print(json.dumps({'policy':r['policy'],'ok':r['ok'],'errors':r['errors'],'models':sum(len(v) for v in r['draft'].values())}));raise SystemExit(0 if r['ok'] else 1)
 except subprocess.CalledProcessError as e:print((e.stderr or str(e))[-4000:]);raise SystemExit(1)
