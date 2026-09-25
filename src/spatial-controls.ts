import type { Workspace } from './model';
import type { DesktopScene } from './scene';
import { spatialWindow, tileSpatial, type SpatialWindow } from './spatial-layout';
export function installSpatialControls(host:HTMLElement,scene:DesktopScene,get:()=>Workspace,changed:()=>void){
  const toolbar=document.createElement('div');toolbar.className='spatial-toolbar';toolbar.setAttribute('aria-label','3D scene controls');
  const add=(text:string,title:string,run:()=>void)=>{const b=document.createElement('button');b.textContent=text;b.title=title;b.setAttribute('aria-label',title);b.onclick=run;toolbar.append(b);return b;};
  let navigating=false;
  const nav=add('Navigate','Toggle 3D navigation',()=>scene.setNavigation(!navigating));
  host.addEventListener('spatial-navigation',e=>{navigating=(e as CustomEvent<boolean>).detail;nav.setAttribute('aria-pressed',String(navigating));nav.textContent=navigating?'Interact (Esc)':'Navigate';});
  add('Fit all','Frame all 3D windows',()=>scene.frameAll());
  add('Approach','Approach selected 3D window',()=>scene.frameWindow(get().selected));
  add('Arrange / edit','3D layout and window settings',()=>{
    const dialog=document.createElement('dialog');dialog.className='spatial-dialog';dialog.setAttribute('aria-label','3D layout and window settings');
    const title=document.createElement('h2');title.textContent='3D scene · arrange and edit';dialog.append(title);
    const help=document.createElement('p');help.textContent='Title bar: drag to move, Shift drag for depth, Ctrl/⌘ drag to rotate. Bottom-right corner: resize width and height. Navigate mode: drag to orbit, Shift/right drag to pan, scroll to zoom, WASD + Q/E to travel. Escape returns to interaction.';dialog.append(help);
    const row=document.createElement('div');row.className='spatial-tiling';
    const cols=document.createElement('input');cols.type='number';cols.min='1';cols.max=String(get().monitors.length);cols.value=String(Math.ceil(Math.sqrt(get().monitors.length)));cols.setAttribute('aria-label','3D tiling columns');
    const gap=document.createElement('input');gap.type='number';gap.min='0';gap.max='20';gap.step='0.05';gap.value='0.35';gap.setAttribute('aria-label','3D tiling gap');
    const columnsLabel=document.createElement('label');columnsLabel.textContent='Columns ';columnsLabel.append(cols);
    const gapLabel=document.createElement('label');gapLabel.textContent='Gap ';gapLabel.append(gap);row.append(columnsLabel,gapLabel);
    const status=document.createElement('p');status.role='status';
    const history:{id:string;spatial:SpatialWindow|undefined}[][]=[];
    for(const mode of ['grid','row','curve'] as const){const b=document.createElement('button');b.textContent=mode==='curve'?'Curved wall':mode==='row'?'Single row':'Grid';b.onclick=()=>{
      if(!cols.validity.valid||!gap.validity.valid)return;
      const state=get();history.push(state.monitors.map(m=>({id:m.id,spatial:m.spatial?{...m.spatial}:undefined})));
      try{tileSpatial(state.monitors,mode,Number(cols.value),Number(gap.value));changed();scene.frameAll();fields();status.textContent='Tiled in 3D. 2D frames and panes were retained.';}catch(e){history.pop();status.textContent=String(e);}
    };row.append(b);}
    const undo=document.createElement('button');undo.textContent='Undo arrangement';undo.onclick=()=>{const previous=history.pop();if(!previous)return;for(const entry of previous){const m=get().monitors.find(m=>m.id===entry.id);if(m){if(entry.spatial)m.spatial=entry.spatial;else delete m.spatial;}}changed();scene.frameAll();fields();status.textContent='Previous 3D placement restored.';};row.append(undo);dialog.append(row);
    const panel=document.createElement('div');panel.className='spatial-fields';dialog.append(panel);
    const fields=()=>{
      panel.replaceChildren();const state=get(),m=state.monitors.find(m=>m.id===state.selected)!;
      const heading=document.createElement('h3');heading.textContent=`Selected: ${m.name}`;panel.append(heading);
      const s=spatialWindow(m,state.monitors,state.arc);
      for(const [key,label,min,max,step] of [['x','Position X',-10000,10000,0.1],['y','Position Y',-10000,10000,0.1],['z','Position Z / depth',-10000,10000,0.1],['width','3D width',0.3,200,0.1],['height','3D height',0.3,200,0.1],['yaw','Yaw',-360,360,1],['pitch','Pitch',-89,89,1]] as const){
        const wrap=document.createElement('label');wrap.textContent=label;const input=document.createElement('input');input.type='number';input.min=String(min);input.max=String(max);input.step=String(step);input.value=String(Math.round(s[key]*100)/100);input.setAttribute('aria-label',label);
        input.oninput=()=>{if(!input.value||!input.validity.valid)return;const live=get().monitors.find(v=>v.id===m.id);if(!live)return;live.spatial={...spatialWindow(live,get().monitors,get().arc),[key]:Number(input.value)};changed();};wrap.append(input);panel.append(wrap);
      }
      const label=document.createElement('label');label.textContent='Surface resolution';const resolution=document.createElement('select');resolution.setAttribute('aria-label','3D surface resolution');
      for(const value of [1280,1920,2560,3840]){const option=document.createElement('option');option.value=String(value);option.textContent=`${value} CSS pixels wide`;resolution.append(option);}resolution.value=String(s.resolution);
      resolution.onchange=()=>{const live=get().monitors.find(v=>v.id===m.id);if(live){live.spatial={...spatialWindow(live,get().monitors,get().arc),resolution:Number(resolution.value)} as SpatialWindow;changed();}};label.append(resolution);panel.append(label);
    };
    fields();const note=document.createElement('p');note.textContent='Live DOM text and controls, not image textures. Higher surface resolutions provide more detail but make text smaller at the same distance: use Approach, zoom in, or A+/A−. Remote desktop streams retain their source resolution. Very tall surfaces are capped at 4096 CSS pixels high.';dialog.append(note,status);
    const done=document.createElement('button');done.textContent='Done';done.onclick=()=>dialog.close();dialog.append(done);dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
  });
  host.append(toolbar);
}
