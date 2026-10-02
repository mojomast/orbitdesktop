import { el, button } from './dom';
import './taskbar.css';
import {themeIcon,iconRole} from './theme-icons';
import type { WorkspaceCommands } from './workspace-commands';

export function installStart(navigation: HTMLElement, commands: WorkspaceCommands) {
  navigation.setAttribute('aria-label', 'Workspace taskbar');
  const launcher = el('div', 'start-launcher');
  const panel = el('section', 'start-panel');
  panel.id = 'orbit-start-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Start launcher');
  const heading = el('div', 'start-heading');
  heading.append(el('strong', '', 'Orbit'), el('span', '', 'Your workspace, one click away'));
  const search = el('input', 'start-search') as HTMLInputElement;
  search.type = 'search'; search.placeholder = 'Search windows and actions…';
  search.setAttribute('aria-label', 'Search Start');
  const results = el('div', 'start-results');
  const quick = el('div', 'start-quick');
  quick.setAttribute('aria-label', 'Quick launch');
  for (const [title, label] of [['New agent chat', '✦ Chat'], ['New terminal', '⌘ Terminal'], ['New browser', '◎ Browser']]) {
    const launch=button(label.replace(/^[^ ]+ /,''), `Quick launch ${title}`, () => { close(); const action = commands.list().find(action => action.title === title); if (action) void commands.execute(action.id); });
    launch.prepend(themeIcon(iconRole(title)));quick.append(launch);
  }
  const start = button('', 'Open Start', () => toggle(), 'start-button');
  const logo = themeIcon('app','start-logo');
  start.append(logo, el('span', 'start-label', 'Start'));
  start.setAttribute('aria-expanded', 'false');
  start.setAttribute('aria-controls', panel.id);
  function close(restore = false) {
    panel.hidden = true; start.setAttribute('aria-expanded', 'false');
    if (restore) start.focus();
  }
  function render() {
    results.replaceChildren();
    const query = search.value.toLocaleLowerCase().trim();
    for (const action of commands.list(query)) {
      const item = button('', action.title, () => { close(); void commands.execute(action.id); }, 'start-item');
      item.disabled = !!action.disabledReason;
      item.append(el('strong', '', action.title), el('span', '', action.disabledReason ?? action.detail));
      results.append(item);
    }
    if (!results.childElementCount) results.append(el('p', 'start-empty', 'No matches. Try another search.'));
  }
  function toggle() {
    if (!panel.hidden) return close(true);
    search.value = ''; render(); panel.hidden = false;
    window.dispatchEvent(new Event('orbit-command-discovery'));
    start.setAttribute('aria-expanded', 'true'); search.focus();
  }
  search.addEventListener('input', render);
  window.addEventListener('orbit-command-details-changed',()=>{
    if(panel.hidden)return;
    const focused=results.contains(document.activeElement)?document.activeElement?.getAttribute('aria-label'):null;
    render();
    if(focused)Array.from(results.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.getAttribute('aria-label')===focused)?.focus();
  });
  panel.addEventListener('keydown', e => {
    const items = [search, ...Array.from(quick.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')), ...Array.from(results.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))];
    const index = items.indexOf(document.activeElement as HTMLInputElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); items[(index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
    if (e.key === 'Enter' && document.activeElement === search) { e.preventDefault(); results.querySelector<HTMLButtonElement>('button:not(:disabled)')?.click(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); close(true); } });
  document.addEventListener('pointerdown', e => { if (!launcher.contains(e.target as Node)) close(); });
  launcher.addEventListener('focusout', () => { setTimeout(() => { if (!launcher.contains(document.activeElement)) close(); }, 0); });
  panel.append(heading, search, quick, results);
  launcher.append(start, panel); navigation.prepend(launcher);
}
