import { el, button } from './dom';
import type { WorkspaceCommands } from './workspace-commands';
import './command-palette.css';

export function installCommandPalette(commands: WorkspaceCommands) {
  let dialog: HTMLDialogElement | null = null;
  function open() {
    if (dialog?.open) return;
    if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
    const trigger = document.activeElement as HTMLElement | null;
    const modal = document.createElement('dialog');
    dialog = modal;
    modal.className = 'command-palette';
    modal.setAttribute('aria-label', 'Workspace commands');
    const search = el('input', 'command-palette-search');
    search.type = 'search';
    search.placeholder = 'Search commands and windows…';
    search.setAttribute('aria-label', 'Search workspace commands');
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-expanded', 'true');
    search.setAttribute('aria-controls', 'orbit-command-results');
    const results = el('div', 'command-palette-results');
    results.id = 'orbit-command-results';
    results.role = 'listbox';
    results.setAttribute('aria-label', 'Commands');
    const status = el('p', 'command-palette-status');
    status.role = 'status';
    let selected = 0;
    let matches = commands.list();
    const select = (index: number) => {
      selected = index;
      Array.from(results.children).forEach((item, i) => item.setAttribute('aria-selected', String(i === selected)));
      const active = results.children[selected] as HTMLElement | undefined;
      if (active) { search.setAttribute('aria-activedescendant', active.id); active.scrollIntoView({ block: 'nearest' }); }
      else search.removeAttribute('aria-activedescendant');
    };
    const execute = (index: number) => {
      const command = matches[index];
      if (!command || command.disabledReason) return;
      modal.close();
      void commands.execute(command.id);
    };
    const render = () => {
      matches = commands.list(search.value);
      results.replaceChildren();
      matches.forEach((command, index) => {
        const item = el('div', 'command-palette-item');
        item.id = `orbit-command-${index}`;
        item.role = 'option';
        item.setAttribute('aria-disabled', String(!!command.disabledReason));
        item.append(el('strong', '', command.title), el('small', '', `${command.group} · ${command.disabledReason ?? command.detail}`));
        item.addEventListener('pointermove', () => select(index));
        item.addEventListener('click', () => execute(index));
        results.append(item);
      });
      status.textContent = matches.length ? `${matches.length} commands · ↑↓ navigate · Enter open · Esc close` : 'No matching commands.';
      select(0);
    };
    search.addEventListener('input', render);
    const refreshDetails=()=>{const id=matches[selected]?.id;render();const index=matches.findIndex(command=>command.id===id);if(index>=0)select(index);};
    window.addEventListener('orbit-command-details-changed',refreshDetails);
    modal.addEventListener('close',()=>window.removeEventListener('orbit-command-details-changed',refreshDetails),{once:true});
    modal.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); modal.close(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (matches.length) select((selected + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
      } else if (event.key === 'Enter' && event.target === search) { event.preventDefault(); execute(selected); }
    });
    modal.addEventListener('close', () => { modal.remove(); dialog = null; if (trigger?.isConnected && !document.querySelector('dialog[open]')) trigger.focus(); }, { once: true });
    modal.append(el('h2', '', 'Workspace commands'), search, results, status, button('Close', 'Close workspace commands', () => modal.close()));
    document.body.append(modal);
    modal.showModal(); render(); search.focus();
    window.dispatchEvent(new Event('orbit-command-discovery'));
  }
  const shortcut = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable="true"], .xterm, iframe') || document.activeElement?.tagName === 'IFRAME') return;
    if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
    event.preventDefault(); open();
  };
  document.addEventListener('keydown', shortcut);
  return { open, dispose: () => { document.removeEventListener('keydown', shortcut); dialog?.close(); } };
}
