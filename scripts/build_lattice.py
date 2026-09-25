import json,subprocess,sys,tempfile
from pathlib import Path

def build(repo,out,sdk,ui,deps,standalone=False):
 out=Path(out);out.mkdir(parents=True,exist_ok=True)
 subprocess.run(['node',str(sdk/'bundle.mjs'),str(repo),str(sdk/'lattice-adapter.mjs'),str(out/'mechanics.html'),str(deps)],check=True,capture_output=True,text=True)
 html=(out/'mechanics.html').read_text();js=html.split('<script>',1)[1].rsplit('</script>',1)[0];(out/'mechanics.js').write_text(js)
 subprocess.run(['node',str(sdk/'index.mjs'),str(repo),str(out/'source-index.json')],check=True,capture_output=True,text=True)
 data=(out/'source-index.json').read_text();(out/'source-index.js').write_text('window.sourceIndex='+data.replace('<','\\u003c')+';')
 for name in ['index.html','style.css','app.js']:(out/name).write_text((ui/name).read_text())
 if standalone:
  page=(out/'index.html').read_text().replace("window.workshopToken='__SESSION_TOKEN__';","window.draftOnly=true;")
  page=page.replace('<link rel="stylesheet" href="./style.css">','<style>'+(out/'style.css').read_text()+'</style>')
  for name in ['mechanics.js','source-index.js','app.js']:page=page.replace('<script src="./'+name+'"></script>','<script>'+(out/name).read_text().replace('</script','<\\/script')+'</script>')
  page=page.replace('<meta charset="utf-8">','<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; frame-src blob:">')
  (out/'preview.html').write_text(page)
 return out
if __name__=='__main__':
 root=Path(__file__).resolve().parents[1];build(Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve(),root/'sdk/cocs',root/'apps/cocs-lattice-lab',root/'apps/cocs-viewer','--standalone' in sys.argv)
