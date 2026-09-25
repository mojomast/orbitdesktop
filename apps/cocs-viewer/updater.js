import * as esbuild from 'esbuild-wasm';
const $=id=>document.getElementById(id),base=new URL('./',location.href).href;
let initialized,controller,candidate,savedHTML,currentCommit=SOURCE_COMMIT;
let bundledHTML;
window.addEventListener('message',e=>{if(e.source===$('active')?.contentWindow&&e.data?.type==='cocs-selected')parent.postMessage(e.data,'*');});
try{bundledHTML=(await text(new URL('viewer.html',base))).replace('<head>','<head><base href="'+base+'">');$('active').srcdoc=bundledHTML;}catch(e){message('Bundled viewer failed to load: '+e.message);}
$('commit').textContent=SOURCE_COMMIT.slice(0,8);
function message(text){$('message').textContent=text;}
$('update').onclick=()=>$('consent').showModal();
$('dismiss').onclick=()=>$('consent').close();
$('cancel').onclick=()=>controller?.abort();
$('reset').onclick=()=>{const f=document.createElement('iframe');f.id='active';f.title='COCS 3D asset viewer';f.setAttribute('sandbox','allow-scripts allow-forms allow-modals allow-downloads');f.srcdoc=bundledHTML;$('host').replaceChildren(f);currentCommit=SOURCE_COMMIT;savedHTML=null;$('reset').disabled=$('download').disabled=true;message('Restored bundled snapshot '+SOURCE_COMMIT.slice(0,8));};
$('download').onclick=()=>{if(!savedHTML)return;const url=URL.createObjectURL(new Blob([savedHTML],{type:'text/html'}));const a=document.createElement('a');a.href=url;a.download='cocs-assets-'+currentCommit.slice(0,12)+'.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);};
async function text(url,signal){const r=await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer'});if(!r.ok)throw Error(`Download failed (${r.status}): ${url.includes('api.github.com')?'GitHub API — possibly rate limited':new URL(url).pathname}`);const s=await r.text();if(s.length>5000000)throw Error('Source file exceeds 5 MB limit');return s;}
function escapeScript(s){return s.replace(/<\/script/gi,'<\\/script');}
async function validate(html,signal){candidate=document.createElement('iframe');candidate.className='pending';candidate.title='Checking updated COCS viewer';candidate.setAttribute('sandbox','allow-scripts allow-forms allow-modals allow-downloads');const f=candidate;await new Promise((resolve,reject)=>{let timeout;const done=err=>{clearTimeout(timeout);window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);err?reject(err):resolve();};const receive=e=>{if(e.source!==f.contentWindow||e.data?.type!=='cocs-ready')return;e.data.error?done(Error(e.data.error)):done();};const abort=()=>done(new DOMException('Cancelled','AbortError'));window.addEventListener('message',receive);signal.addEventListener('abort',abort,{once:true});timeout=setTimeout(()=>done(Error('Updated viewer did not initialize within 90 seconds')),90000);f.srcdoc=html;$('host').append(f);});signal.throwIfAborted();$('active').remove();f.id='active';f.className='';candidate=null;}
$('confirm').onclick=async()=>{
 $('consent').close();if(controller)return;controller=new AbortController();const {signal}=controller;
 const branch=$('branch').value;
 $('branch').disabled=$('update').disabled=$('reset').disabled=$('download').disabled=true;$('cancel').hidden=false;
 try{
  message('Checking GitHub '+branch+'…');
  const commit=JSON.parse(await text('https://api.github.com/repos/mojomast/cocs/commits/'+encodeURIComponent(branch),signal)).sha;
  if(!/^[a-f0-9]{40}$/.test(commit))throw Error('GitHub returned an invalid commit');
  message('Building GitHub '+commit.slice(0,8)+' — downloading asset modules…');
  if(!initialized)initialized=esbuild.initialize({wasmURL:new URL('esbuild.wasm',base).href,worker:false}).catch(e=>{initialized=null;throw e;});
  await initialized;signal.throwIfAborted();
  const cache=new Map();let files=0,total=0;
  const local={'/viewer.js':'viewer-source.js','/three.js':'three.module.js','/three.core.js':'three.core.js','/OrbitControls.js':'OrbitControls.js'};
  const plugin={name:'pinned-github-source',setup(build){
   build.onResolve({filter:/.*/},args=>{
    if(args.path==='three')return {path:'/three.js',namespace:'source'};
    if(args.path.startsWith('three/addons/')&&!args.path.includes('..'))return {path:args.path.replace('three/addons/','/addons/'),namespace:'source'};
    let path=args.kind==='entry-point'?'/viewer.js':new URL(args.path,'https://source.invalid'+(args.importer||'/viewer.js')).pathname;
    path=path.replace(/^\/vendor\/game\//,'/game/');
    if(!local[path]&&(!args.path.startsWith('.')||!((path.startsWith('/game/')&&path.endsWith('.mjs'))||(path.startsWith('/addons/')&&path.endsWith('.js')))))throw Error('Unsupported upstream dependency: '+args.path);
    return {path,namespace:'source'};
   });
   build.onLoad({filter:/.*/,namespace:'source'},async args=>{
    signal.throwIfAborted();if(cache.has(args.path))return cache.get(args.path);
    if(++files>200)throw Error('Update exceeds 200 module limit');
    const url=local[args.path]?new URL(local[args.path],base).href:args.path.startsWith('/addons/')?new URL(args.path.slice(1),base).href:'https://raw.githubusercontent.com/mojomast/cocs/'+commit+args.path;
    const pending=text(url,signal).then(contents=>{total+=contents.length;if(total>15000000)throw Error('Update exceeds 15 MB source limit');message(`Building ${commit.slice(0,8)} · ${files} modules fetched…`);return {contents,loader:'js'};});cache.set(args.path,pending);return pending;
   });
  }};
  const result=await esbuild.build({entryPoints:['/viewer.js'],bundle:true,write:false,format:'iife',minify:true,define:{SOURCE_COMMIT:JSON.stringify(commit)},plugins:[plugin],logLevel:'silent'});
  signal.throwIfAborted();
  const [template,css]=await Promise.all([text(new URL('viewer.html',base),signal),text(new URL('style.css',base),signal)]);
  const html=template.replace('<link rel="stylesheet" href="./style.css">','<style>'+css+'</style>').replace(/<script[^>]*src="\.\/viewer.js"[^>]*><\/script>/,()=>'<script>'+escapeScript(result.outputFiles[0].text)+'</script>');
  message('Validating '+commit.slice(0,8)+' in the 3D viewer…');
  await validate(html,signal);savedHTML=html;currentCommit=commit;
  message('Loaded GitHub '+branch+' @ '+commit.slice(0,8)+' · '+files+' modules. Session update; Save snapshot keeps an offline copy.');
 }catch(e){candidate?.remove();candidate=null;message((e.name==='AbortError'?'Update cancelled':('Update failed: '+e.message))+' — previous collection retained.');}
 finally{controller=null;$('branch').disabled=$('update').disabled=false;$('cancel').hidden=true;$('reset').disabled=$('download').disabled=!savedHTML;}
};
