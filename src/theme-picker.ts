import {el,button} from './dom';
import {themes,themePatch} from './themes';
import {themePersonality} from './theme-personality';
import {themeColors,validateTheme} from './theme-tokens';
import type {Workspace} from './model';
import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
import {workspaceFetch} from './workspace-client';
type Appearance=NonNullable<Workspace['appearance']>;
export function showThemes(token:()=>string,apply:(patch:Appearance)=>void,current:()=>Appearance=()=>({})){
 const dialog=el('dialog','hermes-tools-dialog theme-picker');dialog.setAttribute('aria-label','Workspace themes');
 const status=el('p');status.role='status';let busy=false;
 async function save(patch:Appearance,label:string){
  if(busy)return;busy=true;status.textContent='Saving checkpoint…';
  try{
   validateTheme(patch);
   if(!token())throw Error('Connect host before applying a theme so a recovery checkpoint can be saved.');
   await ensureWorkspaceSynced();
    const response=await workspaceFetch(token(),{workspace_id:workspaceId,action:'checkpoint',label:'Before theme: '+label,intent:'Save checkpoint before applying '+label+' theme'});
   if(!response.ok)throw Error('Checkpoint failed; theme was not applied.');
   apply(patch);status.textContent=label+' applied locally; workspace synchronization will save the change. Previous appearance is in Workspace checkpoints.';
  }catch(e){status.textContent=String(e);}finally{busy=false;}
 }
 dialog.append(el('h2','','Make Orbit yours'),el('p','','Complete interface styles for title bars, menus, taskbar, dialogs, controls and chat. Each preset includes its own wallpaper and taskbar interactions. Applying a preset replaces the current wallpaper; layout, full viewport and apps are preserved. Embedded apps and terminals keep their own themes. Wallpaper may cover the background color. Custom overrides remain until you reset them.'),button('Close','Close workspace themes',()=>dialog.close()),status);
 const grid=el('div','theme-grid');dialog.append(grid);
 for(const theme of themes){
  const card=el('section','theme-card');
  const preview=el('div','theme-preview');preview.dataset.theme=theme.theme;preview.dataset.style=themePersonality(theme);preview.style.setProperty('--preview-bg',theme.background!);preview.setAttribute('aria-hidden','true');
  const win=el('div','theme-preview-window');win.append(el('div','theme-preview-title','Orbit · Your workspace'));
  const body=el('div','theme-preview-body');body.append(el('span','theme-preview-control','Create something'));win.append(body);preview.append(win);card.append(preview);
  card.append(el('h3','',theme.name),el('p','',theme.description),button('Apply','Apply '+theme.name+' theme',()=>{void save(themePatch(theme.name),theme.name);}));grid.append(card);
 }
 const details=el('details','theme-custom');details.append(el('summary','','Customize individual UI elements'));
 details.append(el('p','','Only edited fields are applied. Ask Hermes to reset individual overrides, or use Workspace checkpoints to restore the previous appearance.'));
 const fields=el('div','theme-fields');const draft:Appearance={};
 for(const key of [...themeColors,'accentColor','textColor'] as const){
  const label=el('label','',key.replace(/([A-Z])/g,' $1'));const input=el('input');input.type='color';
  const computed=getComputedStyle(document.documentElement).getPropertyValue('--theme-'+key).trim();
  input.value=current()[key]||(/^#[0-9a-f]{6}$/i.test(computed)?computed:'#ffffff');input.setAttribute('aria-label',label.textContent!);
  input.addEventListener('input',()=>{draft[key]=input.value;});label.append(input);fields.append(label);
 }
 for(const [key,min,max,fallback] of [['controlRadius',0,24,8],['titlebarHeight',24,64,34],['cornerRadius',0,40,12]] as const){
  const label=el('label','',key.replace(/([A-Z])/g,' $1')+' (px)');const input=el('input');input.type='number';input.min=String(min);input.max=String(max);input.value=String(current()[key]??fallback);input.setAttribute('aria-label',label.textContent!);
  input.addEventListener('input',()=>{draft[key]=Number(input.value);});label.append(input);fields.append(label);
 }
 const fontLabel=el('label','','UI font');const font=el('select');font.setAttribute('aria-label','UI font');
 for(const value of ['system','classic','mono'] as const){const option=el('option','',value);option.value=value;font.append(option);}font.value=current().uiFont??'system';font.onchange=()=>{draft.uiFont=font.value as Appearance['uiFont'];};fontLabel.append(font);fields.append(fontLabel);
 details.append(fields,button('Save custom styling','Save custom styling',()=>{if(Object.keys(draft).length)void save({theme:current().theme??'midnight',...draft},'Custom styling');else status.textContent='Edit a field first.';}));dialog.append(details);
 dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
}
