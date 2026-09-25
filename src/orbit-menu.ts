import { el, button } from './dom';
import './orbit-menu.css';

/** One control that can live either inside the orbit menu or on the top toolbar. */
export interface OrbitMenuItem {
  id: string;
  /** Short text used when the control is pinned to the top toolbar. */
  label: string;
  /** Glyph rendered by CSS `::before` in both placements. */
  icon: string;
  button: HTMLButtonElement;
}

export interface OrbitMenuSection {
  id: string;
  title: string;
  detail?: string;
  items: OrbitMenuItem[];
}

export interface OrbitMenuOptions {
  /** Compact strip appended to the top toolbar that receives pinned controls. */
  toolbar: HTMLElement;
  /** Where the popout drawer is mounted (usually #app). */
  drawerHost: HTMLElement;
  /** The logo button that opens and closes the drawer. */
  logo: HTMLButtonElement;
  sections: () => OrbitMenuSection[];
}

export interface OrbitMenuController {
  open(): void;
  close(): void;
  toggle(): void;
  /** Re-apply pinned/menu placement after external changes. */
  refresh(): void;
  isPinned(): boolean;
  readonly drawer: HTMLElement;
}

const pinnedKey = 'orbit.menu.pinned';

export function installOrbitMenu(options: OrbitMenuOptions): OrbitMenuController {
  const { toolbar, drawerHost, logo } = options;
  toolbar.classList.add('orbit-toolbar');
  toolbar.setAttribute('aria-label', 'Orbit toolbar');
  toolbar.hidden = true;

  const drawer = el('section', 'orbit-menu');
  drawer.id = 'orbit-menu';
  drawer.hidden = true;
  drawer.setAttribute('aria-label', 'Orbit menu');
  const head = el('header', 'orbit-menu-head');
  head.append(
    el('span', 'orbit-menu-mark', '◉'),
    el('strong', 'orbit-menu-title', 'orbit menu'),
    button('×', 'Close orbit menu', () => close(true), 'orbit-menu-close'),
  );
  const scroll = el('div', 'orbit-menu-scroll');
  const pin = button('', 'Move workspace controls between the orbit menu and the top toolbar', () => setPinned(!pinned), 'orbit-menu-pin');
  const hint = el('p', 'orbit-menu-hint', '');
  const foot = el('footer', 'orbit-menu-foot');
  foot.append(pin, hint);
  drawer.append(head, scroll, foot);

  const homes = new Map<string, HTMLElement>();
  const items: OrbitMenuItem[] = [];
  for (const section of options.sections()) {
    const node = el('section', 'orbit-menu-section');
    node.dataset.section = section.id;
    node.append(el('h3', '', section.title));
    if (section.detail) node.append(el('p', 'orbit-menu-detail', section.detail));
    const list = el('div', 'orbit-menu-items');
    for (const item of section.items) {
      const home = el('div', 'orbit-menu-item-slot');
      homes.set(item.id, home);
      item.button.dataset.icon = item.icon;
      item.button.classList.add('orbit-menu-item');
      home.append(item.button);
      list.append(home);
      items.push(item);
    }
    node.append(list);
    scroll.append(node);
  }

  let pinned = false;
  try { pinned = localStorage.getItem(pinnedKey) === 'true'; } catch {}

  function applyPinned() {
    toolbar.hidden = !pinned;
    for (const item of items) {
      const target = pinned ? toolbar : homes.get(item.id)!;
      if (item.button.parentElement !== target) target.append(item.button);
      item.button.classList.toggle('orbit-toolbar-item', pinned);
      item.button.classList.toggle('orbit-menu-item', !pinned);
      item.button.setAttribute('aria-label', item.button.getAttribute('aria-label') || item.label);
    }
    pin.textContent = pinned ? '⇲ Return controls to the orbit menu' : '⇱ Move controls to the top toolbar';
    hint.textContent = pinned
      ? 'These controls are pinned to the top toolbar as compact buttons. Press again to bring them back here.'
      : 'Move these controls onto the top toolbar for one-click access. You can always bring them back into this menu.';
    logo.setAttribute('aria-haspopup', 'true');
  }

  function setPinned(value: boolean) {
    pinned = value;
    try { localStorage.setItem(pinnedKey, String(pinned)); } catch {}
    applyPinned();
  }

  function setOpen(open: boolean) {
    drawer.hidden = !open;
    logo.setAttribute('aria-expanded', String(open));
    if (open) applyPinned();
  }
  function close(restore = false) { setOpen(false); if (restore) logo.focus(); }
  function open() { setOpen(true); }
  function toggle() { if (drawer.hidden) open(); else close(true); }

  document.addEventListener('pointerdown', event => {
    if (drawer.hidden) return;
    // Keep the menu available while a modal dialog is open.
    if (document.querySelector('dialog[open]')) return;
    const target = event.target as Node;
    if (!drawer.contains(target) && !logo.contains(target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || drawer.hidden) return;
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    close(true);
  });
  drawer.addEventListener('focusout', () => {
    setTimeout(() => {
      if (drawer.hidden) return;
      if (drawer.contains(document.activeElement) || logo === document.activeElement) return;
      if (document.querySelector('dialog[open]')) return;
      close();
    }, 0);
  });

  drawerHost.append(drawer);
  logo.setAttribute('aria-expanded', 'false');
  applyPinned();
  setOpen(false);

  return { open, close, toggle, refresh: applyPinned, isPinned: () => pinned, drawer };
}
