// Deliberate private detail read. Never persist source bytes in activity rows.
export async function readLiveCandidateDiff({execution,candidate,workspace_id,project_id,reference,comparison='previous',file_path}){
  const selected={candidate_id:candidate.id,generation:reference.generation,candidate_hash:reference.hash};
  const scope={workspace_id,project_id};
   if(!Number.isSafeInteger(selected.generation)||typeof selected.candidate_hash!=='string')return {available:false,comparison,to:selected,reason:'exact_generation_required'};
   const originGeneration=comparison==='initial'?1:selected.generation-1;
   const previous=(candidate.root_history??[]).find(item=>item.generation===originGeneration)
     ??(candidate.generation===originGeneration?candidate:null);
   if(!previous)return {available:false,comparison,to:selected,reason:'historical_diff_unavailable',current_generation:candidate.generation};
  const prior={candidate_id:candidate.id,generation:previous.generation,candidate_hash:previous.hash};
  try{
    const [oldVersion,newVersion]=await Promise.all([prior,selected].map(version=>execution.dispatch({action:'candidate_version_get',...scope,...version})));
    const oldFiles=new Map(oldVersion.candidate.files.map(file=>[file.path,file]));
    const newFiles=new Map(newVersion.candidate.files.map(file=>[file.path,file]));
    const changed=[...new Set([...oldFiles.keys(),...newFiles.keys()])].sort().filter(path=>{const old=oldFiles.get(path),next=newFiles.get(path);return old?.hash!==next?.hash||old?.mode!==next?.mode;});
    if(file_path!==undefined&&!changed.includes(file_path))return {available:false,comparison,from:prior,to:selected,reason:'path_not_in_exact_changes'};
    const files=[];let bytes=0,truncated=false;
    for(const path of file_path===undefined?changed:[file_path]){
      if(files.length>=32){truncated=true;break;}
      const before=oldFiles.get(path),after=newFiles.get(path);
       const file={path,old_hash:before?.hash??null,new_hash:after?.hash??null,old_mode:before?.mode??null,new_mode:after?.mode??null,old_bytes:before?.bytes??0,new_bytes:after?.bytes??0};
      if((before?.bytes??0)+(after?.bytes??0)+bytes>65536){files.push({...file,text_available:false,reason:'detail_byte_bound'});truncated=true;continue;}
      const read=async(version,present)=>present?(await execution.dispatch({action:'candidate_version_read',...scope,...version,path})).file:null;
       const [oldText,newText]=await Promise.all([read(prior,before),read(selected,after)]);
       if(oldText?.binary||newText?.binary){files.push({...file,text_available:false,reason:'binary'});continue;}
       const actualBytes=Buffer.byteLength(oldText?.text??'')+Buffer.byteLength(newText?.text??'');
       if(bytes+actualBytes>65536){files.push({...file,text_available:false,reason:'detail_byte_bound'});truncated=true;continue;}
       bytes+=actualBytes;
      files.push({...file,text_available:true,old_text:oldText?.text??null,new_text:newText?.text??null});
    }
    // Revalidate both complete immutable trees after reading individual files.
    const finalVersions=await Promise.all([prior,selected].map(version=>execution.dispatch({action:'candidate_version_get',...scope,...version})));
    // Legacy tree hashes bind source bytes, not Unix executable bits. Modes are
    // server-observed retained-tree metadata, independently checked across this
    // read; do not misrepresent them as part of the legacy candidate hash.
    const modes=version=>JSON.stringify(version.candidate.files.map(file=>[file.path,file.mode??null]).sort((a,b)=>a[0].localeCompare(b[0])));
    if(modes(oldVersion)!==modes(finalVersions[0])||modes(newVersion)!==modes(finalVersions[1]))return {available:false,comparison,from:prior,to:selected,reason:'historical_mode_changed_during_read',current_generation:candidate.generation};
     return {available:true,comparison,mode:'candidate_generation_diff',mode_provenance:'retained_tree_observation',from:prior,to:selected,changed_files:changed.length,files,truncated,note:'Exact retained generations. Source text is private; this comparison is not recorder evidence.'};
   }catch(error){if(['stale_resource','unavailable','permission_denied'].includes(error?.code))return {available:false,comparison,from:prior,to:selected,reason:'historical_diff_unavailable',current_generation:candidate.generation};throw error;}
}
