// OpenSSH's native direct-tcpip channel; no remote session or local listener.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { writeSshConfig } from '../../server/ssh-config.mjs';
import { join } from './client.mjs';

function privateBytes(file,max) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try { const s=fs.fstatSync(fd); if (!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1||s.size>max) throw Error('private_enrollment_required');
    const buf=Buffer.alloc(max+1); const n=fs.readSync(fd,buf,0,buf.length,0); if(n!==s.size)throw Error('enrollment_changed');return buf.subarray(0,n);
  } finally {fs.closeSync(fd);}
}
export async function enrolledSshJoin(enrollment,invite) {
  // This file is provisioned by the owner out of band together with a dedicated
  // permitopen-only identity. The invite is never an endpoint/key source.
  if (!path.isAbsolute(enrollment)||fs.realpathSync(enrollment)!==enrollment) throw Error('private_enrollment_required');
  const parent=path.dirname(enrollment), st=fs.statSync(parent);
  if(st.uid!==process.getuid()||(st.mode&0o077))throw Error('private_enrollment_required');
  const e=JSON.parse(privateBytes(enrollment,4096));
  if(Object.keys(e).sort().join()!=='address,hostKey,peerPort,sshPort,user' || !net.isIPv4(e.address) || !/^(127\.0\.0\.1$|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(e.address) || !/^[a-z_][a-z0-9_-]{0,30}$/.test(e.user) || ![e.sshPort,e.peerPort].every(n=>Number.isInteger(n)&&n>=1&&n<=65535) || !/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/.test(e.hostKey)) throw Error('invalid_enrollment');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-enrolled-ssh-')),agent=new http.Agent(); const children=new Set();
  const close=()=>{agent.destroy();for(const p of children)p.kill();fs.rmSync(root,{recursive:true,force:true});};
  try {
    const config=writeSshConfig([{id:'worker-peer',address:e.address,user:e.user,port:e.sshPort,auth:{kind:'host-key'},transport:{kind:'direct'}}],{runtimeDir:root});
    const key=path.join(parent,'peer.key');privateBytes(key,16384).fill(0);
    fs.mkdirSync(path.join(root,'ssh','keys'),{mode:0o700});fs.symlinkSync(key,path.join(root,'ssh/keys/orbit-host-worker-peer'));
    fs.writeFileSync(path.join(root,'ssh/known_hosts'),`orbit-worker-peer ${e.hostKey}\n`,{mode:0o600});
    agent.createConnection=()=>{
      const child=spawn('/usr/bin/ssh',['-F',config,'-T','-o','ControlMaster=no','-o','ControlPath=none','-o','UpdateHostKeys=no','-o','ForwardAgent=no','-o','IdentityAgent=none','-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no','-o','HostKeyAlgorithms=ssh-ed25519','-W',`127.0.0.1:${e.peerPort}`,'orbit-worker-peer'],{env:{PATH:'/usr/bin:/bin',HOME:root},stdio:['pipe','pipe','ignore']});
      children.add(child);const stream=Duplex.from({readable:child.stdout,writable:child.stdin});
      child.once('error',()=>stream.destroy(Error('ssh_failed')));child.once('close',()=>children.delete(child));stream.once('close',()=>child.kill());return stream;
    };
    const session=await join(invite,{loopback:`http://127.0.0.1:${e.peerPort}`},{only:'loopback',agent});
    return {session,close};
  }catch(err){close();throw err;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{if(process.argv.length!==3)throw Error();const parts=[];let n=0;for await(const p of process.stdin){n+=p.length;if(n>4096)throw Error();parts.push(p);}
    const {session,close}=await enrolledSshJoin(process.argv[2],JSON.parse(Buffer.concat(parts)));try{await session.heartbeat();console.log(JSON.stringify({transport:'openssh',workerId:session.workerId,status:'heartbeat_recorded'}));}finally{close();}
  }catch{console.error('Enrolled SSH join refused. Check the dedicated peer, pinned host key and private enrollment.');process.exitCode=1;}
}
