import fs from 'node:fs';
import path from 'node:path';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function createSharedChats(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const locks = new Set();
  function file(workspace, pane) {
    if (!uuid.test(workspace || '') || !uuid.test(pane || '')) throw Error('Invalid shared pane');
    return path.join(directory, `${workspace}.${pane}.json`);
  }
  function read(workspace, pane) { try { return JSON.parse(fs.readFileSync(file(workspace,pane),'utf8')); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } }
  function write(workspace, pane, state) {
    const dest = file(workspace,pane), temp = dest+'.tmp';
    fs.writeFileSync(temp, JSON.stringify(state), {mode:0o600}); fs.renameSync(temp,dest); return state;
  }
  function bind(workspace,pane,initial) {
    const current = read(workspace,pane); if(current) return current;
    if(!initial || !/^orbit-[a-f0-9-]{36}$/.test(initial.session)) return null;
    return write(workspace,pane,{session:initial.session, messages:(Array.isArray(initial.messages)?initial.messages:[]).filter(m=>['user','assistant'].includes(m.role)&&typeof m.text==='string').slice(-100), ...(typeof initial.run==='string'?{run:initial.run}:{}), title:typeof initial.title==='string'?initial.title.slice(0,100):undefined});
  }
  return {read,write,bind,locks};
}
