// A read-only SSE decoder. Original bytes remain the forwarding caller's property.
// Oversized frames are dropped through the next blank line, never partially parsed.
export function createRunTraceTee({binding,onRunEvent,maxFrameBytes=32768,maxEvents=4000,onError=()=>{}}){
  const decoder=new TextDecoder();let buffer='',dropping=false,count=0;
  const fail=()=>{try{onError();}catch{}try{onRunEvent?.({...binding,event:{event:'trace.gap'},at:Date.now()});}catch{}};
  return {write(chunk){try{
    buffer+=decoder.decode(chunk,{stream:true});
    let match;
    while((match=/\r?\n\r?\n/.exec(buffer))){
      const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
      if(dropping){dropping=false;continue;}
      if(Buffer.byteLength(frame)>maxFrameBytes||++count>maxEvents){fail();continue;}
      const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data||data==='[DONE]')continue;
      try{const event=JSON.parse(data);onRunEvent?.({...binding,event,at:Date.now()});}catch{fail();}
    }
    if(Buffer.byteLength(buffer)>maxFrameBytes){buffer=buffer.slice(-2);dropping=true;fail();}
  }catch{buffer='';dropping=true;fail();}},close(){buffer='';}};
}
