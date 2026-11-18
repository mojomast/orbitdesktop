/** Local invalidation hints for one explicitly inspected, host-selected R12
 * query. No transport, evidence projection, event queue or credential here. */
export type HiveFollowSignal = 'following'|'invalidated'|'gap'|'reconnecting'|'idle';
type Cursor = {ledger:string, scope:string, position:number};

function decode(token:string):Cursor|undefined {
  // The fixed reader's stream.cursor (never the query's `after` cursor).
  // Fail closed on a new encoding. Never use this as an authorization check:
  // R12 itself checks the supplied Last-Event-ID against the requested scope.
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) return;
  try {
    const raw=atob(token.replace(/-/g,'+').replace(/_/g,'/'));
    const m=/^\["([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})","([a-f0-9]{64})",(0|[1-9]\d{0,15})\]$/.exec(raw);
    if(m && Number.isSafeInteger(Number(m[3])) && btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')===token)
      return {ledger:m[1],scope:m[2],position:Number(m[3])};
  } catch { /* Not a canonical R12 cursor. */ }
}

export class HiveFollow {
  private head?:Cursor;
  private interrupted?:Cursor;
  private ready=false;
  private state:Exclude<HiveFollowSignal,'invalidated'>='idle';
  private pending?:ReturnType<typeof setTimeout>;
  private readonly notify:(s:HiveFollowSignal)=>void;
  constructor(notify:(s:HiveFollowSignal)=>void){this.notify=notify;}
  get following(){return this.ready;}

  private retire(){clearTimeout(this.pending);this.pending=undefined;this.ready=false;this.head=undefined;}
  private status(next:typeof this.state){if(this.state!==next){this.state=next;this.notify(next);}}
  // Each connection starts from an authoritative first page, including after
  // an outage. Marks recovered by that read are never dispatched as live.
  begin(cursor:string){
    this.retire();const next=decode(cursor),prev=this.interrupted;
    if(prev&&(!next||next.ledger!==prev.ledger||next.scope!==prev.scope||next.position<prev.position))this.gap();
    this.head=next;return !!next;
  }
  gap(){this.retire();if(this.state!=='idle')this.status('gap');return 'gap' as const;}
  disconnected(){if(this.ready)this.interrupted=this.head;this.retire();if(this.state==='following')this.status('reconnecting');}
  close(){this.interrupted=undefined;this.retire();this.status('idle');}

  frame(text:string):'ready'|'invalidate'|'skip'|'gap' {
    const head=this.head;
    if(!head)return this.gap();
    if(text===': heartbeat')return 'skip';
    const m=text.length<=1024 && /^id: ([A-Za-z0-9_-]{1,512})\nevent: (ready|invalidate)\ndata: \{\}$/.exec(text);
    const next=m && decode(m[1]);
    if(!m||!next)return this.gap();
    if(next.scope!==head.scope)return 'skip';
    if(next.ledger!==head.ledger)return this.gap();
    if(!this.ready){
      if(m[2]!=='ready'||next.position!==head.position)return this.gap();
      this.interrupted=undefined;this.ready=true;this.status('following');return 'ready';
    }
    if(next.position<=head.position)return 'skip'; // duplicate or delayed replay
    if(m[2]!=='invalidate')return this.gap();
    // Position is ledger-wide; other selectors need not produce any frames.
    this.head=next;return 'invalidate';
  }

  // A refetch can already cover several frames buffered by the same stream.
  covered(cursor:string){
    const next=decode(cursor),head=this.head;
    if(!this.ready||!next||!head||next.scope!==head.scope||next.ledger!==head.ledger||next.position<head.position){this.gap();return false;}
    this.head=next;return true;
  }
  changed(){
    if(this.ready&&this.pending===undefined)this.pending=setTimeout(()=>{
      this.pending=undefined;if(this.ready)this.notify('invalidated');
    },250); // One bounded wakeup per burst; host still owns the 30s read floor.
  }
}
