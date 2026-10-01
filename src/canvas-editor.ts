/// <reference types="vite/client" />
import type {ExcalidrawImperativeAPI,ExcalidrawProps} from '@excalidraw/excalidraw/types';
import {validateDocumentData,CANVAS_FONT_IDS,CANVAS_FONT_POLICY_KEY} from '../contracts/documents-v1.mjs';
import type {MountedDocumentEditor} from './document-store-client';
// The parent build copies the pinned package's fonts/ tree with its notices to
// this versioned, same-origin directory. No CDN fallback is configured.
export const CANVAS_ASSET_PATH='/vendor/excalidraw-0.18.1/';
export async function mountEditor(host:HTMLElement,content:string,onChange:(content:string)=>void):Promise<MountedDocumentEditor> {
  let current=content,disposed=false,readonly=false,api:ExcalidrawImperativeAPI|undefined,suppress=false,initialized=false;
  const initial=validateDocumentData({kind:'scene',format:'excalidraw',content});
  (window as Window & {EXCALIDRAW_ASSET_PATH?:string}).EXCALIDRAW_ASSET_PATH=CANVAS_ASSET_PATH;
  const [React,{createRoot},{flushSync},{Excalidraw,convertToExcalidrawElements,CaptureUpdateAction},css]=await Promise.all([import('react'),import('react-dom/client'),import('react-dom'),import('@excalidraw/excalidraw'),import('@excalidraw/excalidraw/index.css?inline')]);
  const policy=(globalThis as unknown as Record<symbol,unknown>)[Symbol.for(CANVAS_FONT_POLICY_KEY)];
  const certified=policy as {ids?:number[];source?:string;fallback?:string}|undefined;
  if(!Array.isArray(certified?.ids)||certified.ids.join(',')!==CANVAS_FONT_IDS.join(',')||!['3cfe278cb537fde73b42bbd4697b392946517d3dc02d3f3cf8487d8476f63ba2','72b54e8e9b3c17c69f1dd5e40203bfaed62313bc611b86ecb8a1625a12562e51'].includes(certified.source??'')||certified.fallback!=='same-origin')throw Error('Reviewed canvas font policy is missing from this build. Enable canvasFontPolicyPlugin before opening a canvas.');
  // A real React island inside a shadow root keeps Excalidraw resets/tokens
  // out of the Orbit shell while retaining the existing connected pane DOM.
  // The native toolbar has a finite desktop footprint. Keep that footprint
  // inside an owned scroller rather than centering it outside a narrow pane.
  // Resizing changes geometry only; the same React root and scene stay mounted.
  const viewport=document.createElement('div');viewport.className='canvas-viewport';viewport.style.cssText='height:100%;width:100%;min-width:0;overflow:auto;overscroll-behavior:contain;';
  // Scroll lies outside the shadow root: refresh the engine's viewport offsets
  // explicitly so native pointer coordinates track horizontal/vertical scrolling.
  viewport.addEventListener('scroll',()=>{if(!disposed&&api&&!api.getAppState().editingTextElement)api.refresh();},{passive:true});
  const island=document.createElement('div');island.className='canvas-island';island.dir='ltr';island.style.cssText='height:100%;width:100%;min-width:800px;min-height:300px;';
  // The upstream :root layer-index variables and direction rules must belong to
  // the shadow host; leaving :root intact makes the UI fall behind the canvas.
  const shadow=island.attachShadow({mode:'open'}),style=document.createElement('style');style.textContent=css.default.replaceAll(':root',':host')+'\n:host{display:block;height:100%;color:#1b1b1f}.canvas-root{height:calc(100% - 36px);width:100%;min-height:264px}.canvas-controls{height:36px;box-sizing:border-box;padding:4px 8px;background:#eef0f5;font:13px system-ui;display:flex;gap:8px;align-items:center}.canvas-controls select{font:inherit;color:#222;background:#fff}.FontPicker__container{display:none!important}.canvas-error{position:absolute;bottom:4px;left:4px;background:#fff;color:#a00;z-index:20;padding:4px;font:12px system-ui}.canvas-error:empty{display:none}';
  const controls=document.createElement('label');controls.className='canvas-controls';controls.append(document.createTextNode('Text font'));
  const font=document.createElement('select');font.setAttribute('aria-label','Canvas text font');font.disabled=true;
  for(const [value,name] of [[5,'Excalifont'],[6,'Nunito'],[7,'Lilita One'],[8,'Comic Shanns']] as const){const option=document.createElement('option');option.value=String(value);option.textContent=name;font.append(option);}controls.append(font);
  font.addEventListener('change',()=>{if(!api||readonly||disposed)return;const family=Number(font.value) as 5|6|7|8;if(!CANVAS_FONT_IDS.includes(family))return;
    const state=api.getAppState(),elements=api.getSceneElements();
    const selected=elements.filter(e=>e.type==='text'&&state.selectedElementIds[e.id]);
    const changed=convertToExcalidrawElements(selected.map(e=>({...e,type:'text' as const,text:e.type==='text'?e.originalText:'',fontFamily:family})),{regenerateIds:false});
    const replacements=new Map(changed.map(e=>[e.id,e]));
    // This native control is outside React's event boundary. Commit its font
    // before the next canvas pointer event can create text using stale state.
    flushSync(()=>api!.updateScene({elements:elements.map(e=>replacements.get(e.id)??e),appState:{currentItemFontFamily:family},captureUpdate:CaptureUpdateAction.IMMEDIATELY}));
  });
  const mount=document.createElement('div');mount.className='canvas-root';
  const error=document.createElement('div');error.className='canvas-error';error.setAttribute('role','alert');
  shadow.append(style,controls,mount,error);viewport.append(island);host.replaceChildren(viewport);
  const root=createRoot(mount);
  function serialize(elements:Parameters<NonNullable<ExcalidrawProps['onChange']>>[0],appState:Parameters<NonNullable<ExcalidrawProps['onChange']>>[1],files:Parameters<NonNullable<ExcalidrawProps['onChange']>>[2]) {
    if(Object.keys(files).length)throw Error('Embedded binary files are disabled. Remove the image before saving.');
    const value=JSON.stringify({type:'excalidraw',version:2,source:'Orbit',elements,appState:{viewBackgroundColor:appState.viewBackgroundColor,gridSize:appState.gridSize,gridStep:appState.gridStep,gridModeEnabled:appState.gridModeEnabled},files:{}});
    validateDocumentData({kind:'scene',format:'excalidraw',content:value});return value;
  }
  const props:ExcalidrawProps={initialData:{...initial,scrollToContent:true},excalidrawAPI(instance){api=instance;font.disabled=readonly;},onChange(elements,appState,files){if(disposed||suppress||readonly)return;if(CANVAS_FONT_IDS.includes(appState.currentItemFontFamily))font.value=String(appState.currentItemFontFamily);try{const next=serialize(elements,appState,files);error.textContent='';if(!initialized){initialized=true;current=next;return;}if(next!==current){current=next;onChange(next);}}catch(e){error.textContent=e instanceof Error?e.message:'Canvas cannot be saved';// Preserve the unsupported edit visibly; never silently save an older scene.
      current=JSON.stringify({type:'excalidraw',version:2,source:'Orbit',elements,appState:{viewBackgroundColor:appState.viewBackgroundColor},files});onChange(current);}},onPaste(data){if(data.files?.length){error.textContent='Embedded binary files are disabled.';return false;}if(data.elements?.some(e=>e.type==='text'&&!CANVAS_FONT_IDS.includes(e.fontFamily))){error.textContent='Unsupported pasted font. Convert text to Excalifont, Nunito, Lilita One or Comic Shanns before importing.';return false;}return true;},validateEmbeddable:false,aiEnabled:false,isCollaborating:false,handleKeyboardGlobally:false,autoFocus:false,theme:'light',UIOptions:{tools:{image:false},canvasActions:{loadScene:false,saveToActiveFile:false,export:false,saveAsImage:false,toggleTheme:false}}};
  function render(){root.render(React.createElement(Excalidraw,{...props,viewModeEnabled:readonly}));}render();
  return {getContent(){return current;},setContent(next){const data=validateDocumentData({kind:'scene',format:'excalidraw',content:next});current=next;suppress=true;if(api){api.updateScene({elements:data.elements,appState:data.appState});api.history.clear();}else props.initialData={...data,scrollToContent:true};queueMicrotask(()=>{suppress=false;});},setReadOnly(value){if(readonly===value)return;readonly=value;font.disabled=readonly;render();},dispose(){disposed=true;root.unmount();viewport.remove();}};
}
