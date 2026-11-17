// Config builder only. v0.7.0 README: serve --key=new and forward ADDR L:R.
// An upstream version reference is NOT owner approval for shipping a binary.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function tailcatPlan({approvedRelease,approvedSha256,binary,clientNodeKey,address,peerPort}) {
  if(approvedRelease!=='v0.7.0'||!/^([a-f0-9]{64})$/.test(approvedSha256)||!path.isAbsolute(binary)||fs.realpathSync(binary)!==binary)throw Error('approved_local_artifact_required');
  if(!/^nodekey:[a-f0-9]{64}$/.test(clientNodeKey)||!/^tc[A-Za-z0-9_-]{16,1024}$/.test(address)||!Number.isInteger(peerPort)||peerPort<1024||peerPort>65535)throw Error('invalid_peer_config');
  const fd=fs.openSync(binary,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size<1||st.size>128*1024*1024||st.mode&0o022)throw Error('unsafe_binary');
    const hash=createHash('sha256'),buf=Buffer.alloc(65536);let total=0,n;
    while((n=fs.readSync(fd,buf,0,buf.length,null))>0){total+=n;if(total>st.size)throw Error('binary_changed');hash.update(buf.subarray(0,n));}
    if(total!==st.size||hash.digest('hex')!==approvedSha256)throw Error('digest_mismatch');
  }finally{fs.closeSync(fd);}
  const plan={release:approvedRelease,sha256:approvedSha256,peerPort,nativeHandshake:'not_run'};
  // Address contains PSK material. Do not serialize or log client argv.
  Object.defineProperty(plan,'argv',{enumerable:false,value:Object.freeze({
    coordinator:Object.freeze([binary,'serve','--key=new',`--allow=${clientNodeKey}`,String(peerPort)]),
    client:Object.freeze([binary,'forward',address,`${peerPort}:${peerPort}`]),
  })});return Object.freeze(plan);
}
