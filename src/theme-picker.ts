import {el,button} from './dom';
import {themes,themePatch} from './themes';
import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
export function showThemes(token:()=>string,apply:(patch:ReturnType<typeof themePatch>)=>void){
 const dialog=el('dialog','hermes-tools-dialog');dialog.setAttribute('aria-label','Workspace themes');
 const status=el('p');status.role='status';let busy=false;
 dialog.append(el('h2','','Workspace themes'),el('p','','Choose a desktop background, accent, window text and corner style. Wallpaper, layout, full viewport and apps are preserved. Embedded apps and terminals keep their own themes. Wallpaper may cover the background color.'),button('Close','Close workspace themes',()=>dialog.close()));
 for(const theme of themes){
  const card=el('section');card.style.cssText=`padding:16px;margin:12px 0;background:${theme.background};color:${theme.textColor};border:1px solid ${theme.accentColor};border-radius:${theme.cornerRadius}px`;
  card.append(el('h3','',theme.name),el('p','',`Accent ${theme.accentColor} · ${theme.cornerRadius}px corners`),button('Apply','Apply '+theme.name+' theme',async()=>{
   if(busy)return;busy=true;status.textContent='Saving checkpoint…';
   try{
    if(!token())throw Error('Connect host before applying a theme so a recovery checkpoint can be saved.');
    await ensureWorkspaceSynced();
    const response=await fetch('/api/workspace',{method:'POST',headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspaceId,action:'checkpoint',label:'Before theme: '+theme.name})});
    if(!response.ok)throw Error('Checkpoint failed; theme was not applied.');
    apply(themePatch(theme.name));status.textContent=theme.name+' applied locally; workspace synchronization will save the change. Previous appearance is in Workspace checkpoints.';
   }catch(e){status.textContent=String(e);}finally{busy=false;}
  }));dialog.append(card);
 }
 dialog.append(status);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
}
