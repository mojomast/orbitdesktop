import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {SANDBOX_KIND,SANDBOX_SPEC_VERSION,SANDBOX_POLICY} from '../contracts/workbench-sandbox-v1.mjs';
import {wbError} from './workbench-store.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
export const sandboxDigest=value=>hash(canonical(value));
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
// Bounded content identity includes modes and symlink text, never follows links.
export function sandboxTreeHash(root,{allowSymlinks=true}={}){
  const rows=[];let nodes=0,bytes=0;
  function walk(relative,depth){
    if(depth>32||++nodes>32768)throw Error('tree bound');
    const target=path.join(root,relative),stat=fs.lstatSync(target);
    if(stat.isSymbolicLink()){if(!allowSymlinks)throw Error('runtime symlink');const link=fs.readlinkSync(target);rows.push([relative,'link',link]);}
    else if(stat.isDirectory()){if(stat.mode&0o022)throw Error('writable provision');rows.push([relative,'dir',stat.mode&0o777]);for(const name of fs.readdirSync(target).sort())walk(path.join(relative,name),depth+1);}
    else if(stat.isFile()&&stat.nlink===1){if(stat.mode&0o022)throw Error('writable provision');bytes+=stat.size;if(stat.size>256*1024*1024||bytes>1024*1024*1024)throw Error('tree bound');rows.push([relative,'file',stat.mode&0o777,hash(fs.readFileSync(target))]);}
    else throw Error('unsupported rootfs entry');
  }
  walk('',0);return sandboxDigest(rows);
}
const privateDirectory=target=>{if(!path.isAbsolute(target)||fs.realpathSync(target)!==target)throw Error();const s=fs.lstatSync(target);if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o077))throw Error();};
const command=(executable,args)=>spawnSync(executable,args,{encoding:'utf8',timeout:3000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe']});
export function sandboxBundle({rootfs,candidate,runner,files}){
  return {ociVersion:'1.0.2',root:{path:rootfs,readonly:true},process:{terminal:false,user:{uid:0,gid:0},args:[SANDBOX_POLICY.guest_node,SANDBOX_POLICY.guest_runner,JSON.stringify(files)],cwd:'/workspace',env:['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','TMPDIR=/tmp','LANG=C.UTF-8','NODE_OPTIONS=','TSX_DISABLE_CACHE=1'],noNewPrivileges:true,capabilities:{bounding:[],effective:[],inheritable:[],permitted:[],ambient:[]},rlimits:[{type:'RLIMIT_NOFILE',hard:256,soft:256}]},hostname:'orbit-check',mounts:[{destination:'/proc',type:'proc',source:'proc',options:['nosuid','noexec','nodev']},{destination:'/tmp',type:'tmpfs',source:'tmpfs',options:['nosuid','nodev','mode=1777']},{destination:'/workspace',type:'bind',source:candidate,options:['rbind','ro','nosuid','nodev']},{destination:'/opt/orbit/runner.mjs',type:'bind',source:runner,options:['bind','ro','nosuid','nodev']}],linux:{namespaces:[{type:'pid'},{type:'mount'},{type:'ipc'},{type:'uts'},{type:'network'},{type:'user'}],uidMappings:[{containerID:0,hostID:process.getuid(),size:1}],gidMappings:[{containerID:0,hostID:process.getgid(),size:1}]}};
}
export const sandboxRunArgs=({runtime,bundle,id})=>['--rootless','--platform=systrap','--network=none',`--root=${runtime}`,'run',`--bundle=${bundle}`,'--pass-fd=3:3',id];
export const sandboxDeleteArgs=({runtime,id})=>['--rootless','--platform=systrap','--network=none',`--root=${runtime}`,'delete','--force',id];
// Modern runsc resolves these host-executed payloads next to its own binary.
// Reject runtime links rather than following an unhashed host executable.
export function sandboxRuntimeIdentity({runsc,expected,sidecarsExpected,layout}){
  if(layout!=='gvisor-bin-v1'||!hex(sidecarsExpected))throw Object.assign(Error(),{reason:'runtime_layout_unsupported'});
  const stat=fs.lstatSync(runsc);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o022)||!(stat.mode&0o111)||fs.realpathSync(runsc)!==runsc)throw Object.assign(Error(),{reason:'permissions_invalid'});
  const runsc_sha256=hash(fs.readFileSync(runsc));
  if(runsc_sha256!==expected)throw Object.assign(Error(),{reason:'runsc_hash_mismatch'});
  const sidecars=path.join(path.dirname(runsc),'gvisor-bin');let runtime_sidecars_sha256;
  try{
    if(fs.realpathSync(sidecars)!==sidecars||!fs.lstatSync(sidecars).isDirectory()||!fs.readdirSync(sidecars).length)throw Error();
    runtime_sidecars_sha256=sandboxTreeHash(sidecars,{allowSymlinks:false});
  }catch{throw Object.assign(Error(),{reason:'runtime_payload_unverified'});}
  if(runtime_sidecars_sha256!==sidecarsExpected)throw Object.assign(Error(),{reason:'runtime_payload_changed'});
  const identity={runsc_sha256,runtime_layout:layout,runtime_sidecars_sha256};
  return {...identity,runtime_payload_digest:sandboxDigest(identity)};
}

