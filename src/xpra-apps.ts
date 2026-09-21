import {linuxAppUrl} from './linux-app-url';
// Fixed service ports on this deployment's host; no credentials in URLs.
export const xpraApps = [
 {id:'chromium',title:'Chromium · Xpra',icon:'🌐',port:4350},
 {id:'writer',title:'OpenOffice Writer',icon:'📝',port:4351},
 {id:'calc',title:'OpenOffice Calc',icon:'📊',port:4352},
 {id:'impress',title:'OpenOffice Impress',icon:'📽',port:4353},
 {id:'files',title:'Linux Files',icon:'📁',port:4354},
 {id:'editor',title:'Linux Text Editor',icon:'📄',port:4355},
 {id:'terminal',title:'Linux Terminal · Xpra',icon:'⌨',port:4356},
].map(app=>({...app,url:linuxAppUrl(window.location.origin,app.port,'/?floating_menu=false&sharing=true&orbit_app=1')}));
