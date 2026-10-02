import {allowedRequest, tokenMatches} from './security.mjs';

const statuses = Object.freeze({invalid_request:400,permission_denied:403,unauthorized:403,not_found:404,resource_gone:410,revoked:410,expired:410,stale_resource:409,conflict:409,operation_mismatch:409,submission_unknown:409,outcome_unknown:409,unsupported:422,unavailable:503,limit_exceeded:413,busy:429});
/** Owner-only JSON boundary. Public errors never include arbitrary exception text. */
export function technologyOwnerRoute({token,port,devOrigins,reply,dispatch,maxBytes=1024*1024,maxResponseBytes=2*1024*1024,publicReasons=[],publicDetail=false,conflictDetails=()=>({})}) {
  return async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST')return reply(res,405,{ok:false,code:'invalid_request'});
    const auth=req.headers.authorization;
    if(!allowedRequest(req,port,devOrigins)||typeof auth!=='string'||!auth.startsWith('Bearer ')||!tokenMatches(auth.slice(7),token))return reply(res,403,{ok:false,code:'permission_denied'});
    try {
      let bytes=0;const chunks=[];
      for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>maxBytes)throw {code:'limit_exceeded'};chunks.push(Buffer.from(chunk));}
      let body;
      try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw {code:'invalid_request'};}
      const result=await dispatch(body);
      const response={...result,ok:true};
      if(Buffer.byteLength(JSON.stringify(response))>maxResponseBytes)throw {code:'limit_exceeded'};
      return reply(res,200,response);
    } catch(error) {
      const code=Object.hasOwn(statuses,error?.code)?error.code:'unavailable';
      const revision=error?.current_revision??error?.currentRevision??error?.revision;
      const details=['conflict','stale_resource'].includes(code)?conflictDetails(error):{};
      const response={ok:false,code,error:code,
        ...(publicReasons.includes(error?.reason)?{reason:error.reason}:{}),
        ...(publicDetail&&typeof error?.detail==='string'?{detail:error.detail.slice(0,500)}:{}),
        ...(['conflict','stale_resource'].includes(code)&&Number.isSafeInteger(revision)&&revision>=0?{current_revision:revision,revision}:{}),...details,
      };
      return reply(res,statuses[code],Buffer.byteLength(JSON.stringify(response))<=maxResponseBytes?response:{ok:false,code,error:code});
    }
  };
}

/** Single-flight lazy initialization; optional failures leave the core server usable. */
export function lazyTechnologyService(load) {
  let pending,service,closed=false;
  return {
    async get(){
      if(closed)throw {code:'unavailable'};
      pending??=Promise.resolve().then(load).then(async value=>{if(closed){await value.close?.();throw {code:'unavailable'};}service=value;return value;}).catch(()=>{throw {code:'unavailable'};});
      return pending;
    },
    async dispatch(body){return (await this.get()).dispatch(body);},
    async close(){closed=true;if(service)await service.close?.();else await pending?.catch(()=>{});},
  };
}