// Factory is IO-free. Provisioning is an operator action, not a provider action.
export function createWorkbenchSandboxProvider({root,env=process.env}={}){
  const config={runsc:env.ORBIT_WORKBENCH_GVISOR_RUNSC,expected:env.ORBIT_WORKBENCH_GVISOR_RUNSC_SHA256,sidecarsExpected:env.ORBIT_WORKBENCH_GVISOR_SIDECARS_SHA256,layout:env.ORBIT_WORKBENCH_GVISOR_RUNTIME_LAYOUT,rootfs:env.ORBIT_WORKBENCH_GVISOR_ROOTFS,image:env.ORBIT_WORKBENCH_GVISOR_IMAGE_DIGEST,platform:env.ORBIT_WORKBENCH_GVISOR_PLATFORM??'systrap',network:env.ORBIT_WORKBENCH_GVISOR_NETWORK??'none',root:env.ORBIT_WORKBENCH_GVISOR_ROOT??root,quota:env.ORBIT_WORKBENCH_GVISOR_DISK_QUOTA};
  const policy_digest=sandboxDigest(SANDBOX_POLICY),bundle_spec_digest=sandboxDigest({version:SANDBOX_SPEC_VERSION,policy:SANDBOX_POLICY});
  let closed=false,displaySnapshot=null,displayCheckedAt=null;const owned=new Map();
  const unavailable=(reason,message)=>({available:false,kind:SANDBOX_KIND,reason,message,action:'Provision a checksum-pinned runsc and approved Node rootfs, then preview and approve a fresh gVisor profile. See docs/ISOLATED_CHECKS.md.'});
  function probe(){
    if(closed)return unavailable('resources_unknown','Provider is closed.');
    if(!config.runsc)return unavailable('disabled','Experimental gVisor checks are off by default.');
    if(config.network!=='none')return unavailable('network_policy_invalid','Only offline networking is supported.');
    if(config.platform!=='systrap')return unavailable('platform_unsupported','Only rootless systrap is supported.');
    if(config.quota)return unavailable('disk_quota_unsupported','This provider cannot enforce a disk quota; requested quota configuration is unsupported.');
    if(![config.runsc,config.rootfs,config.root].every(p=>typeof p==='string'&&path.isAbsolute(p))||!hex(config.expected)||!hex(config.image))return unavailable('configuration_invalid','Incomplete or invalid provider configuration.');
    let runtimeIdentity;
    try{runtimeIdentity=sandboxRuntimeIdentity(config);}catch(error){return unavailable(error.reason??'runsc_missing','Runtime executable and adjacent gvisor-bin payload must have a supported layout and exact approved content digests.');}
    let rootfs_sha256,node_hash,node_version;
    try{
      if(fs.realpathSync(config.rootfs)!==config.rootfs)throw Error();
      // Mount targets must have no host-resolved symlink components. Ordinary
      // guest library links are hashed as text and resolve inside the guest root.
      for(const p of ['workspace','tmp','proc','opt/orbit']){const target=path.join(config.rootfs,p);if(fs.realpathSync(target)!==target||!fs.lstatSync(target).isDirectory())throw Error();}
      const node=path.join(config.rootfs,'usr/local/bin/node');const s=fs.lstatSync(node);if(fs.realpathSync(node)!==node||!s.isFile()||!(s.mode&0o111))throw Error();node_hash=hash(fs.readFileSync(node));
      node_version=fs.readFileSync(path.join(config.rootfs,'opt/orbit/node-version'),'utf8').trim();if(!/^v\d+\.\d+\.\d+$/.test(node_version))throw Error();
      if(!fs.lstatSync(path.join(config.rootfs,'opt/orbit/runner.mjs')).isFile())throw Error();
      rootfs_sha256=sandboxTreeHash(config.rootfs);
    }catch{return unavailable('rootfs_missing','Rootfs must be a bounded approved Node tree with the documented mountpoints and version manifest.');}
    if(rootfs_sha256!==config.image)return unavailable('rootfs_hash_mismatch','Approved rootfs content digest changed.');
    try{privateDirectory(config.root);if(fs.readdirSync(config.root).some(name=>name!=='bundles'&&name!=='runtime'))throw Error();for(const name of ['bundles','runtime'])if(fs.existsSync(path.join(config.root,name))){privateDirectory(path.join(config.root,name));if(fs.readdirSync(path.join(config.root,name)).some(id=>!owned.has(id)))return unavailable('resources_unknown','Retained runtime resources require operator reconciliation; no checks are replayed.');}}catch{return unavailable('permissions_invalid','Provider state root must be an existing private 0700 directory owned by the service UID.');}
    const namespace=command('/usr/bin/unshare',['--user','--map-root-user','--','/usr/bin/true']);
    if(namespace.error||namespace.status!==0)return unavailable('user_namespace_unavailable','The service cannot create an unprivileged user namespace.');
    const version=command(config.runsc,['--version']);if(version.error||version.status!==0)return unavailable('runtime_probe_failed','Pinned runtime version probe failed.');
    const runsc_version=version.stdout.trim();
    const identity={kind:SANDBOX_KIND,...runtimeIdentity,runsc_version,platform:config.platform,rootless:true,network:'none',rootfs_sha256,image_digest:config.image,guest_node_version:node_version,guest_node_sha256:node_hash,bundle_spec_version:SANDBOX_SPEC_VERSION,bundle_spec_digest,policy_digest};
    return {available:true,...identity,provider_identity:sandboxDigest(identity),reason:null,message:'Experimental gVisor systrap — offline; dependencies prepare on the trusted host.',action:null};
  }
  function describe(){const result=probe();displaySnapshot=structuredClone(result);displayCheckedAt=Date.now();return result;}
  // Pure bounded projection: no filesystem reads, hashing or subprocesses.
  // Display cache is never consulted by describe/approval/readiness/launch.
  function publicStatus(){return {...structuredClone(closed?unavailable('resources_unknown','Provider is closed.'):displaySnapshot??unavailable(config.runsc?'not_probed':'disabled','Provider capability has not been freshly probed.')),display_only:true,checked_at:displayCheckedAt};}
  function spawnCheck({candidate_root,runner,required_test_files,provider_identity,supervisor,seconds,spawnOptions}){
    const snapshot=describe();if(!snapshot.available)throw Object.assign(wbError('unavailable'),{reason:'sandbox_provider_unavailable'});
    if(snapshot.provider_identity!==provider_identity)throw Object.assign(wbError('stale_resource'),{reason:'sandbox_provider_changed'});
    for(const name of ['runtime','bundles'])fs.mkdirSync(path.join(config.root,name),{recursive:true,mode:0o700});
    const id=`orbit-${randomUUID()}`,bundle=path.join(config.root,'bundles',id),runtime=path.join(config.root,'runtime',id);fs.mkdirSync(bundle,{mode:0o700});fs.mkdirSync(runtime,{mode:0o700});
    const spec=sandboxBundle({rootfs:config.rootfs,candidate:candidate_root,runner,files:required_test_files});
    fs.writeFileSync(path.join(bundle,'config.json'),JSON.stringify(spec),{mode:0o600,flag:'wx'});
    const args=sandboxRunArgs({runtime,bundle,id});
    const metadata={execution_backend:'gvisor',provider:snapshot,provider_identity:snapshot.provider_identity,provider_resource_id:id,resource_generation:randomUUID(),host_identity:sandboxDigest([os.hostname(),fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()]),image_digest:snapshot.image_digest,policy_digest,bundle_spec_digest,runner_hash:hash(fs.readFileSync(runner))};
    owned.set(id,{bundle,runtime,metadata});
    const child=spawn(supervisor,['--kill-after=1s',`${seconds}s`,config.runsc,...args],spawnOptions);
    return {child,metadata,command:{supervisor,executable:'gvisor-runsc',args:['--rootless','--platform=systrap','--network=none','run','--pass-fd=3:3',id]}};
  }
  function cleanup(id){
    const resource=owned.get(id);if(!resource)return false;
    // Only exact IDs minted by this provider may be deleted. Never enumerate and kill.
    try{if(sandboxRuntimeIdentity(config).runtime_payload_digest!==resource.metadata.provider.runtime_payload_digest)return false;}catch{return false;}
    const result=command(config.runsc,sandboxDeleteArgs({runtime:resource.runtime,id}));
    if(result.error||result.status!==0)return false;
    try{if(fs.readdirSync(resource.runtime).length)return false;fs.rmdirSync(resource.runtime);fs.unlinkSync(path.join(resource.bundle,'config.json'));fs.rmdirSync(resource.bundle);owned.delete(id);return true;}catch{return false;}
  }
  return {kind:SANDBOX_KIND,describe,publicStatus,spawnCheck,cleanup,reconcile:()=>describe(),close(){closed=true;return {unknown_resources:[...owned.keys()]};}};
}
