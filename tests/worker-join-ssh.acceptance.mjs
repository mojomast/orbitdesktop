import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import {joinFixture} from './fixtures/worker-join.mjs';
import {openPeer} from '../scripts/worker-join-peer.mjs';
import {enrolledSshJoin} from '../scripts/worker-join/ssh-peer.mjs';

test('an enrolled OpenSSH direct-tcpip identity reaches only the worker peer',async t=>{
  assert.equal(process.env.ORBIT_DISPOSABLE_SSH_TEST,'1','run only in disposable namespace with synthetic account database');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-ssh-peer-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=await joinFixture(t), invite=await f.invite(), peer=await openPeer(f.dir,0); t.after(()=>peer.close());
  const target=await fetch(`http://127.0.0.1:${peer.port}/api/local-workers`,{method:'POST',headers:{Origin:`http://127.0.0.1:${peer.port}`,Authorization:`Bearer ${f.owner}`,'Content-Type':'application/json'},body:'{"op":"inventory"}'}); assert.equal(target.status,403);
  const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  for(const key of ['host','peer.key'])execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-C','fixture','-f',path.join(dir,key)]);
  const pub=key=>fs.readFileSync(path.join(dir,key+'.pub'),'utf8').trim().split(' ').slice(0,2).join(' ');
  fs.writeFileSync(path.join(dir,'authorized'),`restrict,port-forwarding,permitopen="127.0.0.1:${peer.port}" ${pub('peer.key')}\n`,{mode:0o600});
  fs.writeFileSync(path.join(dir,'sshd_config'),[
    'ListenAddress 127.0.0.1',`Port ${port}`,`HostKey ${dir}/host`,`AuthorizedKeysFile ${dir}/authorized`,`PidFile ${dir}/sshd.pid`,
    'UsePAM no','AuthenticationMethods publickey','PasswordAuthentication no','KbdInteractiveAuthentication no','PermitRootLogin prohibit-password','AllowUsers root',
    'MaxSessions 0','PermitTTY no','AllowTcpForwarding local',`PermitOpen 127.0.0.1:${peer.port}`,'AllowStreamLocalForwarding no','PermitTunnel no','X11Forwarding no','AllowAgentForwarding no','LogLevel VERBOSE','',
  ].join('\n'),{mode:0o600});
  const systemPeer=process.env.ORBIT_TEST_PARAMIKO_PEER==='1';
  const sshd=spawn(systemPeer?'/usr/bin/python3':'/usr/sbin/sshd',systemPeer?['-I','-B','tests/fixtures/worker-join-ssh-server.py',dir,String(port),String(peer.port)]:['-D','-e','-f',path.join(dir,'sshd_config')],{stdio:['ignore','ignore','pipe'],env:{PATH:'/usr/sbin:/usr/bin:/bin',HOME:dir}});
  t.after(async()=>{if(sshd.exitCode===null&&sshd.signalCode===null){const exit=new Promise(r=>sshd.once('exit',r));sshd.kill();await exit;}});
  let log='';sshd.stderr.on('data',c=>{log=(log+c).slice(-4096);});for(let n=0;n<100&&!log.includes('Server listening')&&sshd.exitCode===null;n++)await pause(30);
  assert.match(log,/Server listening/);
  const file=path.join(dir,'enrollment.json');const write=(hostKey,peerPort)=>fs.writeFileSync(file,JSON.stringify({address:'127.0.0.1',sshPort:port,user:'root',peerPort,hostKey}),{mode:0o600});
  write(pub('peer.key'),peer.port);await assert.rejects(enrolledSshJoin(file,invite),{code:'no_verified_transport'});
  write(pub('host'),Number(new URL(f.origin).port));await assert.rejects(enrolledSshJoin(file,invite),{code:'no_verified_transport'});
  write(pub('host'),peer.port);const {session,close}=await enrolledSshJoin(file,invite).catch(e=>{t.diagnostic(log);throw e;});t.after(close);
  await session.heartbeat();await f.post({op:'revoke',workerId:session.workerId},f.auth);await assert.rejects(session.heartbeat(),{code:'credential_denied'});
});
