"""Run bounded browser diagnostics on hash-verified candidate builds. Never activates."""
import argparse
import hashlib
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

PROBES = r"""() => {
 const D=window.cocsDiagnostics, results=[];
 const test=(name,fn)=>{try{results.push({name,status:'pass',detail:fn()})}catch(e){results.push({name,status:'fail',error:String(e)})}};
 test('seeded replay',()=>{const a=D.create(),b=D.create();for(let i=0;i<60;i++){a.step(1/60);b.step(1/60)}const s=D.snapshot(a);if(JSON.stringify(s)!==JSON.stringify(D.snapshot(b)))throw Error('Non-deterministic replay');if(!(s.time>0)||!s.actors.length)throw Error('Empty simulation');return {time:s.time,actors:s.actors.length}});
 test('navigation API',()=>{const m=D.create();if(m.nav.length<2)throw Error('Missing graph');const r=D.route(m,0,1);if(!Array.isArray(r.segments))throw Error('Missing route segments');return {nodes:m.nav.length,segments:r.segments.length,reachable:r.reachable,scope:'API probe, not traversal approval'}});
 for(const kind of ['titan','scout','transport'])test('vehicle '+kind,()=>{const p=D.probeVehicle(kind);try{if(!p.report.meshes||Object.values(p.report.refs).includes('DETACHED'))throw Error('Invalid model references');const T=D.T,renderer=new T.WebGLRenderer(),scene=new T.Scene(),camera=new T.PerspectiveCamera(45,1,.1,1000);try{renderer.setSize(256,256);scene.add(p.model);camera.position.set(15,15,15);camera.lookAt(0,0,0);renderer.render(scene,camera);if(!renderer.info.render.calls)throw Error('No draw calls');return {...p.report,drawCalls:renderer.info.render.calls}}finally{renderer.dispose();renderer.forceContextLoss()}}finally{D.dispose(p.model)}});
 return results;
}"""


def verified_artifacts(directory, report):
    if report.get('schema') != 'cocs.sdk-candidate/v1' or not report.get('buildCompatible'):
        raise ValueError('Requires a successful candidate build report')
    artifacts = []
    for label, commit_key in [('baseline', 'baseline'), ('candidate', 'target')]:
        items = [b for b in report['builds'] if b['label'] == label]
        if len(items) != 1 or not items[0]['passed'] or items[0]['commit'] != report[commit_key]:
            raise ValueError('Build identity mismatch')
        artifact = directory / (label + '.html')
        if artifact.is_symlink() or hashlib.sha256(artifact.read_bytes()).hexdigest() != items[0]['sha256']:
            raise ValueError('Artifact integrity mismatch: ' + label)
        artifacts.append((label, artifact))
    return artifacts


def check(directory, executable=None):
    directory = Path(directory).resolve()
    report = json.loads((directory / 'report.json').read_text())
    artifacts = verified_artifacts(directory, report)
    result = {'schema':'cocs.sdk-runtime-check/v1', 'baseline':report['baseline'], 'target':report['target'],
              'activation':'NOT UPDATED', 'runs':[], 'limitations':[
                  'Diagnostic subset only; no gameplay traversal or full semantic compatibility approval',
                  'Candidate code runs in a separate browser context with network blocked; not a host security sandbox',
                  'No adapters rewritten and no activation performed']}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=executable, headless=True,
                                   args=['--enable-unsafe-swiftshader','--use-angle=swiftshader'])
        try:
            for label, artifact in artifacts:
                context = browser.new_context(accept_downloads=False, service_workers='block')
                context.route('**/*', lambda route: route.abort())
                page = context.new_page()
                page.set_default_timeout(30000)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                run = {'label':label, 'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest()}
                try:
                    page.set_content('<iframe sandbox="allow-scripts"></iframe>')
                    page.locator('iframe').evaluate('(f,html)=>f.srcdoc=html', artifact.read_text())
                    frame = page.frames[1]
                    frame.wait_for_function('!!window.cocsDiagnostics')
                    # Use the documented external timeout to bound synchronous candidate JS.
                    run['results'] = frame.evaluate(PROBES)
                except Exception as exc:
                    run['results'] = [{'name':'runtime load/probes','status':'fail','error':str(exc)}]
                finally:
                    run['errors'] = errors
                    run['passed'] = bool(run['results']) and all(r['status']=='pass' for r in run['results']) and not errors
                    result['runs'].append(run)
                    context.close()
        finally:
            browser.close()
    result['runtimeCompatible'] = all(r['passed'] for r in result['runs'])
    base = {r['name']:r for r in result['runs'][0]['results']}
    result['comparison'] = [{'name':r['name'], 'baseline':base.get(r['name']), 'candidate':r,
                             'regression':base.get(r['name'],{}).get('status')=='pass' and r['status']!='pass'}
                            for r in result['runs'][1]['results']]
    (directory / 'runtime-report.json').write_text(json.dumps(result, indent=2)+'\n')
    return result

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--chromium')
    args=parser.parse_args()
    result=check(args.directory,args.chromium)
    print(json.dumps(result,indent=2))
    raise SystemExit(0 if result['runtimeCompatible'] else 1)
