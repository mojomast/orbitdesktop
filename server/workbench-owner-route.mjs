import {allowedRequest,tokenMatches} from './security.mjs';
import {wbError} from './workbench-store.mjs';

// Context/candidate requests need a larger bounded body than metadata inspection.
// No controller capability, plugin bridge, actor label or context ID authenticates.
export function workbenchOwnerRoute({token,port,devOrigins,reply,dispatch,maxBytes=1024*1024}){
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST')return reply(res,405,{ok:false,code:'invalid_request'});
    const auth=req.headers.authorization??'';
    if(!allowedRequest(req,port,devOrigins)||!auth.startsWith('Bearer ')||!tokenMatches(auth.slice(7),token))return reply(res,403,{ok:false,code:'permission_denied'});
    try{
      let bytes=0;const chunks=[];
      for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>maxBytes)throw wbError('limit_exceeded');chunks.push(Buffer.from(chunk));}
      let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw wbError('invalid_request');}
      const result=await dispatch(body);
      if(Buffer.byteLength(JSON.stringify(result??{}))>2*1024*1024)throw wbError('limit_exceeded');
      return reply(res,200,{...result,ok:true});
    }catch(error){
      const statuses={invalid_request:400,permission_denied:403,unauthorized:403,revoked:410,expired:410,stale_resource:409,conflict:409,submission_unknown:409,outcome_unknown:409,unsupported:422,unavailable:404,limit_exceeded:413,busy:429};
      const code=Object.hasOwn(statuses,error.code)?error.code:'unavailable';
      return reply(res,statuses[code],{ok:false,code,error:code});
    }
  };
}
