'use strict';
let interviewToken='',interviewBusy=false,proposal=null,baseline='',chatOpen=true;
const originalRender=render;
render=function(){originalRender();if(state.step===0)drawInterview();};
function chatHistory(){return state.interview||(state.interview=[]);}
async function interviewApi(path,data={}){let r=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(interviewToken?{Authorization:'Bearer '+interviewToken}:{})},body:JSON.stringify(data)});let j=await r.json();if(!r.ok)throw Error(j.error||'Interview request failed');return j;}
function drawInterview(){
 const v=$('#view'),box=el('section',undefined,'card');box.id='interview';
 box.append(el('h2','Talk through your project'),el('p','Hermes asks adaptive follow-up questions. Your messages and brief go to your configured model provider. This interviewer has no tools or repository access. Proposed changes require your approval.','muted'));
 box.append(button(chatOpen?'Show questionnaire instead':'Open conversational interview',()=>{chatOpen=!chatOpen;render();}));
 if(!chatOpen){v.prepend(box);return;}
 v.replaceChildren(box);$('#next').textContent='Review complexity →';
 if(!interviewToken){let token=el('input');token.type='password';token.autocomplete='off';token.placeholder='Orbit host token';token.setAttribute('aria-label','Orbit host token');box.append(token,button('Unlock interview',async()=>{try{const value=token.value;token.value='';const j=await interviewApi('unlock',{token:value});interviewToken=j.session_token;render();note('Connected. Start with your idea below.');}catch(e){note(e.message);}}));}
 const log=el('div');log.id='interview-log';log.setAttribute('aria-live','polite');
 for(const m of chatHistory()){let c=el('article',undefined,'card');c.append(el('strong',m.role==='user'?'You':'Hermes'),el('p',m.content));log.append(c);}box.append(log);
 if(!chatHistory().length)box.append(el('p','What would you like to build, who is it for, and what should it help them do?'));
 if(proposal){const p=el('div',undefined,'card');p.append(el('h3','Proposed brief updates — review before applying'));
 for(const [k,val]of Object.entries(proposal)){let d=el('details');d.append(el('summary',D.questions.find(q=>q[0]===k)?.[1]||k),el('p','Current: '+(state.answers[k]||'(empty)')),el('pre',val));p.append(d);}
 p.append(button('Accept proposed updates',()=>{if(JSON.stringify(state.answers)!==baseline){note('Your brief changed since this proposal. Discard and ask for a fresh proposal.');return;}snapshot('Before interview proposal');Object.assign(state.answers,proposal);changed();proposal=null;render();note('Brief updated. Existing design approval was cleared.');},'primary'),button('Discard proposal',()=>{proposal=null;render();}));box.append(p);}
 const input=el('textarea');input.id='chat-message';input.maxLength=8000;input.placeholder='Describe your idea, answer the question, or ask for options…';input.setAttribute('aria-label','Interview message');input.value=state.chatDraft||'';input.oninput=()=>{state.chatDraft=input.value;persist();};input.disabled=interviewBusy;box.append(input);
 const send=button(interviewBusy?'Hermes is thinking…':'Send answer',()=>sendInterview(input.value),'primary');send.disabled=!interviewToken||interviewBusy||!!proposal;box.append(send);
 if(interviewBusy)box.append(button('Check response',()=>pollInterview()));
 box.append(button('Review current brief',()=>{chatOpen=false;render();}),el('p',`${D.questions.filter(([k])=>state.answers[k]?.trim()).length} / ${D.questions.length} brief fields populated. Export project to preserve your conversation.`, 'muted'));
 if(log.lastElementChild)log.lastElementChild.scrollIntoView({block:'nearest'});
}
async function sendInterview(message){if(!message.trim()||interviewBusy)return;try{baseline=JSON.stringify(state.answers);await interviewApi('interview',{brief:state.answers,history:chatHistory().slice(-40),message});chatHistory().push({role:'user',content:message});state.interview=chatHistory().slice(-80);state.chatDraft='';interviewBusy=true;render();pollInterview();}catch(e){note(e.message);}}
let pollTimer;
async function pollInterview(){clearTimeout(pollTimer);try{const r=await interviewApi('status');if(r.status==='running'){note('Hermes is preparing the next interview question…');pollTimer=setTimeout(pollInterview,2000);return;}if(r.status==='completed'&&interviewBusy){chatHistory().push({role:'assistant',content:r.message});proposal=Object.keys(r.updates).length?r.updates:null;interviewBusy=false;render();note(r.ready?'Hermes suggests discovery is complete. Review the brief and unresolved decisions before proceeding.':'Review proposed updates, then answer the follow-up.');}else if(r.status==='failed'){interviewBusy=false;render();note(r.error);}}catch(e){note(e.message+' Use Check response to resume; do not resend the answer.');}}
const oldNext=$('#next').onclick;$('#next').onclick=()=>{if(state.step===0&&chatOpen){state.step=1;render();}else oldNext();};
const oldNew=$('#new').onclick;$('#new').onclick=()=>{if(interviewBusy){note('Wait for the current interview turn before starting a new project.');return;}oldNew();proposal=null;render();};
const oldImport=$('#import').onchange;$('#import').onchange=async e=>{if(interviewBusy){note('Wait for the interview response before importing.');e.target.value='';return;}await oldImport(e);proposal=null;render();};
render();
