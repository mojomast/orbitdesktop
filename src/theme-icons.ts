import './theme-icons.css';

// Semantic roles are kept separate from theme artwork and accessible button names.
export function iconRole(title:string, fallback=''):string {
 const value=title.toLowerCase();
 if(/password|secret|key/.test(value))return 'key';
 if(/folder/.test(value))return 'folder';
 if(/terminal|development|dev1/.test(value)||fallback==='⌘'||fallback==='>_')return 'terminal';
 if(/hermes|agent|chat|companion/.test(value)||fallback==='✦')return 'chat';
 if(/writer|editor|notepad|document/.test(value))return 'document';
 if(/calc|spreadsheet/.test(value))return 'grid';
 if(/impress|image|creative|studio|screenshot/.test(value))return 'image';
 if(/browser|chromium|web/.test(value))return 'browser';
 return 'app';
}
export function themeIcon(role:string, className=''):HTMLSpanElement {
 const span=document.createElement('span');
 span.className=`theme-icon ${className}`;span.dataset.icon=role;
 span.setAttribute('aria-hidden','true');return span;
}
