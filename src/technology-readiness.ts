type Descriptor = {surface_uri:string;readiness:{detail:string};formats:string[];delegated?:{availability:string}};
type Snapshot = {observed_at:string;features:Descriptor[]};
/** The cached view is bound to both host credentials and workspace identity. */
export function createTechnologyReadiness(identity:()=>{token:string;workspace:string},changed:()=>void,request:typeof fetch=fetch,now=Date.now) {
  let generation=0, binding='', snapshot:Snapshot|null=null, received=0, pending=false;
  const key=()=>JSON.stringify(identity());
  function invalidate(){generation++;binding=key();snapshot=null;received=0;pending=false;}
  async function refresh(force=false){
    if(binding!==key()){invalidate();changed();}
    if(!identity().token)return;
    if(!force&&(pending||snapshot&&now()-received<30000))return;
    const serial=++generation, captured=key(), token=identity().token;
    pending=true;
    if(force||snapshot&&now()-received>=30000){snapshot=null;changed();}
    try{
      const response=await request('/api/technology-capabilities',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({action:'capabilities'}),cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('unavailable');
      const data=(await response.json()).descriptors;
      if(serial!==generation||captured!==key())return;
      if(!data||!Array.isArray(data.features)||!Number.isFinite(Date.parse(data.observed_at))||Math.abs(now()-Date.parse(data.observed_at))>30000)throw Error('stale');
      snapshot=data;received=now();changed();
    }catch{if(serial===generation&&captured===key()){snapshot=null;changed();}}
    finally{if(serial===generation)pending=false;}
  }
  function detail(surface:string,fallback:string){
    if(binding!==key())invalidate();
    const fresh=snapshot&&now()-received<30000&&Math.abs(now()-Date.parse(snapshot.observed_at))<30000;
    const descriptor=fresh?snapshot?.features.find(item=>item.surface_uri===`orbit://surface/${surface}`):null;
    const observed=descriptor?`${descriptor.readiness.detail} Formats: ${descriptor.formats.join(', ')}. Checked ${snapshot!.observed_at}.`:`${fallback}. Prerequisites unknown; refresh on connection or action.`;
    const authority=descriptor?.delegated?.availability==='unsupported'?'Agent tools unsupported':descriptor?.delegated?.availability==='not_granted'?'Agent tools require a separate grant':'Agent authority not granted';
    return `Open surface · Owner use checked on action · ${authority}. ${observed}`;
  }
  return {refresh,detail};
}
