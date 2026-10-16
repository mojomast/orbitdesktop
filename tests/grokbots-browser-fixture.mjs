// Browser fixture for the Grok Bots app: stub provider gateways, the real app
// backend (server/grokbots-app.mjs) and a minimal Orbit-like parent page that
// embeds the app in the same sandboxed iframe Orbit uses and answers the host
// bridge ops, recording them in window.__ops. No real bots are contacted.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrokBotsApp } from '../server/grokbots-app.mjs';

export const AGENT = '11111111-2222-4333-8444-555555555555';
export const AGENT2 = '66666666-7777-4888-9999-000000000000';
const APP = fs.readFileSync(new URL('../apps/grokbots/index.html', import.meta.url));
const CSP = "sandbox allow-scripts allow-forms allow-modals allow-downloads; default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline' 'unsafe-eval'; style-src 'self' https: 'unsafe-inline'; connect-src 'self' https:; frame-ancestors 'self'";

const PARENT = `<!doctype html><meta charset="utf-8"><title>Orbit fixture</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe id="app" sandbox="allow-scripts allow-forms allow-modals allow-downloads"></iframe>
<script>
window.__ops=[];window.__hostReply={};const f=document.getElementById('app');
const post=m=>f.contentWindow.postMessage({type:'grokbots-host',...m},'*');
const hello=()=>post({op:'hello',workspaceId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',features:{documents:true,notifications:'granted',voice:true,windows:true}});
addEventListener('message',e=>{if(e.source!==f.contentWindow)return;const d=e.data;if(!d||d.type!=='grokbots')return;
  if(d.op==='hello')return hello();window.__ops.push(d);
  if(d.id){const r=window.__hostReply[d.op];post({re:d.id,ok:r?.ok!==false,data:r?.data??(d.op==='document'?{status:'created-draft'}:null),error:r?.error})}});
window.__insert=(text)=>post({op:'insert',text,id:'ins1'});
f.addEventListener('load',hello);
f.src=location.hash.slice(1)||'/apps/grokbots/';
</script>`;

export async function startFixture({ transcript = [], hermes = [] } = {}) {
  const seen = [];
  const gw = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c); const raw = Buffer.concat(parts).toString('utf8');
    const body = raw ? JSON.parse(raw) : {}; seen.push({ url: req.url, body });
    const json = d => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.url === '/api/listAgents') return json([{ id: AGENT, name: 'Stub Bot', updatedAt: 2, lastMessagePreview: 'Hi' }, { id: AGENT2, name: 'Second Bot', updatedAt: 1 }]);
    if (req.url === '/api/getAgentTranscriptTail') return json({ entries: body.id === AGENT ? transcript : [] });
    if (req.url === '/api/sendPrompt') return json({ accepted: true });
    if (req.url.startsWith('/api/sessions?')) return json({ data: [{ id: 'sess_1', title: 'Hermes planning chat', preview: 'roadmap', message_count: hermes.length }, { id: 'sess_2', title: 'Old notes', preview: 'misc', message_count: 0 }] });
    if (req.url.startsWith('/api/sessions/sess_1/messages')) return json({ data: hermes });
    if (req.url.startsWith('/api/sessions/')) return json({ data: [] });
    if (req.url === '/v1/runs') return json({ run_id: 'run_1' });
    if (req.url.startsWith('/v1/runs/')) return json({ status: 'completed', output: 'done' });
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => gw.listen(0, '127.0.0.1', r));
  const gwUrl = `http://127.0.0.1:${gw.address().port}`;
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-browser-'));
  const key = 'stub-secret-key-0123456789';
  const profiles = { grok: { id: 'grok', provider: 'grok', apiUrl: gwUrl, apiKey: key }, default: { id: 'default', provider: 'hermes', apiUrl: gwUrl, apiKey: key } };
  const catalog = () => ({ list: [{ id: 'default', label: 'Hermes' }, { id: 'grok', label: 'Grok' }], get: id => profiles[id] });
  const workspaceContext = Object.assign(() => 'ctx', { parts: id => ({ operator: `\nOrbit workspace operator block\nWorkspace: ${id}\n`, guide: 'GUIDE', guidePath: 'docs/AGENT_GUIDE.md' }) });
  const app = createGrokBotsApp({ runtimeRoot, catalog, workspaceContext });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PARENT); }
    if (u.pathname === '/apps/grokbots/' || u.pathname === '/apps/grokbots/index.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' }); return res.end(APP); }
    if (u.pathname === '/api/grokbots-app/upload' && app.upload) return app.upload(req, res);
    if (u.pathname === '/api/grokbots-app') return app.handle(req, res);
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, appUrl: app.launchUrl(), seen, runtimeRoot, app, close: async () => { await new Promise(r => server.close(r)); await new Promise(r => gw.close(r)); } };
}
