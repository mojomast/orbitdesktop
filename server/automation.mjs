const fields=['name','prompt','schedule','deliver','skills'];
export async function automation(body,upstream){
 const op=body.operation;
 if(!['get','create','update','delete','run'].includes(op))throw Error('Unknown automation operation');
 const id=body.job_id;
 if(op!=='create'&&(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))throw Error('Invalid job ID');
 const path='/api/jobs'+(op==='create'?'':'/'+encodeURIComponent(id));
 const clean=j=>Object.fromEntries(['id',...fields].filter(k=>j?.[k]!==undefined).map(k=>[k,j[k]]));
 if(op==='get')return {job:clean((await upstream(path)).job)};
 if(body.confirm!==true)throw Error('Explicit confirmation required');
 if(op==='delete'){await upstream(path,undefined,'DELETE');return {accepted:true};}
 if(op==='run'){await upstream(path+'/run',{});return {accepted:true};}
 const data=body.fields;
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!fields.includes(k)))throw Error('Unsupported automation fields');
 for(const k of ['name','prompt','schedule','deliver'])if(typeof data[k]!=='string'||data[k].length>(k==='prompt'?16000:500))throw Error('Invalid '+k);
 if(!data.name.trim()||!data.schedule.trim()||!data.prompt.trim())throw Error('Name, schedule and prompt required');
 if(!Array.isArray(data.skills)||data.skills.length>20||data.skills.some(s=>typeof s!=='string'||!s.trim()||s.length>100))throw Error('Invalid skills');
 const response=await upstream(path,data,op==='create'?'POST':'PATCH');return {job:clean(response.job)};
}
