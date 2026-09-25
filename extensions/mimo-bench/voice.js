const vurls=[];
function voiceFields(){const m=$('vmodel').value,asr=m.endsWith('-asr'),clone=m.endsWith('-voiceclone');for(const [id,show] of [['vvoicewrap',m==='mimo-v2.5-tts'],['vlangwrap',asr],['vtextwrap',!asr],['vstylewrap',!asr],['vfilewrap',asr||clone],['vrightswrap',clone]])$(id).hidden=!show;$('vconsent').checked=false;}
$('vmodel').onchange=voiceFields;voiceFields();
$('vclear').onclick=()=>{for(const url of vurls)URL.revokeObjectURL(url);vurls.length=0;$('vresults').replaceChildren();$('vfile').value='';$('vrights').checked=false;$('vconsent').checked=false;};
$('vrun').onclick=async()=>{
if(!$('vconsent').checked){$('vstatus').textContent='Authorize one paid API call first.';return;}
const d={model:$('vmodel').value,text:$('vtext').value,style:$('vstyle').value,voice:$('vvoice').value,language:$('vlang').value,consent:true,rights:$('vrights').checked};
$('vconsent').checked=false;$('vrun').disabled=true;$('vstatus').textContent='Working… A request may take up to two minutes. Closing this page will not cancel billing.';
try{
if(d.model.endsWith('-asr')||d.model.endsWith('-voiceclone')){if(d.model.endsWith('-voiceclone')&&!d.rights)throw Error('Confirm permission to clone this voice.');const f=$('vfile').files[0];if(!f||f.size>6000000||!(/\.(wav|mp3)$/i.test(f.name)))throw Error('Choose a WAV or MP3 file up to 6 MB.');const raw=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('File read failed'));r.readAsDataURL(f)});d.audio='data:audio/'+(/\.wav$/i.test(f.name)?'wav':'mpeg')+';base64,'+raw.split(',')[1];}
const r=await api('voice',d),card=node('section',null,'panel');card.append(node('h2',r.model),node('p','Complete response: '+fmt(r.elapsed_ms,' ms')+(r.duration_seconds?' · Audio: '+fmt(r.duration_seconds,' s')+' · Real-time factor: '+fmt(r.real_time_factor)+' (lower is faster)':'')));
if(r.audio){const bytes=Uint8Array.from(atob(r.audio),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));vurls.push(url);const audio=node('audio');audio.controls=true;audio.src=url;const a=node('a','Download WAV');a.href=url;a.download=r.model+'.wav';card.append(audio,a);}
if(r.text)card.append(node('pre',r.text));card.append(node('pre',JSON.stringify({usage:r.usage},null,2)));$('vresults').prepend(card);$('vstatus').textContent='Complete. Results remain only in this page until cleared or refreshed.';
}catch(e){$('vstatus').textContent=e.message;}finally{$('vrun').disabled=false;}
};
