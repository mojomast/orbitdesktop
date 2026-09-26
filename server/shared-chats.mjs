import fs from 'node:fs';
import path from 'node:path';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const legacySession = /^orbit-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const safeSession = /^[A-Za-z0-9_:-]{1,128}$/;
const revision = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function createSharedChats(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const locks = new Set();
  function file(workspace, pane) {
    if (!uuid.test(workspace || '') || !uuid.test(pane || '')) throw Error('Invalid shared pane');
    return path.join(directory, `${workspace}.${pane}.json`);
  }
  function read(workspace, pane) { try { const state = JSON.parse(fs.readFileSync(file(workspace,pane),'utf8')); return {...state,profile_id:state.profile_id || 'default',binding_revision:revision(state.binding_revision)}; } catch(e) { if(e.code === 'ENOENT') return null; throw e; } }
  function write(workspace, pane, state) {
    const dest = file(workspace,pane), temp = dest+'.tmp';
    const next = {...state,profile_id:state.profile_id || 'default',binding_revision:revision(state.binding_revision)};
    fs.writeFileSync(temp, JSON.stringify(next), {mode:0o600}); fs.renameSync(temp,dest); return next;
  }
  function bind(workspace,pane,initial) {
    const current = read(workspace,pane); if(current) return current;
    if(!initial || !legacySession.test(initial.session) || (initial.profile_id && initial.profile_id !== 'default')) return null;
    return write(workspace,pane,{session:initial.session, profile_id:'default',binding_revision:0,messages:(Array.isArray(initial.messages)?initial.messages:[]).filter(m=>['user','assistant'].includes(m.role)&&typeof m.text==='string').map(m=>({role:m.role,text:m.text.slice(0,16000)})).slice(-100), ...(typeof initial.run==='string'?{run:initial.run}:{}), title:typeof initial.title==='string'?initial.title.slice(0,100):undefined});
  }
  function hasActive(profile, session, exceptWorkspace, exceptPane) {
    const files = fs.readdirSync(directory).filter(name => uuid.test(name.slice(0,36)) && name.endsWith('.json'));
    if (files.length > 10000) return true;
    for (const name of files) {
      if (name === `${exceptWorkspace}.${exceptPane}.json`) continue;
      try {
        const state = JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
        if (state.run && (state.profile_id || 'default') === profile && state.session === session) return true;
      } catch { return true; }
    }
    return false;
  }
  return {read,write,bind,locks,hasActive,safeSession};
}
