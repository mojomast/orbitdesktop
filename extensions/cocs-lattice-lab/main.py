"""Lattice host adapter. Same authenticated Hermes/diff/PR boundary as Workshop."""
import importlib.util,json,os,re
from pathlib import Path
ROOT=Path(__file__).resolve().parent
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=load('workshop',ROOT/'workshop.py');builder=load('builder',ROOT/'build_lattice.py')
m.ROOT=ROOT;m.DATA=m.ORBIT/'.runtime/cocs-lattice-lab';m.ORIGIN='https://kimi.tailec998.ts.net:10448';m.TARGET_BRANCH='feat/fieldwork-plan';m.SOURCE_REPO=m.ORBIT.parent/'cocs-lattice-source';m.BRANCH_PREFIX='lattice-lab/';m.ASSET_PATTERN=r'operation:(cocs|cocs-coop|cocs-economy|cocs-director|cocs-terminals|cocs-traversal|lattice-support)';m.POLICY='cocs-lattice-v1'
m.EXTRA_INSTRUCTIONS='This is the Lattice mechanics adapter, not a 3D model request. Only edit existing game/cocs*.mjs (excluding tests), lattice-support.mjs, lattice-roles.mjs, lattice-board.mjs, lattice-feedback.mjs, lattice-training.mjs, objectives.mjs, config.mjs or mode-data.mjs. The draft base is feat/fieldwork-plan, never main. Preserve determinism, sorted orders, tick timers, team privacy and objective/network contracts. The service tests helper functions and two short engine runs, not requested behavior acceptance. Explain exact expected behavior and manual acceptance steps.'
model_compatibility=m.compatibility

def compatibility(s,names):
 if any(re.search(r'(map|terrain|spatial|navigation|blood-gulch|levelgen|arena|foundry)',n) for n in names):raise ValueError('Map/navigation edits require separate traversal acceptance and cannot be automatically published.')
 # Keep this first release scoped to mechanics; presentation changes use Asset Workshop.
 if any(not re.fullmatch(r'game/(cocs(?:-[a-z0-9-]+)?|lattice-support|lattice-roles|lattice-board|lattice-feedback|lattice-training|objectives|config|mode-data)\.mjs',n) for n in names):raise ValueError('Lattice drafts currently allow existing Lattice mechanics/config modules only. Model, renderer, network and UI changes need their dedicated review workflow.')
 output=m.DATA/s['id']/'lab-preview'
 builder.build(m.DATA/s['id']/'repo',output,ROOT/'sdk',ROOT/'ui',m.ORBIT/'apps/cocs-viewer',True)
 evidence=m.cmd(['/home/mojo/.hermes-instances/fresh/venvs/tuta-mail/bin/python',str(ROOT/'verify.py'),str(output/'mechanics.html')],timeout=180)
 return evidence

def build(s):
 diff,digest,names=m.inspect(s);evidence=compatibility(s,names)
 if m.inspect(s)[1]!=digest:raise ValueError('Draft changed during validation')
 (m.DATA/s['id']/'preview.html').write_text((m.DATA/s['id']/'lab-preview/preview.html').read_text())
 s.update(status='ready',diff=diff,digest=digest,files=names,evidence=evidence+'\nManual requested-behavior verification required. PR target: feat/fieldwork-plan.',validation_policy=m.POLICY,validated_digest=digest,error=None);m.save(s)
m.compatibility=compatibility;m.build=build
class Handler(m.Handler):
 def do_GET(self):
  path=self.path.split('?')[0]
  if path=='/health':return self.reply(200,{'ok':True,'release':os.environ.get('ORBIT_EXTENSION_RELEASE','dev')})
  if not self.identity():return self.reply(403,{'error':'Owner Tailscale identity required'})
  if path=='/':return self.reply(200,(ROOT/'dist/index.html').read_text().replace('__SESSION_TOKEN__',m.token()),'text/html')
  allowed={'/app.js':'text/javascript','/mechanics.js':'text/javascript','/source-index.js':'text/javascript','/style.css':'text/css'}
  if path in allowed:return self.reply(200,(ROOT/'dist'/path[1:]).read_bytes(),allowed[path],True)
  return self.reply(404,{'error':'Not found'})
if __name__=='__main__':
 m.initialize();m.ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('ORBIT_EXTENSION_PORT','4416'))),Handler).serve_forever()
