import { el, button } from './dom';
import './taskbar.css';

export interface StartAction { title: string; detail: string; run: () => void }
export function installStart(navigation: HTMLElement, actions: () => StartAction[]) {
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
  const start = button('◉  Start', 'Open Start', () => toggle(), 'start-button');
  start.setAttribute('aria-expanded', 'false');
  start.setAttribute('aria-controls', panel.id);
  function close(restore = false) {
    panel.hidden = true; start.setAttribute('aria-expanded', 'false');
    if (restore) start.focus();
  }
  function render() {
    results.replaceChildren();
    const query = search.value.toLocaleLowerCase().trim();
    for (const action of actions().filter(a => `${a.title} ${a.detail}`.toLocaleLowerCase().includes(query))) {
      const item = button('', action.title, () => { close(); action.run(); }, 'start-item');
      item.append(el('strong', '', action.title), el('span', '', action.detail));
      results.append(item);
    }
    if (!results.childElementCount) results.append(el('p', 'start-empty', 'No matches. Try another search.'));
  }
  function toggle() {
    if (!panel.hidden) return close(true);
    search.value = ''; render(); panel.hidden = false;
    start.setAttribute('aria-expanded', 'true'); search.focus();
  }
  search.addEventListener('input', render);
  panel.addEventListener('keydown', e => {
    const items = [search, ...Array.from(results.querySelectorAll<HTMLButtonElement>('button'))];
    const index = items.indexOf(document.activeElement as HTMLInputElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); items[(index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
    if (e.key === 'Enter' && document.activeElement === search) results.querySelector<HTMLButtonElement>('button')?.click();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); close(true); } });
  document.addEventListener('pointerdown', e => { if (!launcher.contains(e.target as Node)) close(); });
  launcher.addEventListener('focusout', () => { setTimeout(() => { if (!launcher.contains(document.activeElement)) close(); }, 0); });
  panel.append(heading, search, results);
  launcher.append(start, panel); navigation.prepend(launcher);
}
