import {allowedRequest,tokenMatches} from './security.mjs';
import {TRACE_LIMITS} from '../contracts/run-trace-v1.mjs';
import {wbError} from './workbench-store.mjs';
export function createRunTracesHandler({token,port,devOrigins,reply,traces}){
  const handler=async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST')return reply(res,405,{ok:false,code:'invalid_request'});
    const auth=req.headers.authorization??'';
    if(!allowedRequest(req,port,devOrigins)||!auth.startsWith('Bearer ')||!tokenMatches(auth.slice(7),token))return reply(res,403,{ok:false,code:'permission_denied'});
    try{let size=0;const chunks=[];for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>TRACE_LIMITS.requestBytes)throw wbError('limit_exceeded');chunks.push(Buffer.from(chunk));}
      let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw wbError('invalid_request');}
      if(!traces)throw wbError('unavailable');const result=await traces.dispatch(body);if(Buffer.byteLength(JSON.stringify(result))>TRACE_LIMITS.exportBytes+65536)throw wbError('limit_exceeded');return reply(res,200,{...result,ok:true});
    }catch(error){const statuses={invalid_request:400,permission_denied:403,unavailable:503,limit_exceeded:413};const code=Object.hasOwn(statuses,error.code)?error.code:'unavailable';return reply(res,statuses[code],{ok:false,code});}
  };handler.close=()=>{};return handler;
}
