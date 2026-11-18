import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {createRailsProxy} from '../server/rails-proxy.mjs';

const key = () => randomBytes(32).toString('hex');
async function listen(t, callback) {
  const server = http.createServer(callback);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

test('only fixed paths, scoped credentials, explicit same-origin mutations and bounded streams', async t => {
  const owner = key(), reader = key(), writer = key(), hits = [];
  const upstreamPort = await listen(t, async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    hits.push({path:req.url, headers:req.headers, body:Buffer.concat(chunks).toString()});
    if (req.url.startsWith('/v1/stream')) {
      res.writeHead(200, {'Content-Type':'text/event-stream'}); res.write('id: page2\ndata: {}\n\n'); return;
    }
    if(req.url.includes('redirect')) { res.writeHead(302,{location:'/not-allowed'}); return res.end(); }
    res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'ignored=1'}); res.end('{"ok":true}');
  });
  let handler; const port = await listen(t,(req,res)=>handler(req,res));
  const base = `http://127.0.0.1:${port}`, path = base+'/api/rizzstack/rails/';
  handler = createRailsProxy({token:owner,port,upstreamPort,readToken:reader,mutationToken:writer});
  const headers = {Origin:base,Authorization:`Bearer ${owner}`};
  const feedback = {target_event_id:'event-1',rating:1,category:'quality',note:'',supersedes_event_id:null,idempotency_key:'click-1'};
  const post = {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(feedback)};
  assert.equal((await fetch(path+'health')).status,401);
  assert.equal((await fetch(path+'health',{headers:{...headers,Authorization:'Bearer '+reader}})).status,403);
  for(const origin of ['null','https://other.invalid'])
    assert.equal((await fetch(path+'feedback',{...post,headers:{...post.headers,Origin:origin}})).status,403);
  assert.equal((await fetch(path+'append',post)).status,404);
  assert.equal((await fetch(path+'view?kind=job&id=example&token=none',{headers})).status,400);
  // Current admitted R12 has no trusted mutation attachment (including feedback).
  assert.equal((await fetch(path+'feedback',{...post,body:JSON.stringify({...feedback,actor:'owner'})})).status,503);
  assert.equal((await fetch(path+'interventions',post)).status,503);
  assert.equal(hits.length,0);
  const response = await fetch(path+'view?kind=attempt&id=att-1',{headers});
  assert.equal(response.status,200); assert.equal(response.headers.get('set-cookie'),null);
  assert.equal(hits.at(-1).headers.authorization,'Bearer '+reader);
  assert.equal(hits.at(-1).headers.origin,undefined);
  assert.equal((await fetch(path+'view?kind=job&id=redirect',{headers})).status,503);
  assert.equal((await fetch(path+'feedback',post)).status,503);
  assert.equal(hits.some(hit=>hit.headers.authorization==='Bearer '+writer),false);
  const stream = await fetch(path+'stream?kind=attempt&id=att-1',{headers:{...headers,'Last-Event-ID':'page1'},signal:AbortSignal.timeout(3000)});
  assert.equal(stream.headers.get('x-accel-buffering'),'no');
  assert.equal(hits.at(-1).headers['last-event-id'],'page1');
  const body = stream.body.getReader(); assert.match(new TextDecoder().decode((await body.read()).value),/id: page2/); await body.cancel();
});
