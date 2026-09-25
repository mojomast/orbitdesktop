"""Build a source-pinned diagnostic engine; never embeds runtime credentials."""
import json, subprocess, sys, tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[1]
repo=Path(sys.argv[1]).resolve()
def git(*args):
 return subprocess.check_output(['git','-C',str(repo),*args],text=True).strip()
if git('status','--porcelain'):
 raise SystemExit('Refusing an unclean source checkout: commit provenance would be misleading')
commit=git('rev-parse','HEAD')
branch=sys.argv[2] if len(sys.argv)>2 else git('branch','--show-current')
if not branch: raise SystemExit('Detached checkout: supply the source branch explicitly')
# Verify the supplied branch actually contains this exact commit where a ref exists.
refs=git('for-each-ref','--format=%(refname)','refs/remotes/origin/'+branch,'refs/heads/'+branch).splitlines()
if not refs or not any(git('rev-parse',r)==commit for r in refs):
 raise SystemExit('Supplied branch does not resolve to checkout commit')
out=R/'apps/cocs-studio'
with tempfile.TemporaryDirectory() as tmp:
 bundle=Path(tmp)/'bundle.html'
 subprocess.run(['node',str(R/'sdk/cocs/bundle.mjs'),str(repo),str(R/'sdk/cocs/diagnostics-adapter.mjs'),str(bundle),str(R/'apps/cocs-viewer')],check=True)
 js=bundle.read_text().split('<script>',1)[1].rsplit('</script>',1)[0]
 (out/'diagnostics-engine.js').write_text(js)
(out/'diagnostics-source.js').write_text('window.diagnosticsSource='+json.dumps({'schema':'cocs.source/v1','repository':'mojomast/cocs','branch':branch,'commit':commit,'dirty':False})+';')
print(json.dumps({'commit':commit,'branch':branch,'engineBytes':len(js)}))
