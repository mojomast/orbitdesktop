// Structural build-guard regressions: the default build is isolated, nothing is
// created before the guard passes, the source served dist and configured runtime
// roots are protected without any manual protect list, and --allow-source-dist is
// scoped to a verified scratch source only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BuildGuardError,guardDestination,planBuild,resolveDestination,runBuild} from '../scripts/isolated_build.mjs';

const root=()=>fs.mkdtempSync('/tmp/opencode/orbit-build-');
const write=(target,text)=>{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
const script=fileURLToPath(new URL('../scripts/isolated_build.mjs',import.meta.url));

test('default destination is isolated and never inside the source',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const source=path.join(base,'src');fs.mkdirSync(source);
  const destination=resolveDestination({env:{ORBIT_BUILD_SCRATCH:base}});
  assert.ok(destination.startsWith(base+path.sep));
  assert.equal(destination===source||destination.startsWith(source+path.sep),false);
  const plan=guardDestination({source,env:{ORBIT_BUILD_SCRATCH:base}});
  assert.ok(plan.canonical_dest.startsWith(base));
});

test('the source served dist is protected without any manual protect list',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const source=path.join(base,'checkout');const sentinel=path.join(source,'dist','index.html');write(sentinel,'SENTINEL');
  const before=fs.readFileSync(sentinel);
  assert.throws(()=>guardDestination({dest:path.join(source,'dist'),source,env:{}}),{code:'protected_destination'});
  assert.throws(()=>guardDestination({dest:path.join(source,'build-out'),source,env:{}}),{code:'protected_destination'});
  assert.throws(()=>guardDestination({dest:source,source,env:{}}),{code:'source_root_destination'});
  assert.throws(()=>guardDestination({dest:base,source,env:{}}),{code:'source_ancestor_destination'});
  assert.throws(()=>runBuild({dest:path.join(source,'dist'),source,env:{},typecheck:false}),{code:'protected_destination'});
  assert.deepEqual(fs.readFileSync(sentinel),before,'the served sentinel is untouched');
});

test('a scratch base inside a protected root is refused before anything is created',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const protectedRoot=path.join(base,'served');fs.mkdirSync(protectedRoot);
  const source=path.join(base,'src');fs.mkdirSync(source);
  const scratch=path.join(protectedRoot,'scratch');
  assert.throws(()=>guardDestination({source,protect:[protectedRoot],env:{ORBIT_BUILD_SCRATCH:scratch}}),{code:'protected_destination'});
  assert.equal(fs.existsSync(scratch),false,'no scratch directory may be created before the guard passes');
  assert.throws(()=>runBuild({source,protect:[protectedRoot],env:{ORBIT_BUILD_SCRATCH:scratch},typecheck:false}),{code:'protected_destination'});
  assert.equal(fs.existsSync(scratch),false);
});

test('runtime and release environment roots are protected',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const source=path.join(base,'src');fs.mkdirSync(source);
  const runtime=path.join(base,'runtime');fs.mkdirSync(runtime);
  assert.throws(()=>guardDestination({dest:path.join(runtime,'dist'),source,env:{ORBIT_RUNTIME_DIR:runtime}}),{code:'protected_destination'});
  const release=path.join(base,'release');fs.mkdirSync(release);
  assert.throws(()=>guardDestination({dest:path.join(release,'dist'),source,env:{ORBIT_RELEASE_ROOT:release}}),{code:'protected_destination'});
  const link=path.join(base,'runtime-link');fs.symlinkSync(runtime,link,'dir');
  assert.throws(()=>guardDestination({dest:path.join(link,'dist'),source,env:{ORBIT_RUNTIME_DIR:runtime}}),{code:'protected_destination'});
});

