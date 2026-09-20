import { button, el } from './dom';
import './minimize.css';

// Browser-local visibility preference, separate from shared workspace geometry.
export function installMinimize() {
  const tray = el('nav', 'minimized-tray');
  tray.setAttribute('aria-label', 'Minimized windows');
  tray.hidden = true;
  document.body.append(tray);
  const hidden = new Set<string>();
  const key = (id: string) => `orbit.window-minimized.${id}`;
  const read = (id: string) => { try { return localStorage.getItem(key(id)) === 'true'; } catch { return false; } };
  const write = (id: string, value: boolean) => { try { localStorage.setItem(key(id), String(value)); } catch { /* Session-only fallback. */ } };
  return {
    attach(id: string, element: HTMLElement) {
      if (read(id)) hidden.add(id);
      element.classList.toggle('window-minimized', hidden.has(id));
    },
    hide(id: string, element: HTMLElement) {
      hidden.add(id); write(id, true); element.classList.add('window-minimized');
    },
    restore(id: string, element?: HTMLElement) {
      hidden.delete(id); write(id, false); element?.classList.remove('window-minimized');
    },
    render(windows: { id: string; name: string }[], restore: (id: string) => void) {
      tray.replaceChildren();
      for (const w of windows.filter(w => hidden.has(w.id))) {
        tray.append(button(`↗ ${w.name}`, `Restore ${w.name}`, () => restore(w.id)));
      }
      tray.hidden = !tray.childElementCount;
    },
    focusRestore() { tray.querySelector<HTMLButtonElement>('button')?.focus(); },
  };
}
