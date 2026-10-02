import {allowedRequest,tokenMatches} from './security.mjs';
import {COPILOT_LIMITS} from '../contracts/browser-copilot-v1.mjs';
export function createBrowserCopilotHandler({token,port,devOrigins=[],reply,copilot}){
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST')return reply(res,405,{ok:false,code:'invalid_request'});
    const auth=req.headers.authorization||'';
    if(!allowedRequest(req,port,devOrigins)||!auth.startsWith('Bearer ')||!tokenMatches(auth.slice(7),token))return reply(res,403,{ok:false,code:'permission_denied'});
    try{
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>COPILOT_LIMITS.requestBytes)throw Object.assign(Error(),{code:'limit_exceeded'});chunks.push(chunk);}
      let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw Object.assign(Error(),{code:'invalid_request'});}
      if(!copilot)throw Object.assign(Error(),{code:'unavailable'});const result=await copilot.dispatch(body);
      if(Buffer.byteLength(JSON.stringify(result))>4*1024*1024)throw Object.assign(Error(),{code:'limit_exceeded'});
      return reply(res,200,{...result,ok:true});
    }catch(error){const statuses={invalid_request:400,permission_denied:403,stale_resource:409,conflict:409,unsupported:422,unavailable:503,limit_exceeded:413,busy:429};const code=Object.hasOwn(statuses,error.code)?error.code:'unavailable';return reply(res,statuses[code],{ok:false,code});}
  };
}