test('missing, relative, empty and root arguments fail closed at the CLI',t=>{
  for(const args of [['--dest'],['--source'],['--protect']]){
    const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
    assert.notEqual(result.status,0,args.join(' '));
    assert.match(result.stdout,/invalid_request/);
  }
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const source=path.join(base,'src');fs.mkdirSync(source);
  for(const dest of ['','relative/out','/'])assert.throws(()=>guardDestination({dest,source,env:{}}),{code:'invalid_destination'});
  assert.throws(()=>guardDestination({source:'',env:{}}),{code:'invalid_source'});
  assert.throws(()=>guardDestination({source:'relative/src',env:{}}),{code:'invalid_source'});
  assert.throws(()=>planBuild({source:path.join(base,'missing'),env:{}}),{code:'invalid_source'});
  assert.throws(()=>resolveDestination({env:{ORBIT_BUILD_SCRATCH:''}}),{code:'invalid_destination'});
  assert.throws(()=>resolveDestination({env:{ORBIT_BUILD_SCRATCH:'relative'}}),{code:'invalid_destination'});
});

test('--allow-source-dist is scoped to a verified scratch source',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const env={ORBIT_BUILD_SCRATCH:base};
  const source=path.join(base,'copy');write(path.join(source,'dist','index.html'),'old');
  assert.ok(guardDestination({dest:path.join(source,'dist'),source,env,allowSourceDist:true}).destination);
  assert.throws(()=>guardDestination({dest:path.join(source,'other'),source,env,allowSourceDist:true}),{code:'unsupported_destination'});
  const outside=path.join(base,'outside');fs.mkdirSync(outside);
  assert.throws(()=>guardDestination({dest:path.join(outside,'dist'),source:outside,env:{ORBIT_BUILD_SCRATCH:path.join(base,'scratch-only'),ORBIT_PROTECTED_ROOTS:path.join(base,'declared')},allowSourceDist:true}),{code:'source_not_scratch'});
  const destination=path.join(source,'dist');
  write(path.join(source,'node_modules','.bin','vite'),'#!/bin/sh\nexit 0\n');
  const spawn=(command,args)=>{if(args.includes('--outDir'))write(path.join(args[args.indexOf('--outDir')+1],'index.html'),'<h1>built</h1>');return {status:0,stdout:'',stderr:''};};
  const result=runBuild({dest:destination,source,env,allowSourceDist:true,typecheck:false,spawn});
  assert.equal(result.wrote,true);
  assert.equal(fs.readFileSync(path.join(destination,'index.html'),'utf8'),'<h1>built</h1>');
});

test('a non-scratch destination requires declared protected roots and writes nothing',t=>{
  const base=root();
  const source=path.join(base,'src');fs.mkdirSync(source);
  const scratch=path.join(base,'scratch');fs.mkdirSync(scratch);
  const outside=path.join(base,'outside');fs.mkdirSync(outside);
  const sentinel=path.join(outside,'keep.txt');write(sentinel,'KEEP');const before=fs.readFileSync(sentinel);
  const readOnly=path.join(base,'readonly');fs.mkdirSync(readOnly);write(path.join(readOnly,'keep.txt'),'KEEP');fs.chmodSync(readOnly,0o500);
  t.after(()=>{try{fs.chmodSync(readOnly,0o700);}catch{}fs.rmSync(base,{recursive:true,force:true});});
  const env={ORBIT_BUILD_SCRATCH:scratch};
  assert.throws(()=>guardDestination({dest:outside,source,env}),{code:'protected_roots_required'});
  assert.throws(()=>runBuild({dest:outside,source,env,typecheck:false}),{code:'protected_roots_required'});
  assert.deepEqual(fs.readFileSync(sentinel),before,'no write to a non-scratch destination');
  assert.deepEqual(fs.readdirSync(outside),['keep.txt'],'no files are created');
  assert.throws(()=>guardDestination({dest:path.join(readOnly,'dist'),source,env}),{code:'protected_roots_required'});
  assert.deepEqual(fs.readdirSync(readOnly),['keep.txt'],'a read-only target is refused before any write');
  const served=path.join(base,'served');fs.mkdirSync(served);
  const declaredEnv={...env,ORBIT_PROTECTED_ROOTS:served};
  assert.ok(guardDestination({dest:path.join(base,'production-out'),source,env:declaredEnv}).canonical_dest,'declared protected roots permit a non-colliding production destination');
  assert.throws(()=>guardDestination({dest:path.join(served,'dist'),source,env:declaredEnv}),{code:'protected_destination'});
});

