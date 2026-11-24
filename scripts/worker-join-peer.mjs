// A dedicated worker-only destination for an owner-enrolled OpenSSH channel.
// Never forward a port serving the full Orbit owner/terminal interface.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import { createWorkerJoinRoute } from '../server/worker-join-route.mjs';

export async function openPeer(runtimeRoot,port) {
  if (!path.isAbsolute(runtimeRoot) || !statSync(path.join(runtimeRoot,'worker-join','registry.sqlite')).isFile() || !Number.isInteger(port) || port < 0 || port > 65535) throw Error('existing_registry_and_port_required');
  let handler;
  const server = http.createServer({requestTimeout:5000,headersTimeout:5000},(req,res)=>handler.handle(req,res));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  handler = createWorkerJoinRoute({ runtimeRoot,port:server.address().port,env:{},peerOnly:true });
  return { port:server.address().port, close:async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});handler.close();} };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  if (process.argv.length!==4 || !/^[1-9][0-9]{0,4}$/.test(process.argv[3])) throw Error('usage: worker-join-peer.mjs PRIVATE_RUNTIME PORT');
  const peer=await openPeer(process.argv[2],Number(process.argv[3]));
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>void peer.close());
}
