export const TECHNOLOGY_SURFACES = {
  search: {title:'Knowledge search',detail:'Search explicitly indexed local sources',auth:true},
  'interactive-results': {title:'Interactive results',detail:'Import, edit and save reviewed result cards',auth:true},
  documents: {title:'Document library',detail:'Open rich documents and canvases',auth:true},
  trace: {title:'Run traces',detail:'Inspect observed run timing and export traces',auth:true},
} as const;
export type TechnologySurfaceId = keyof typeof TECHNOLOGY_SURFACES;
export type TechnologySurfaceOptions = {paneId?:string; surfaceUrl?:string};
type Mounted = {dispose():void} | (()=>void);
export function documentSurfaceId(url:string):string|null {
  const match=/^orbit:\/\/document\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(url);
  return match?.[1]??null;
}
export async function mountTechnologySurface(host:HTMLElement,id:TechnologySurfaceId,token:()=>string,options:TechnologySurfaceOptions):Promise<Mounted> {
  switch(id){
    case 'search': return (await import('./search-surface')).mountSearchSurface(host,token,options);
    case 'interactive-results': return (await import('./interactive-result-host')).mountInteractiveResults(host,token,options);
    case 'documents': return (await import('./document-library')).mountDocumentLibrary(host,token,options);
    case 'trace': return (await import('./run-trace-pane')).mountRunTracePane(host,token,options);
  }
}
