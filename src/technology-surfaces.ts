export const TECHNOLOGY_SURFACES = {
  search: {title:'Knowledge search',detail:'Search explicitly indexed local sources',auth:true},
  'interactive-results': {title:'Interactive results',detail:'Import, edit and save reviewed result cards',auth:true},
  data: {title:'Data workbench',detail:'Analyze local CSV, JSON and Parquet; connect host to save recipes',auth:false},
  voice: {title:'Voice transcript',detail:'Local audio transcription into an editable draft',auth:false},
  documents: {title:'Document library',detail:'Open rich documents and canvases',auth:true},
  trace: {title:'Run traces',detail:'Inspect observed run timing and export traces',auth:true},
  copilot: {title:'Browser copilot',detail:'Review actions in a disposable browser',auth:true},
  'mcp-apps': {title:'MCP Apps',detail:'Separate-origin fixture host',auth:true},
} as const;
export type TechnologySurfaceId = keyof typeof TECHNOLOGY_SURFACES;
export type TechnologySurfaceOptions = {paneId?:string};
type Mounted = {dispose():void} | (()=>void);
export function documentSurfaceId(url:string):string|null {
  const match=/^orbit:\/\/document\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(url);
  return match?.[1]??null;
}
export async function mountTechnologySurface(host:HTMLElement,id:TechnologySurfaceId,token:()=>string,options:TechnologySurfaceOptions):Promise<Mounted> {
  switch(id){
    case 'search': return (await import('./search-surface')).mountSearchSurface(host,token,options);
    case 'interactive-results': return (await import('./interactive-result-host')).mountInteractiveResults(host,token,options);
    case 'data': return (await import('./data-workbench')).mountDataWorkbench(host,token,options);
    case 'voice': return (await import('./voice-capture')).mountVoiceCapture(host,token,options);
    case 'documents': return (await import('./document-library')).mountDocumentLibrary(host,token,options);
    case 'trace': return (await import('./run-trace-pane')).mountRunTracePane(host,token,options);
    case 'copilot': return (await import('./browser-copilot')).mountBrowserCopilot(host,token,options);
    case 'mcp-apps': return (await import('./mcp-apps-host')).mountMcpApps(host,token,options);
  }
}
