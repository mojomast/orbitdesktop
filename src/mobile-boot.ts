import './style.css';
import './mobile.css';
async function boot() {
  const r = await fetch('/api/mobile');
  if(!r.ok) throw Error('Access is restricted to your Pixel 8 Pro’s Tailscale connection.');
  const data = await r.json();
  localStorage.setItem('orbit.workspace.id', data.workspace_id);
  const {startMobile} = await import('./mobile');
  await startMobile();
}
void boot().catch(e => {document.getElementById('mobile-root')!.textContent=String(e.message);});
