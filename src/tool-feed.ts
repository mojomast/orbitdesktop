// Explicitly reviewed, read-only bridge for this exact published bundle only.
// Never passes credentials, previews, arguments, outputs or conversation text.
export const toolFeedEntry = '/apps/hermes-live-tools-e7dcfb294c1fa5eabae242f1/index.html';
export interface ToolEvent { event: string; tool: string; timestamp: number; duration?: number; error: boolean }
export function sanitizeToolEvent(raw: unknown): ToolEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (!['tool.started', 'tool.completed', 'tool.failed'].includes(String(d.event))) return null;
  if (typeof d.tool !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(d.tool)) return null;
  return { event: String(d.event), tool: d.tool, timestamp: typeof d.timestamp === 'number' && Number.isFinite(d.timestamp) ? d.timestamp : Date.now()/1000,
    ...(typeof d.duration === 'number' && Number.isFinite(d.duration) ? {duration: Math.max(0,d.duration)} : {}), error: d.error === true || d.event === 'tool.failed' };
}
const sinks = new Set<HTMLIFrameElement>();
const events: ToolEvent[] = [];
const sources = new Map<string, string>();
function broadcast() {
  const statuses = [...sources.values()];
  const status = statuses.includes('Live') ? 'Live · listening for tool events' : statuses.find(s => s !== 'Idle') || 'Idle · waiting for the next Orbit request';
  for (const frame of sinks) if (frame.isConnected) frame.contentWindow?.postMessage({type:'orbit:tool-feed', status, events}, '*');
}
export function bindToolFeed(frame: HTMLIFrameElement) {
  const url = new URL(frame.src, location.origin);
  if (url.origin !== location.origin || ![toolFeedEntry, '/apps/hermes-live-tools-e097e098480d740f42628431/index.html'].includes(url.pathname)) return () => {};
  sinks.add(frame); frame.addEventListener('load', broadcast);
  const timer = setInterval(broadcast, 1000);
  return () => {clearInterval(timer); sinks.delete(frame); frame.removeEventListener('load',broadcast);};
}
export function watchToolFeed(id: string, state: () => {session:string;run?:string;profile_id?:string;binding_revision?:number}, token: () => string, inline: { enabled: () => boolean; event: (raw: Record<string, unknown>, run: string) => void; status: (text: string) => void } | undefined, workspaceId: string) {
  let abort: AbortController | undefined, current = '', stopped = false, retry = 0;
  const seen = new Set<string>();
  const identity = (s: ReturnType<typeof state>) => `${s.profile_id || 'default'}\u0000${s.session}\u0000${s.binding_revision || 0}\u0000${s.run || ''}`;
  async function tick() {
    const s = state();
    const binding = identity(s);
    if (current && current !== binding) { abort?.abort(); abort=undefined; current=''; retry=0; }
    if ((!sinks.size && !inline?.enabled()) || !s.run || !token()) {
      abort?.abort(); abort=undefined; current='';
      sources.set(id, !token() ? 'Connect host to receive live tools' : 'Idle'); return;
    }
    if (binding === current || Date.now() < retry) return;
    abort?.abort(); const controller = new AbortController(); abort=controller; current=binding;
    sources.set(id,'Connecting…'); inline?.status('Connecting to live tools…'); broadcast();
    try {
      const r = await fetch('/api/agent',{method:'POST',headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json'},body:JSON.stringify({action:'events',workspace_id:workspaceId,pane_id:id,profile_id:s.profile_id || 'default',session_id:s.session,run_id:s.run,expected_binding_revision:s.binding_revision ?? 0}),signal:controller.signal});
      if (!r.ok || !r.body) throw Error('Stream unavailable');
      if (stopped || identity(state()) !== binding) return;
      sources.set(id,'Live'); inline?.status('Live · waiting for tool events'); broadcast();
      const reader=r.body.getReader(), decoder=new TextDecoder(); let buffer='';
      while (!stopped && identity(state()) === binding) {
        const {value,done}=await reader.read(); if(done) break;
        buffer+=decoder.decode(value,{stream:true}); buffer=buffer.replace(/\r\n/g,'\n');
        if(buffer.length>1000000) throw Error('Oversized event');
        let pos;
        while((pos=buffer.indexOf('\n\n'))>=0) {
          const block=buffer.slice(0,pos); buffer=buffer.slice(pos+2);
          const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
          if (!data) continue;
          let raw; try {raw=JSON.parse(data);} catch {continue;}
          if (raw && typeof raw === 'object' && inline?.enabled() && identity(state()) === binding) {
            const kind = block.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim();
            inline.event({...raw, event: raw.event || kind}, s.run);
          }
          const event=sanitizeToolEvent(raw); if(!event) continue;
          if (identity(state()) !== binding) break;
          const key=binding+JSON.stringify(event); if(seen.has(key)) continue;
          seen.add(key); if(seen.size>1000) seen.delete(seen.values().next().value!);
          events.push(event); if(events.length>80) events.shift(); broadcast();
        }
      }
      if(!controller.signal.aborted && identity(state()) === binding) { sources.set(id,'Stream ended · waiting for next request'); inline?.status('Stream ended · saved details remain available; replay is not guaranteed'); }
    } catch {if(!controller.signal.aborted && identity(state()) === binding) {sources.set(id,'Disconnected · retrying (events may be missed)'); inline?.status('Live stream unavailable · retrying; use saved Tool activity for history');}}
    finally {if(abort===controller){current='';abort=undefined;retry=Date.now()+5000;broadcast();}}
  }
  const timer=setInterval(()=>{void tick();},1000); void tick();
  return ()=>{stopped=true;clearInterval(timer);abort?.abort();sources.delete(id);broadcast();};
}
