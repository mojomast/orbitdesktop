import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openProjectRoot} from './project-files.mjs';
import {HERMES_NATIVE_CONTRACT} from '../contracts/workbench-native-v1.mjs';
import {RESULT_FRAME_MAX_BYTES,RESULT_TEXT_MAX_BYTES,validateResultFrame} from '../contracts/workbench-result-v1.mjs';
const pluginRoot=fileURLToPath(new URL('../hermes-plugin/',import.meta.url));
export function parseNativeResult(bytes,{overflow=false}={}){
  if(overflow||bytes.length>RESULT_FRAME_MAX_BYTES)return {availability:'explanation_unavailable',reason:'oversized'};
  if(!bytes.length)return {availability:'explanation_unavailable',reason:'missing'};
  if(bytes.at(-1)!==10)return {availability:'explanation_unavailable',reason:'incomplete'};
  let frames;
  try{
    const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).slice(0,-1).split('\n');
    if(lines.some(line=>!line))return {availability:'explanation_unavailable',reason:'malformed'};
    frames=lines.map(line=>JSON.parse(line));
  }
  catch{return {availability:'explanation_unavailable',reason:'malformed'};}
  if(!frames.length||frames.some(frame=>!validateResultFrame(frame)))return {availability:'explanation_unavailable',reason:'malformed'};
  if(frames.length>2)return {availability:'explanation_unavailable',reason:'duplicate'};
  if(frames.length===2&&JSON.stringify(frames[0])!==JSON.stringify(frames[1]))return {availability:'explanation_unavailable',reason:'conflict'};
  const frame=frames[0],text=frame.text;
  if(Buffer.byteLength(text,'utf8')>RESULT_TEXT_MAX_BYTES)return {availability:'explanation_unavailable',reason:'oversized'};
  const frame_hash=createHash('sha256').update(bytes.subarray(0,bytes.indexOf(10)+1)).digest('hex');
  if(!text.trim())return {availability:'explanation_unavailable',reason:'empty',hermes_completed:frame.completed,frame_hash};
  return {availability:frame.completed?'available':'explanation_unavailable',reason:frame.completed?null:'runtime_failed',text,hermes_completed:frame.completed,frame_hash};
}
export function nativeRuntimeMetadata({source,python,endpoint,profile_id,model='orbit-local-fixture',apiKey='local-fixture'}={}){
  const keyHash=createHash('sha256').update(apiKey).digest('hex');
  const configuration_hash=createHash('sha256').update(JSON.stringify({source,python,endpoint,profile_id,model,keyHash,commit:HERMES_NATIVE_CONTRACT.commit})).digest('hex');
  return {kind:'local-pinned',commit:HERMES_NATIVE_CONTRACT.commit,model,destination:'loopback configured model endpoint',configuration_hash};
}
export function readNativeApiKeyFile(filename){
  if(typeof filename!=='string'||!path.isAbsolute(filename)||path.resolve(filename)!==filename)throw Error('Native API key file must be an absolute path');
  const parent=openProjectRoot(path.dirname(filename));let fd;
  try{
    fd=fs.openSync(`/proc/self/fd/${parent.fd}/${path.basename(filename)}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const before=fs.fstatSync(fd);
    if(!before.isFile()||before.dev!==parent.dev||before.nlink!==1||(before.mode&0o077)!==0||before.size<1||before.size>4096||before.uid!==process.getuid())throw Error('Native API key file must be a private regular file');
    const bytes=Buffer.alloc(before.size+1),count=fs.readSync(fd,bytes,0,bytes.length,0),after=fs.fstatSync(fd);
    if(count!==before.size||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('Native API key file changed during read');
    const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count)).replace(/\r?\n$/,'');
    if(!value||value.length>4096||/[\x00-\x1f\x7f]/.test(value))throw Error('Native API key file content is invalid');
    return value;
  }finally{if(fd!==undefined)fs.closeSync(fd);parent.close();}
}
export function nativeRuntimeEnvironmentOptions({root,gate,config_generation,env=process.env}={}){
  if(!env.ORBIT_NATIVE_HERMES_SOURCE)return null;
  // Internal host-only object. Read once at service startup so consent metadata
  // and its lazily constructed runtime receive identical credential bytes.
  const apiKey=env.ORBIT_NATIVE_HERMES_API_KEY_FILE===undefined?'local-fixture':readNativeApiKeyFile(env.ORBIT_NATIVE_HERMES_API_KEY_FILE);
  return {source:env.ORBIT_NATIVE_HERMES_SOURCE,python:env.ORBIT_NATIVE_HERMES_PYTHON,endpoint:env.ORBIT_NATIVE_HERMES_MODEL_URL,profile_id:env.ORBIT_NATIVE_HERMES_PROFILE,model:env.ORBIT_NATIVE_HERMES_MODEL??'orbit-local-fixture',apiKey,root,gate,config_generation};
}

// Host-configured adapter. Never pass request/model-selected executables, paths,
// endpoint or environment here. No ambient environment is inherited by children.
// A shared agent lease is mandatory: no independent scheduler exists here.
export function createWorkbenchNativeRuntime({source,python,root,endpoint,profile_id,config_generation,model='orbit-local-fixture',apiKey='local-fixture',apiKeyFile,gate}={}){
  if(![source,python,root].every(p=>typeof p==='string'&&path.isAbsolute(p))||typeof gate?.claim!=='function')throw Error('Explicit runtime paths and shared gate required');
  if(typeof profile_id!=='string'||!profile_id||config_generation===undefined)throw Error('Explicit local profile ID and configuration generation required');
  const commit=execFileSync('/usr/bin/git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}}).trim();
  if(commit!==HERMES_NATIVE_CONTRACT.commit)throw Error('Unsupported Hermes source commit');
  // This shipped adapter is deliberately local-endpoint-only until a separate
  // owner provider/budget policy authorizes external spending.
  const url=new URL(endpoint);if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw Error('Explicit local model endpoint required');
  if(apiKeyFile!==undefined&&apiKeyFile!==null){if(apiKey!=='local-fixture')throw Error('Native API key source must be unambiguous');apiKey=readNativeApiKeyFile(apiKeyFile);}
  fs.mkdirSync(root,{recursive:true,mode:0o700});const children=new Map(),quarantines=new Map();
  const bindingMetadata=nativeRuntimeMetadata({source,python,endpoint,profile_id,model,apiKey});
  const terminating=new WeakSet();
  function terminate(child){
    if(terminating.has(child))return false;terminating.add(child);
    const requested=child.kill('SIGTERM');
    const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},2000);timer.unref();child.once('close',()=>clearTimeout(timer));return requested;
  }
  async function startNative({scope,run_id,channel,input,authorize}){
    let release;
    try{
      if(scope.recipient.profile_id!==profile_id||scope.recipient.config_generation!==config_generation||scope.recipient.native_runtime?.kind!=='local-pinned'||scope.recipient.native_runtime.commit!==commit||scope.recipient.native_runtime.configuration_hash!==bindingMetadata.configuration_hash)throw Error('Local native profile binding mismatch');
      await authorize();release=gate.claim('agent',run_id);
    }catch(error){error.native_outcome='not_started';throw error;}
    let child,dir,channelFile;
    try{
      let count=0;const directory=fs.opendirSync(root);try{while(directory.readSync())if(++count>=128)throw Error('Native private runtime retention limit reached');}finally{directory.closeSync();}
      dir=fs.mkdtempSync(path.join(root,'attempt-'));fs.chmodSync(dir,0o700);
      const home=path.join(dir,'home'),hermesHome=path.join(home,'.hermes');fs.mkdirSync(path.join(hermesHome,'plugins'),{recursive:true,mode:0o700});
      fs.cpSync(pluginRoot,path.join(hermesHome,'plugins','orbit-desktop'),{recursive:true,filter:p=>!p.includes('__pycache__')});
      channelFile=path.join(dir,'channel.json');fs.writeFileSync(channelFile,JSON.stringify(channel),{mode:0o600});
      // JSON is a YAML subset; settings use the documented plugin namespace.
      fs.writeFileSync(path.join(hermesHome,'config.yaml'),JSON.stringify({model:{default:model,provider:'custom',base_url:endpoint},plugins:{enabled:['orbit-desktop'],entries:{'orbit-desktop':{enabled:true,settings:{native_channel_file:channelFile}}}},tools:{tool_search:{enabled:'off'}},toolsets:['orbit_workbench'],agent:{max_turns:scope.budget.calls+2},memory:{enabled:false},session_recall:{enabled:false},compression:{enabled:false},checkpoints:{enabled:false},display:{tool_progress:'none'}}),{mode:0o600});
      fs.mkdirSync(path.join(dir,'empty-plugins'));fs.mkdirSync(path.join(dir,'work'));
      await authorize();
      child=spawn(python,[path.join(pluginRoot,'workbench.py'),'--runtime'],{cwd:path.join(dir,'work'),env:{PATH:'/usr/bin:/bin',HOME:home,HERMES_HOME:hermesHome,PYTHONPATH:source,PYTHONNOUSERSITE:'1',HERMES_BUNDLED_PLUGINS:path.join(dir,'empty-plugins'),HERMES_ENABLE_PROJECT_PLUGINS:'0',HERMES_DISABLE_TELEMETRY:'1'},stdio:['ignore','pipe','pipe','pipe','pipe']});
      children.set(run_id,child);
      const completion=new Promise((resolve,reject)=>{
        let failed=false;
        child.once('error',()=>{failed=true;});
        child.stdio[3].on('error',()=>{failed=true;terminate(child);});
        let bytes=0;const bound=chunk=>{bytes+=chunk.length;if(bytes>1048576)terminate(child);};child.stdout.on('data',bound);child.stderr.on('data',bound);
        const frames=[];let frameBytes=0,overflow=false;
        child.stdio[4].on('data',chunk=>{frameBytes+=chunk.length;if(frameBytes>RESULT_FRAME_MAX_BYTES){overflow=true;terminate(child);}else frames.push(chunk);});
        child.stdio[4].on('error',()=>{failed=true;terminate(child);});
        const timer=setTimeout(()=>terminate(child),Math.max(1,scope.expires_at-Date.now()));timer.unref();
        child.once('close',(code,signal)=>{clearTimeout(timer);const result=parseNativeResult(Buffer.concat(frames),{overflow});const outcome={termination_confirmed:true,exit_code:code,signal,result};code===0&&!failed?resolve({status:'completed',...outcome}):reject(Object.assign(Error('Native runtime terminated'),outcome));});
        // FD3 is private runtime input, never model arguments or environment.
        child.stdio[3].end(JSON.stringify({endpoint,model,api_key:apiKey,input,max_iterations:scope.budget.calls+2,session_id:scope.recipient.session_id}));
      }).finally(()=>{children.delete(run_id);try{fs.unlinkSync(channelFile);}catch{};try{fs.writeFileSync(path.join(dir,'retention.json'),JSON.stringify({run_id,grant_id:scope.id,ended_at:Date.now(),policy:'Private runtime files retained; channel key removed. Host inventory/manual retention only, never recursive request cleanup.'}),{mode:0o600});}catch{}});
      // The shared lease remains held until the service persists or quarantines
      // this observed completion. Release is idempotent.
      return {scope,run_id,completion,releaseNative:release};
    }catch(error){if(child)terminate(child);else error.native_outcome='not_started';release();if(channelFile)try{fs.unlinkSync(channelFile);}catch{};throw error;}
  }
  async function stopNative({run_id}){const child=children.get(run_id);return {requested:child?terminate(child):false};}
  function quarantineNative({grant_id}){if(quarantines.has(grant_id))return true;if(typeof gate.quarantine!=='function')throw Error('Shared native quarantine unavailable');quarantines.set(grant_id,gate.quarantine(`native:${grant_id}`));return true;}
  function acknowledgeNativeUnknown({grant_id}){quarantines.get(grant_id)?.();quarantines.delete(grant_id);}
  return {startNative,stopNative,quarantineNative,acknowledgeNativeUnknown,bindingMetadata,contract:HERMES_NATIVE_CONTRACT};
}
