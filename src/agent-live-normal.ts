import type { LiveItem, LiveStatus } from './agent-live-types';
import type { createLiveTimeline } from './agent-live-timeline';

type Timeline = ReturnType<typeof createLiveTimeline>;
const text = (value: unknown, limit=120): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit) : '';
const timestamp = (value: unknown): number | null => {
  if(typeof value==='number'&&Number.isFinite(value)&&value>=0)return Math.round(value<1e12?value*1000:value);
  if(typeof value==='string'&&value.length<=40){const parsed=Date.parse(value);if(Number.isFinite(parsed))return parsed;}
  return null;
};
const asRecord = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const eventName = (raw: Record<string,unknown>) => text(raw.event || raw.type,80).toLowerCase();
const toolStatus = (name: string): LiveStatus => /denied/.test(name) ? 'denied' : /fail|error/.test(name) ? 'failed' : /start|running|call/.test(name) ? 'running' : /complet|result|output/.test(name) ? 'completed' : 'unknown';
const categoryFor = (name: string): 'files'|'tools' => /file|read|write|directory|search/.test(name.toLowerCase()) ? 'files' : 'tools';
const safeId = (value: unknown): string => text(value,100).replace(/[^\w:.-]/g,'').slice(0,100);

export function createNormalLiveAdapter(timeline: Timeline) {
  let binding = '', serial=0;
  const observed = new Map<string,LiveItem>();
  const emit = () => timeline.upsert([...observed.values()]);
  return {
    counts() { const tools=[...observed.values()].filter(item=>item.category==='tools'||item.category==='files'); return {events:tools.length,failures:tools.filter(item=>item.status==='failed'||item.status==='denied'||item.status==='unknown').length}; },
    event(raw: unknown) {
      const d=asRecord(raw), name=eventName(d);
      if (!/^tool[._]/.test(name)) return;
      const tool=text(d.tool || d.tool_name || d.name,80); if (!tool || !/^[\w.:-]+$/.test(tool)) return;
      const id=safeId(d.tool_call_id || d.toolCallId || d.call_id || d.callId) || `observation-${++serial}`;
      const status=toolStatus(name), refId=safeId(d.reference_id || d.tool_call_id || d.toolCallId || d.call_id || d.callId);
      const item: LiveItem={version:1,id:`normal:${binding}:${id}`,at:timestamp(d.timestamp),authority:'observed',category:categoryFor(tool),kind:status==='failed'?'Tool failed':status==='running'?'Tool started':status==='completed'?'Tool completed':'Tool event',summary:`${tool} · ${status==='unknown'?'activity observed':status}`,status,target:tool,...(typeof d.duration==='number'&&Number.isFinite(d.duration)?{duration_ms:Math.max(0,Math.min(d.duration*1000,86400000))}:{}),...(refId?{reference:{kind:'normal-tool',id:refId}}:{})};
      observed.set(item.id,item); trim(); emit();
    },
    saved(rows: unknown[]) {
      for (const raw of rows.slice(-100)) {
        const d=asRecord(raw), kind=text(d.kind,20), name=text(d.name,80), id=safeId(d.id);
        if (!['call','result'].includes(kind) || !name) continue;
        const failed=kind==='result' && d.error===true;
        const item:LiveItem={version:1,id:`saved:${binding}:${kind}:${id||++serial}`,at:timestamp(d.timestamp),authority:'agent',category:categoryFor(name),kind:kind==='call'?'Tool call saved':'Tool result saved',summary:`${name} · ${kind==='call'?'call recorded':failed?'result failed':'result recorded'}`,status:failed?'failed':'completed',target:name,...(id?{reference:{kind:'normal-tool',id}}:{})};
        observed.set(item.id,item);
      }
      trim(); emit();
    },
    status(value: {status: unknown;run?: unknown;at?: unknown}) {
      const status=text(value.status,100); if(!status)return;
      const key=`status:${binding}:${safeId(value.run)||'current'}`;
      const waiting=/approval|wait|attention/i.test(status), failed=/fail|error/i.test(status), done=/completed|finished/i.test(status);
      const item:LiveItem={version:1,id:key,at:timestamp(value.at)??Date.now(),authority:'agent',category:failed||waiting?'warnings':'agent',kind:'Run status',summary:status,status:failed?'failed':waiting?'waiting':done?'completed':'info'};
      observed.set(key,item);trim();emit();
    },
    reset(nextBinding: string) { binding=text(nextBinding,200); serial=0; observed.clear(); timeline.reset(); },
    connection(state: Parameters<Timeline['setConnection']>[0], message?: string) {
      timeline.setConnection(state, state==='disconnected' ? 'Events may be missed; exact replay unavailable' : message);
    },
  };
  function trim() {
    if(observed.size<=500)return;
    const ranked=[...observed.values()].sort((a,b)=>{const keep=(x:LiveItem)=>x.status==='running'||x.status==='failed'?1:0;return keep(b)-keep(a)||(b.at??0)-(a.at??0);});
    while(observed.size>500){const item=ranked.pop();if(item)observed.delete(item.id);}
  }
}
