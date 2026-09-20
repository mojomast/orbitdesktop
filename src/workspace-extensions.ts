export interface WorkspaceExtensionContext {
 token: ()=>string;
 api: (body:Record<string,unknown>)=>Promise<any>;
}
export interface WorkspaceExtension {
 id:string; title:string; label:string;
 activate:(context:WorkspaceExtensionContext)=>Promise<void>;
}
// Trusted, built-in modules only. User-generated plugins never execute in this realm.
export const workspaceExtensions: readonly WorkspaceExtension[] = [
 {id:'jev',title:'Jev quick actions',label:'Open Jev quick actions',activate:async c=>(await import('./jev-ui')).showJev(c.token)},
 {id:'plugins',title:'Workspace plugins',label:'Manage workspace plugins',activate:async c=>(await import('./plugin-manager')).showPlugins(c.token)},
 {id:'checkpoints',title:'Workspace checkpoints',label:'Open workspace checkpoints',activate:async c=>(await import('./workspace-history')).showHistory(c.token)},
 {id:'catalog',title:'Skills and tools',label:'Browse actual Hermes capabilities',activate:async c=>(await import('./hermes-catalog')).showCatalog(c.api)},
 {id:'outputs',title:'Apps and outputs',label:'Open published apps and outputs',activate:async c=>{await (await import('./hermes-surfaces')).showShelf(c.token);}},
 {id:'jobs',title:'Scheduled tasks',label:'Open actual Hermes scheduled tasks',activate:async c=>(await import('./hermes-jobs')).showHermesJobs(c.api)},
];
